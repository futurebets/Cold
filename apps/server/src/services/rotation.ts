/** Rotate without stopping (SPEC §6.14, playbook rule 14). */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { CandidateDomain } from "@cold/core";
import { domainDailyCap, migrationFor, planRotation, rankReplacements, warmupDays, warmupStatus } from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, HttpError, notFound } from "../lib/http";
import type { Actor } from "./common";
import { audit, getPolicies, raiseAlert, resolveAlert, SYSTEM } from "./common";
import { getDomain, setState } from "./domains";
import { cancelScheduled } from "./sending";
import { sequence } from "./campaigns";

const { domains, mailboxes, rotations, diagnoses, enrollments, threads, provisioningOrders } = schema;
type DomainRow = typeof domains.$inferSelect;

async function candidatesFor(workspaceId: string): Promise<CandidateDomain[]> {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const reserve = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.pool, "reserve")));
  if (!reserve.length) return [];
  const mbs = await db
    .select()
    .from(mailboxes)
    .where(and(inArray(mailboxes.domainId, reserve.map((d) => d.id)), ne(mailboxes.state, "decommissioned")));
  const now = new Date();
  return reserve.map((d) => {
    const own = mbs.filter((m) => m.domainId === d.id);
    const days = own.length ? Math.min(...own.map((m) => warmupDays(m, now))) : 0;
    const healthy = own.every((m) => warmupStatus(m, policies, now).rateOk);
    return {
      id: d.id,
      name: d.name,
      provider: d.provider,
      state: d.state,
      pool: d.pool,
      authVerifiedAt: d.authVerifiedAt,
      warmupDays: days,
      warmupHealthy: healthy && own.length > 0,
      capacity: domainDailyCap(d.provider, own.length, policies, d.capOverride),
      readyInDays: Math.max(0, policies.warmup.minDays - days),
    };
  });
}

async function activeCapacity(workspaceId: string) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const ds = await db
    .select()
    .from(domains)
    .where(and(eq(domains.workspaceId, workspaceId), eq(domains.pool, "active"), inArray(domains.state, ["active", "flagged", "diagnosing"])));
  let total = 0;
  for (const d of ds) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mailboxes).where(and(eq(mailboxes.domainId, d.id), ne(mailboxes.state, "decommissioned")));
    total += domainDailyCap(d.provider, n, policies, d.capOverride);
  }
  return total;
}

async function capacityOf(d: DomainRow) {
  const policies = await getPolicies(d.workspaceId);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(mailboxes).where(and(eq(mailboxes.domainId, d.id), ne(mailboxes.state, "decommissioned")));
  return domainDailyCap(d.provider, n, policies, d.capOverride);
}

export async function planRotationFor(workspaceId: string, domainId: string, actor: Actor, diagnosisId?: string | null) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  if (!["active", "flagged", "diagnosing"].includes(d.state)) throw badRequest("Only active domains can be rotated out");
  const policies = await getPolicies(workspaceId);
  // DGN-1: diagnose before replacing. Hard evidence (blocklist) is the only exception.
  const [diag] = diagnosisId
    ? await db.select().from(diagnoses).where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.domainId, d.id)))
    : await db.select().from(diagnoses).where(and(eq(diagnoses.domainId, d.id), eq(diagnoses.status, "decided"))).orderBy(desc(diagnoses.openedAt)).limit(1);
  if (!d.blocklisted && (!diag || diag.verdict !== "INFRA"))
    throw new HttpError(409, "Diagnose before replacing: rotation needs a diagnosis with an INFRA verdict (control and campaign copy both failing).", { rule: 13 });

  const [existing] = await db.select().from(rotations).where(and(eq(rotations.outgoingDomainId, d.id), eq(rotations.status, "planned")));
  if (existing) return existing;
  const plan = planRotation({ name: d.name, provider: d.provider, capacity: await capacityOf(d) }, await candidatesFor(workspaceId), await activeCapacity(workspaceId), policies);
  const [rot] = await db
    .insert(rotations)
    .values({
      workspaceId,
      outgoingDomainId: d.id,
      replacementDomainId: plan.replacement?.id ?? plan.nextUp?.id ?? null,
      diagnosisId: diag?.id ?? null,
      mode: plan.mode,
      plan: plan as unknown as Record<string, unknown>,
      capacityBefore: plan.capacityBefore,
      capacityAfter: plan.capacityAfter,
    })
    .returning();
  await audit(workspaceId, actor, "rotation.planned", { type: "domain", id: d.id }, { mode: plan.mode, replacement: plan.replacement?.name ?? plan.nextUp?.name ?? null });
  if (policies.rotation.approval === "auto") return executeRotation(workspaceId, rot.id, SYSTEM);
  await raiseAlert(workspaceId, {
    severity: "critical",
    kind: "rotation_ready",
    key: `rotation:${rot.id}`,
    title: plan.mode === "immediate" ? `Approve rotation: ${d.name} → ${plan.replacement?.name}` : `Approve rotation: ${d.name} → Layover (no warmed replacement ready)`,
    body: plan.steps.join("\n"),
    entity: { type: "rotation", id: rot.id },
    action: { label: "Review rotation", href: `/rotations/${rot.id}` },
  });
  return rot;
}

/** Promote a ready reserve domain into the outgoing domain's place (make-before-break). */
async function promote(replacement: DomainRow, outgoing: DomainRow, actor: Actor) {
  const db = getDb();
  await db.update(domains).set({ pool: "active", poolId: outgoing.poolId, billingStatus: "active" }).where(eq(domains.id, replacement.id));
  const fresh = await getDomain(replacement.workspaceId, replacement.id);
  await setState(fresh, "active", actor, `Promoted to replace ${outgoing.name}`);
  if (replacement.vendor === "hypertide")
    await raiseAlert(replacement.workspaceId, {
      severity: "info",
      kind: "vendor_task",
      key: `vendor:promote:${replacement.id}`,
      title: `Hypertide: move ${replacement.name} out of the Recovery Pool`,
      body: "Cold has promoted this domain to active sending. Mirror the change in Hypertide so billing matches.",
      entity: { type: "domain", id: replacement.id },
      notify: false,
    });
}

/** Move in-flight sequences off the outgoing mailboxes (ROT-4). */
async function migrate(outgoing: DomainRow, replacement: DomainRow | null, cooldownDays: number) {
  const db = getDb();
  const outMbs = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domainId, outgoing.id));
  const outIds = outMbs.map((m) => m.id);
  if (!outIds.length) return { migrated: 0, ended: 0, threadsKept: 0 };
  const repMbs = replacement ? await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.domainId, replacement.id), ne(mailboxes.state, "decommissioned"))) : [];
  // First touches claimed by outgoing mailboxes go back to the pool.
  await db.update(enrollments).set({ mailboxId: null }).where(and(inArray(enrollments.mailboxId, outIds), eq(enrollments.nextStep, 0), eq(enrollments.status, "active")));
  const inflight = await db
    .select()
    .from(enrollments)
    .where(and(inArray(enrollments.mailboxId, outIds), eq(enrollments.status, "active"), sql`${enrollments.nextStep} > 0`));
  let migrated = 0;
  let ended = 0;
  const seqCache = new Map<string, Awaited<ReturnType<typeof sequence>>>();
  for (const [i, e] of inflight.entries()) {
    if (!seqCache.has(e.campaignId)) seqCache.set(e.campaignId, await sequence(e.campaignId));
    const seq = seqCache.get(e.campaignId)!;
    const next = seq[e.nextStep];
    const action = migrationFor({
      status: e.status,
      hasReply: false,
      hasNextStep: !!next,
      standaloneAvailable: !!next?.variants.some((v) => v.active && v.standaloneBody?.trim()) && repMbs.length > 0,
    });
    if (action === "move_standalone") {
      await db.update(enrollments).set({ mailboxId: repMbs[i % repMbs.length].id, standaloneNext: true, threadId: null, lastMessageId: null, references: null, providerThreadId: null }).where(eq(enrollments.id, e.id));
      migrated++;
    } else if (action === "end_sequence") {
      await db.update(enrollments).set({ status: "interrupted", reenrollAfter: new Date(Date.now() + cooldownDays * 86_400_000) }).where(eq(enrollments.id, e.id));
      ended++;
    }
  }
  const [{ n: threadsKept }] = await db.select({ n: sql<number>`count(*)::int` }).from(threads).where(inArray(threads.mailboxId, outIds));
  return { migrated, ended, threadsKept };
}

export async function executeRotation(workspaceId: string, rotationId: string, actor: Actor) {
  const db = getDb();
  const [rot] = await db.select().from(rotations).where(and(eq(rotations.workspaceId, workspaceId), eq(rotations.id, rotationId)));
  if (!rot) throw notFound("Rotation not found");
  if (rot.status !== "planned") throw badRequest("This rotation was already executed or cancelled");
  const policies = await getPolicies(workspaceId);
  const outgoing = await getDomain(workspaceId, rot.outgoingDomainId);
  const now = new Date();

  // Re-check: the best candidate may have changed since planning.
  const ranked = rankReplacements({ provider: outgoing.provider, capacity: await capacityOf(outgoing) }, await candidatesFor(workspaceId), policies, now);
  const ready = ranked.find((c) => c.eligible);
  let result: { migrated: number; ended: number; threadsKept: number };
  if (ready) {
    const replacement = await getDomain(workspaceId, ready.id);
    await promote(replacement, outgoing, actor); // make before break (ROT-1)
    await cancelScheduled(outgoing.id, "ROTATED");
    result = await migrate(outgoing, replacement, policies.rotation.reenrollCooldownDays);
    await db
      .update(domains)
      .set({ pool: "retired", billingStatus: "relay", relayEndsAt: new Date(now.getTime() + policies.rotation.relayDays * 86_400_000), retireReason: "Rotated out (INFRA verdict)" })
      .where(eq(domains.id, outgoing.id));
    await setState(outgoing, "relay", actor, `Replaced by ${replacement.name}`);
    await db
      .update(rotations)
      .set({ status: "executed", mode: "immediate", replacementDomainId: replacement.id, approvedBy: actor.label, executedAt: now, relayEndsAt: new Date(now.getTime() + policies.rotation.relayDays * 86_400_000), migratedCount: result.migrated, endedCount: result.ended, threadsKept: result.threadsKept })
      .where(eq(rotations.id, rot.id));
  } else {
    // Layover: keep follow-ups and replies flowing while a replacement finishes warming (ROT-5).
    await cancelScheduled(outgoing.id, "ROTATED", ["first_touch"]);
    await db.update(enrollments).set({ mailboxId: null }).where(and(inArray(enrollments.mailboxId, db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domainId, outgoing.id))), eq(enrollments.nextStep, 0)));
    const layoverEndsAt = new Date(now.getTime() + policies.rotation.layoverDays * 86_400_000);
    await db.update(domains).set({ pool: "retired", billingStatus: "layover", layoverEndsAt }).where(eq(domains.id, outgoing.id));
    await setState(outgoing, "layover", actor, "No warmed replacement ready: Layover");
    const next = ranked.find((c) => c.provider === outgoing.provider && c.state === "warming");
    await db
      .update(rotations)
      .set({ status: "executed", mode: "layover", replacementDomainId: next?.id ?? null, approvedBy: actor.label, executedAt: now, layoverEndsAt })
      .where(eq(rotations.id, rot.id));
    result = { migrated: 0, ended: 0, threadsKept: 0 };
  }

  if (outgoing.vendor === "hypertide")
    await raiseAlert(workspaceId, {
      severity: "info",
      kind: "vendor_task",
      key: `vendor:relay:${outgoing.id}`,
      title: ready ? `Hypertide: enable Relay on ${outgoing.name}` : `Hypertide: start the ${policies.rotation.layoverDays}-day Layover for ${outgoing.name}`,
      body: "Cold has switched this domain's state. Mirror it in Hypertide so replies keep arriving and billing matches.",
      entity: { type: "domain", id: outgoing.id },
      notify: false,
    });

  // RSV-4 / ROT-8: replenish the reserve.
  if (policies.reserve.autoReplenish === "draft") {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mailboxes).where(eq(mailboxes.domainId, outgoing.id));
    await db.insert(provisioningOrders).values({ workspaceId, provider: outgoing.provider, domainCount: 1, mailboxesPerDomain: Math.max(1, n), targetPool: "reserve", reason: `Replace ${outgoing.name} (rotated out)` });
  }
  if (rot.diagnosisId) {
    await db.update(diagnoses).set({ status: "closed", closedAt: now }).where(eq(diagnoses.id, rot.diagnosisId));
    await resolveAlert(workspaceId, `diagnosis:${rot.diagnosisId}`);
  }
  await resolveAlert(workspaceId, `rotation:${rot.id}`);
  await resolveAlert(workspaceId, `health:${outgoing.id}`);
  await audit(workspaceId, actor, "rotation.executed", { type: "rotation", id: rot.id }, { outgoing: outgoing.name, replacement: ready?.name ?? null, ...result });
  await raiseAlert(workspaceId, {
    severity: "info",
    kind: "rotation_done",
    key: `rotation_done:${rot.id}`,
    title: ready ? `Rotated ${outgoing.name} → ${ready.name} without stopping` : `${outgoing.name} is in Layover`,
    body: ready
      ? `${result.migrated} sequences moved, ${result.ended} ended for later re-enrollment, ${result.threadsKept} conversations kept in Relay.`
      : "Follow-ups and replies continue. New first emails go to your other active domains until a replacement is ready.",
    notify: true,
  });
  return (await db.select().from(rotations).where(eq(rotations.id, rot.id)))[0];
}

export async function cancelRotation(workspaceId: string, rotationId: string, actor: Actor) {
  const db = getDb();
  const [rot] = await db.select().from(rotations).where(and(eq(rotations.workspaceId, workspaceId), eq(rotations.id, rotationId)));
  if (!rot || rot.status !== "planned") throw badRequest("Only planned rotations can be cancelled");
  await db.update(rotations).set({ status: "cancelled" }).where(eq(rotations.id, rot.id));
  await resolveAlert(workspaceId, `rotation:${rot.id}`);
  await audit(workspaceId, actor, "rotation.cancelled", { type: "rotation", id: rot.id });
}

/** Lifecycle: finish layovers and relays (ROT-5, ROT-6). */
export async function advanceRotations(workspaceId: string, now = new Date()) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const layovers = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.state, "layover")));
  for (const out of layovers) {
    const ranked = rankReplacements({ provider: out.provider, capacity: await capacityOf(out) }, await candidatesFor(workspaceId), policies, now);
    const ready = ranked.find((c) => c.eligible);
    const expired = out.layoverEndsAt && out.layoverEndsAt <= now;
    if (!ready && !expired) continue;
    if (ready) await promote(await getDomain(workspaceId, ready.id), out, SYSTEM);
    await cancelScheduled(out.id, "ROTATED");
    const res = await migrate(out, ready ? await getDomain(workspaceId, ready.id) : null, policies.rotation.reenrollCooldownDays);
    const relayEndsAt = new Date(now.getTime() + policies.rotation.relayDays * 86_400_000);
    await db.update(domains).set({ billingStatus: "relay", relayEndsAt }).where(eq(domains.id, out.id));
    await setState(out, "relay", SYSTEM, ready ? `Layover ended: ${ready.name} is ready` : "Layover period ended");
    await db
      .update(rotations)
      .set({ replacementDomainId: ready?.id ?? null, relayEndsAt, migratedCount: res.migrated, endedCount: res.ended, threadsKept: res.threadsKept })
      .where(and(eq(rotations.outgoingDomainId, out.id), eq(rotations.status, "executed")));
    await raiseAlert(workspaceId, {
      severity: ready ? "info" : "warning",
      kind: "layover_done",
      key: `layover_done:${out.id}`,
      title: ready ? `${ready.name} replaced ${out.name} after Layover` : `${out.name}'s Layover ended with no replacement ready`,
      body: ready ? "Sending capacity is restored." : "Capacity stays reduced until a reserve domain finishes warmup. Order more reserve domains.",
    });
  }
  const relays = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.state, "relay")));
  for (const d of relays) {
    if (!d.relayEndsAt || d.relayEndsAt > now) continue;
    await setState(d, "retired", SYSTEM, "Relay period ended. Conversations stay in Cold.");
    await db.update(rotations).set({ status: "completed" }).where(and(eq(rotations.outgoingDomainId, d.id), eq(rotations.status, "executed")));
  }
}

export async function listRotations(workspaceId: string) {
  const db = getDb();
  const rows = await db.select().from(rotations).where(eq(rotations.workspaceId, workspaceId)).orderBy(desc(rotations.createdAt)).limit(200);
  const ids = [...new Set(rows.flatMap((r) => [r.outgoingDomainId, r.replacementDomainId].filter(Boolean) as string[]))];
  const names = ids.length ? await db.select({ id: domains.id, name: domains.name, state: domains.state }).from(domains).where(inArray(domains.id, ids)) : [];
  const nm = new Map(names.map((n) => [n.id, n]));
  return rows.map((r) => ({ ...r, outgoing: nm.get(r.outgoingDomainId) ?? null, replacement: r.replacementDomainId ? nm.get(r.replacementDomainId) ?? null : null }));
}

export async function rotationDetail(workspaceId: string, id: string) {
  const all = await listRotations(workspaceId);
  const r = all.find((x) => x.id === id);
  if (!r) throw notFound("Rotation not found");
  return r;
}
