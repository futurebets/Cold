/** Diagnose before replacing (SPEC §6.13, playbook rule 13). */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { BounceCategory, DiagnosisVerdict, Folder } from "@cold/core";
import { bounceComposition, composeBody, decide, DEFAULT_CONTROL_MESSAGES, localDate, mailboxDailyCap, renderTemplate, seededRandom, summarizePlacement } from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, notFound } from "../lib/http";
import { newMessageId } from "../lib/mime";
import { checkBlocklist } from "../adapters/external";
import { transportFor } from "../adapters/transport";
import type { Actor } from "./common";
import { audit, getPolicies, getSecret, getWorkspace, loadTenant, mailboxCtx, raiseAlert, resolveAlert, SYSTEM } from "./common";
import { checkDns, domainMailboxes, getDomain, isSimulatedDomain, setState } from "./domains";
import { cancelScheduled } from "./sending";
import { mergeVars, sequence } from "./campaigns";

const { diagnoses, domains, sends, mailboxes, controlMessages, campaigns, variants, enrollments, prospects, capCounters } = schema;
type DiagnosisRow = typeof diagnoses.$inferSelect;

export async function getDiagnosis(workspaceId: string, id: string) {
  const [d] = await getDb().select().from(diagnoses).where(and(eq(diagnoses.workspaceId, workspaceId), eq(diagnoses.id, id)));
  if (!d) throw notFound("Diagnosis not found");
  return d;
}

export async function openDiagnosis(workspaceId: string, domainId: string, trigger: DiagnosisRow["trigger"], actor: Actor, campaignId?: string | null) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(diagnoses)
    .where(and(eq(diagnoses.domainId, domainId), inArray(diagnoses.status, ["open", "testing", "decided"])));
  if (existing) return existing;
  const d = await getDomain(workspaceId, domainId);
  if (d.state === "active") {
    await setState(d, "flagged", actor, `Diagnosis opened (${trigger})`);
    await cancelScheduled(d.id, "DOMAIN_NOT_SENDING");
  }

  // Pre-checks (DGN-2)
  let authOk = false;
  let authDetail: string[] = [];
  try {
    const dns = await checkDns(workspaceId, domainId, actor);
    authOk = dns.pass;
    authDetail = dns.items.filter((i) => !i.pass).map((i) => `${i.label}: ${i.detail}`);
  } catch (e: any) {
    authDetail = [String(e?.message ?? e)];
  }
  const simulated = await isSimulatedDomain(d);
  const bl = simulated ? { checked: true, listed: d.blocklisted, detail: d.blocklisted ? "Listed (simulated)" : "Not listed (simulated)" } : await checkBlocklist(d.name, await getSecret(workspaceId, "spamhaus.dqsKey"));
  const recent = await db
    .select({ category: sends.bounceCategory, campaignId: sends.campaignId, prospectId: sends.prospectId })
    .from(sends)
    .where(and(eq(sends.domainId, domainId), eq(sends.status, "sent"), inArray(sends.kind, ["first_touch", "follow_up"])))
    .orderBy(desc(sends.sentAt))
    .limit(1000);
  const bounces = bounceComposition(recent.filter((r) => r.category).map((r) => r.category as BounceCategory));
  const campaignCounts = new Map<string, number>();
  for (const r of recent) if (r.campaignId) campaignCounts.set(r.campaignId, (campaignCounts.get(r.campaignId) ?? 0) + 1);
  const mainCampaign = campaignId ?? [...campaignCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const prechecks = { authOk, authDetail, blocklist: bl, bounces, recentSends: recent.length };
  const [diag] = await db.insert(diagnoses).values({ workspaceId, domainId, campaignId: mainCampaign, trigger, prechecks }).returning();

  if (!authOk || bl.listed) {
    const decision = decide({ authOk, blocklisted: bl.listed, control: null, campaign: null, bounces });
    await recordDecision(diag, decision, actor);
  }
  await audit(workspaceId, actor, "diagnosis.opened", { type: "domain", id: domainId }, { trigger, diagnosisId: diag.id });
  return getDiagnosis(workspaceId, diag.id);
}

async function recordDecision(diag: DiagnosisRow, decision: ReturnType<typeof decide>, actor: Actor) {
  await getDb()
    .update(diagnoses)
    .set({ status: "decided", verdict: decision.verdict, action: decision.action, headline: decision.headline, explanation: decision.explanation, decidedBy: actor.label })
    .where(eq(diagnoses.id, diag.id));
  const d = (await getDb().select().from(domains).where(eq(domains.id, diag.domainId)))[0];
  await raiseAlert(diag.workspaceId, {
    severity: decision.verdict === "INFRA" ? "critical" : "warning",
    kind: "diagnosis",
    key: `diagnosis:${diag.id}`,
    title: `${d?.name}: ${decision.headline}`,
    body: decision.explanation,
    entity: { type: "diagnosis", id: diag.id },
    action: { label: "Review", href: `/diagnoses/${diag.id}` },
  });
}

async function seeds(workspaceId: string) {
  return getDb()
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.isSeed, true), eq(mailboxes.connection, "connected")));
}

/** DGN-3: send control and campaign copy from the same inboxes to the seed panel. */
export async function startControlTest(workspaceId: string, diagnosisId: string, actor: Actor) {
  const db = getDb();
  const diag = await getDiagnosis(workspaceId, diagnosisId);
  if (!["open", "decided"].includes(diag.status) || (diag.status === "decided" && diag.verdict !== "INCONCLUSIVE")) throw badRequest("This diagnosis already has a verdict");
  const d = await getDomain(workspaceId, diag.domainId);
  const seedList = await seeds(workspaceId);
  if (seedList.length < 2) throw badRequest("Connect at least 2 seed inboxes (e.g. one Gmail, one Outlook) in Mailboxes, or enter results from your placement tool manually.");
  const mbs = (await domainMailboxes(d.id)).filter((m) => m.connection === "connected");
  if (!mbs.length) throw badRequest("No connected mailbox on this domain");

  const ws = await getWorkspace(workspaceId);
  const [ctrl] = await db.select().from(controlMessages).where(eq(controlMessages.workspaceId, workspaceId)).limit(1);
  const control = ctrl ?? DEFAULT_CONTROL_MESSAGES[0];

  let campSubject = "quick question";
  let campBody = "";
  if (diag.campaignId) {
    const seq = await sequence(diag.campaignId);
    const v = seq[0]?.variants.find((x) => x.active) ?? seq[0]?.variants[0];
    const [sample] = await db
      .select({ p: prospects })
      .from(enrollments)
      .innerJoin(prospects, eq(enrollments.prospectId, prospects.id))
      .where(eq(enrollments.campaignId, diag.campaignId))
      .limit(1);
    if (v) {
      const vars = sample ? mergeVars(sample.p, mbs[0], ws.name) : { firstName: "Alex", company: "Northwind" };
      const rand = seededRandom(diag.id);
      campSubject = renderTemplate(v.subject, vars, rand).text;
      campBody = renderTemplate(v.body, vars, rand).text;
    }
  }
  if (!campBody) throw badRequest("No campaign copy to test. This domain has no campaign attached.");

  const now = Date.now();
  // Real seeds: space sends ~5 minutes apart so the test looks like normal traffic. Simulated: seconds.
  const spacingMs = (await isSimulatedDomain(d)) ? 5_000 : 5 * 60_000;
  const policies = await getPolicies(workspaceId);

  // Seed sends count toward caps (CAP-3), so plan pairs within each inbox's remaining capacity:
  // every pair is control + campaign copy from the SAME inbox to the SAME seed (rule 13).
  const remaining = new Map<string, number>();
  for (const m of mbs) {
    const date = localDate(new Date(now), m.timezone);
    const [c] = await db.select({ count: capCounters.count }).from(capCounters).where(and(eq(capCounters.scope, "mailbox"), eq(capCounters.scopeId, m.id), eq(capCounters.localDate, date)));
    remaining.set(m.id, mailboxDailyCap(d.provider, policies, m.capOverride) - (c?.count ?? 0));
  }
  const pairs: { mb: (typeof mbs)[number]; seed: (typeof seedList)[number] }[] = [];
  const rounds = Math.min(3, Math.max(1, Math.floor(mbs.length / seedList.length)) || 1);
  let cursor = 0;
  for (let round = 0; round < rounds; round++) {
    for (const seed of seedList) {
      for (let tries = 0; tries < mbs.length; tries++) {
        const mb = mbs[cursor++ % mbs.length];
        if ((remaining.get(mb.id) ?? 0) >= 2) {
          remaining.set(mb.id, remaining.get(mb.id)! - 2);
          pairs.push({ mb, seed });
          break;
        }
      }
    }
  }
  if (pairs.length < 2)
    throw badRequest("Not enough sending capacity left today on this domain's inboxes for a control test (each pair uses 2 of an inbox's daily sends). Try tomorrow, or record a result from your placement tool.");

  const rows: (typeof sends.$inferInsert)[] = [];
  let i = 0;
  for (const { mb, seed } of pairs) {
    for (const arm of (["control", "campaign"] as const).slice().sort(() => Math.random() - 0.5)) {
      const subject = arm === "control" ? control.subject : campSubject;
      const body = composeBody(arm === "control" ? control.body : campBody, mb.signature, null);
      rows.push({
        workspaceId,
        kind: "seed",
        mailboxId: mb.id,
        domainId: d.id,
        diagnosisId: diag.id,
        arm,
        toAddress: seed.address,
        scheduledAt: new Date(now + i * spacingMs * (0.6 + Math.random() * 0.8)),
        localDate: localDate(new Date(now), mb.timezone),
        subject,
        body,
        rfcMessageId: newMessageId(d.name),
      });
      i++;
    }
  }
  await db.insert(sends).values(rows);
  if (d.state !== "diagnosing") await setState(d, "diagnosing", actor, "Control test running");
  await db
    .update(diagnoses)
    .set({ status: "testing", testStartedAt: new Date(), attempt: diag.status === "decided" ? diag.attempt + 1 : diag.attempt, verdict: null, action: null, headline: null, explanation: null })
    .where(eq(diagnoses.id, diag.id));
  await audit(workspaceId, actor, "diagnosis.test_started", { type: "diagnosis", id: diag.id }, { seedSends: rows.length });
  return { queued: rows.length };
}

/** Lifecycle step: read placements from seed inboxes and decide (DGN-4/5). */
export async function readControlTests(workspaceId: string, now = new Date()) {
  const db = getDb();
  const open = await db.select().from(diagnoses).where(and(eq(diagnoses.workspaceId, workspaceId), eq(diagnoses.status, "testing")));
  for (const diag of open) {
    const rows = await db.select().from(sends).where(and(eq(sends.diagnosisId, diag.id), eq(sends.kind, "seed")));
    const seedByAddr = new Map((await seeds(workspaceId)).map((s) => [s.address, s]));
    let pending = 0;
    for (const s of rows) {
      if (s.placement) continue;
      if (s.status === "scheduled" || s.status === "sending") {
        pending++;
        continue;
      }
      if (s.status !== "sent") {
        await db.update(sends).set({ placement: "missing" }).where(eq(sends.id, s.id));
        continue;
      }
      const age = now.getTime() - (s.sentAt?.getTime() ?? now.getTime());
      const seed = seedByAddr.get(s.toAddress);
      const seedTenant = seed ? await loadTenant(seed.tenantId) : null;
      const simulatedSeed = seedTenant?.transport === "simulated";
      if (age < 2 * 60_000 && !simulatedSeed) {
        pending++;
        continue;
      }
      if (!seed) {
        await db.update(sends).set({ placement: "missing" }).where(eq(sends.id, s.id));
        continue;
      }
      const sd = seed.domainId ? (await db.select().from(domains).where(eq(domains.id, seed.domainId)))[0] : null;
      const ctx = await mailboxCtx(seed, sd?.name ?? seed.address.split("@")[1], await loadTenant(seed.tenantId ?? sd?.tenantId ?? null));
      let folder: Folder = "missing";
      try {
        folder = await transportFor(ctx.tenant).locate(ctx, s.rfcMessageId!);
      } catch {
        folder = "missing";
      }
      if (folder === "missing" && age < 4 * 3_600_000 && !simulatedSeed) {
        pending++;
        continue;
      }
      await db.update(sends).set({ placement: folder }).where(eq(sends.id, s.id));
    }
    if (pending > 0) continue;
    const fresh = await db.select().from(sends).where(and(eq(sends.diagnosisId, diag.id), eq(sends.kind, "seed"), isNotNull(sends.placement)));
    await finishTest(diag, fresh.filter((s) => s.arm === "control").map((s) => s.placement as Folder), fresh.filter((s) => s.arm === "campaign").map((s) => s.placement as Folder), SYSTEM);
  }
}

async function finishTest(diag: DiagnosisRow, controlFolders: Folder[], campaignFolders: Folder[], actor: Actor) {
  const db = getDb();
  const policies = await getPolicies(diag.workspaceId);
  const control = summarizePlacement(controlFolders, policies);
  const campaign = summarizePlacement(campaignFolders, policies);
  await db.update(diagnoses).set({ controlResult: { ...control }, campaignResult: { ...campaign } }).where(eq(diagnoses.id, diag.id));
  const pre = diag.prechecks as any;
  const decision = decide({ authOk: pre.authOk !== false, control: control.pass, campaign: campaign.pass, bounces: pre.bounces, attempt: diag.attempt });
  if (decision.action === "retest" && diag.attempt < 2) {
    await db.update(diagnoses).set({ status: "decided", verdict: "INCONCLUSIVE" }).where(eq(diagnoses.id, diag.id));
    await startControlTest(diag.workspaceId, diag.id, actor).catch(() => undefined);
    return;
  }
  await recordDecision({ ...diag }, decision, actor);
}

/** Enter placement results from an external tool (GlockApps, etc.) or a manual seed check. */
export async function manualResult(workspaceId: string, diagnosisId: string, actor: Actor, controlPass: boolean, campaignPass: boolean) {
  const diag = await getDiagnosis(workspaceId, diagnosisId);
  if (diag.status === "closed") throw badRequest("Diagnosis is closed");
  const pre = diag.prechecks as any;
  const decision = decide({ authOk: pre.authOk !== false, control: controlPass, campaign: campaignPass, bounces: pre.bounces, attempt: 2 });
  await getDb()
    .update(diagnoses)
    .set({ controlResult: { pass: controlPass, manual: true }, campaignResult: { pass: campaignPass, manual: true } })
    .where(eq(diagnoses.id, diag.id));
  await recordDecision(diag, decision, actor);
  await audit(workspaceId, actor, "diagnosis.manual_result", { type: "diagnosis", id: diag.id }, { controlPass, campaignPass, verdict: decision.verdict });
  return getDiagnosis(workspaceId, diagnosisId);
}

export async function overrideVerdict(workspaceId: string, diagnosisId: string, actor: Actor, verdict: DiagnosisVerdict, reason: string) {
  if (!reason?.trim()) throw badRequest("A reason is required to override a verdict");
  const diag = await getDiagnosis(workspaceId, diagnosisId);
  const table: Record<DiagnosisVerdict, string> = { COPY: "rewrite_copy", INFRA: "rotate", LIST: "fix_list", OFFER: "review_offer", AUTH: "fix_auth", INCONCLUSIVE: "operator_decides" };
  await getDb()
    .update(diagnoses)
    .set({ status: "decided", verdict, action: table[verdict], headline: `Verdict set to ${verdict} by ${actor.label}`, explanation: reason, overrideReason: reason, decidedBy: actor.label })
    .where(eq(diagnoses.id, diag.id));
  await audit(workspaceId, actor, "diagnosis.override", { type: "diagnosis", id: diag.id }, { verdict }, reason);
  return getDiagnosis(workspaceId, diagnosisId);
}

export async function resumeDomain(workspaceId: string, domainId: string, actor: Actor, reason: string) {
  const d = await getDomain(workspaceId, domainId);
  await getDb().update(domains).set({ lastResumeAt: new Date(), healthVerdict: "insufficient_data" }).where(eq(domains.id, d.id));
  await setState(d, "active", actor, reason);
  await resolveAlert(workspaceId, `health:${d.id}`);
}

export async function closeDiagnosis(diag: DiagnosisRow) {
  await getDb().update(diagnoses).set({ status: "closed", closedAt: new Date() }).where(eq(diagnoses.id, diag.id));
  await resolveAlert(diag.workspaceId, `diagnosis:${diag.id}`);
}

/** Apply the recommended action for a decided diagnosis. INFRA hands off to rotation. */
export async function applyDiagnosis(workspaceId: string, diagnosisId: string, actor: Actor) {
  const db = getDb();
  const diag = await getDiagnosis(workspaceId, diagnosisId);
  if (diag.status !== "decided" || !diag.verdict) throw badRequest("Run the control test (or enter results) first");
  const d = await getDomain(workspaceId, diag.domainId);
  switch (diag.verdict) {
    case "COPY": {
      if (diag.campaignId) {
        const seq = await sequence(diag.campaignId);
        const ids = seq[0]?.variants.filter((v) => v.active).map((v) => v.id) ?? [];
        if (ids.length) await db.update(variants).set({ active: false, pausedReason: "Failed placement in a diagnosis control test. Rewrite before resuming." }).where(inArray(variants.id, ids));
        await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, diag.campaignId));
      }
      await resumeDomain(workspaceId, d.id, actor, "Diagnosis verdict COPY: infrastructure is fine");
      await closeDiagnosis(diag);
      return { result: "Campaign paused and failing copy disabled. Rewrite it, then relaunch. The domain is back in service." };
    }
    case "LIST":
    case "OFFER": {
      await resumeDomain(workspaceId, d.id, actor, `Diagnosis verdict ${diag.verdict}: placement fine`);
      await closeDiagnosis(diag);
      return { result: diag.verdict === "LIST" ? "Domain resumed. Re-validate or replace the list before sending more to it." : "Domain resumed. Review the targeting and the offer." };
    }
    case "AUTH": {
      await db.update(domains).set({ previousState: "active" }).where(eq(domains.id, d.id));
      await setState(d, "auth_failed", actor, "Diagnosis verdict AUTH");
      await closeDiagnosis(diag);
      return { result: "Domain held until DNS passes again. It resumes automatically once SPF, DKIM and DMARC pass." };
    }
    case "INFRA": {
      const { planRotationFor } = await import("./rotation");
      const rot = await planRotationFor(workspaceId, d.id, actor, diag.id);
      return { result: "Rotation planned.", rotationId: rot.id };
    }
    default:
      throw badRequest("Inconclusive. Override the verdict with your call first.");
  }
}

export async function listDiagnoses(workspaceId: string) {
  const db = getDb();
  return db
    .select({ diagnosis: diagnoses, domain: { name: domains.name, provider: domains.provider, state: domains.state } })
    .from(diagnoses)
    .innerJoin(domains, eq(diagnoses.domainId, domains.id))
    .where(eq(diagnoses.workspaceId, workspaceId))
    .orderBy(desc(diagnoses.openedAt))
    .limit(200);
}

export async function diagnosisDetail(workspaceId: string, id: string) {
  const db = getDb();
  const diag = await getDiagnosis(workspaceId, id);
  const d = await getDomain(workspaceId, diag.domainId);
  const seedSends = await db
    .select({ id: sends.id, arm: sends.arm, to: sends.toAddress, from: mailboxes.address, status: sends.status, placement: sends.placement, sentAt: sends.sentAt })
    .from(sends)
    .innerJoin(mailboxes, eq(sends.mailboxId, mailboxes.id))
    .where(and(eq(sends.diagnosisId, id), eq(sends.kind, "seed")));
  const campaign = diag.campaignId ? (await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, diag.campaignId)))[0] ?? null : null;
  const seedCount = (await seeds(workspaceId)).length;
  const [{ n: spamBlocks }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(eq(sends.domainId, d.id), eq(sends.bounceCategory, "policy_or_spam_block")));
  return { diagnosis: diag, domain: d, seedSends, campaign, seedCount, spamBlocks };
}
