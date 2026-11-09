/** Health evaluation, baselines, verdicts and circuit breakers (SPEC §6.12, playbook rule 12). */
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Baseline } from "@cold/core";
import { cohortBaseline, evaluateHealth, ownBaseline, pct } from "@cold/core";
import { getDb, schema } from "../db/client";
import { getPolicies, raiseAlert, resolveAlert, SYSTEM } from "./common";
import { setState } from "./domains";
import { cancelScheduled } from "./sending";
import { openDiagnosis } from "./diagnosis";

const { domains, sends, healthWindows, listImports, enrollments, prospects, campaigns } = schema;
type DomainRow = typeof domains.$inferSelect;

async function domainSends(d: DomainRow, now: Date, lookbackDays: number, maturityHours: number, limit: number) {
  const since = d.lastResumeAt ?? d.activatedAt;
  return getDb()
    .select({ sentAt: sends.sentAt, bounceType: sends.bounceType, replyKind: sends.replyKind })
    .from(sends)
    .where(
      and(
        eq(sends.domainId, d.id),
        eq(sends.status, "sent"),
        inArray(sends.kind, ["first_touch", "follow_up"]),
        gte(sends.sentAt, new Date(now.getTime() - lookbackDays * 86_400_000)),
        lte(sends.sentAt, new Date(now.getTime() - maturityHours * 3_600_000)),
        ...(since ? [gte(sends.sentAt, since)] : []),
      ),
    )
    .orderBy(desc(sends.sentAt))
    .limit(limit);
}

export async function latestWindows(workspaceId: string) {
  const db = getDb();
  return db
    .selectDistinctOn([healthWindows.scopeId], {
      scopeId: healthWindows.scopeId,
      verdict: healthWindows.verdict,
      replyRate: healthWindows.replyRate,
      bounceRate: healthWindows.bounceRate,
      sends: healthWindows.sends,
      baselineReplyRate: healthWindows.baselineReplyRate,
      baselineBounceRate: healthWindows.baselineBounceRate,
      baselineSource: healthWindows.baselineSource,
      reasons: healthWindows.reasons,
      evaluatedAt: healthWindows.evaluatedAt,
    })
    .from(healthWindows)
    .where(and(eq(healthWindows.workspaceId, workspaceId), eq(healthWindows.scopeType, "domain")))
    .orderBy(healthWindows.scopeId, desc(healthWindows.evaluatedAt));
}

export async function evaluateWorkspaceHealth(workspaceId: string, now = new Date()) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const h = policies.health;
  const ds = await db
    .select()
    .from(domains)
    .where(and(eq(domains.workspaceId, workspaceId), inArray(domains.state, ["active", "flagged", "diagnosing"])));
  const latest = await latestWindows(workspaceId);
  const peerRates = (provider: string, excludeId: string) =>
    latest.filter((w) => w.verdict === "green" && w.scopeId !== excludeId && ds.find((d) => d.id === w.scopeId)?.provider === provider).map((w) => ({ replyRate: w.replyRate, bounceRate: w.bounceRate }));

  const results: { domain: string; verdict: string }[] = [];
  for (const d of ds) {
    const rows = await domainSends(d, now, h.maxLookbackDays, h.maturityHours, h.minSample);
    const history = await db
      .select()
      .from(healthWindows)
      .where(and(eq(healthWindows.scopeType, "domain"), eq(healthWindows.scopeId, d.id)))
      .orderBy(desc(healthWindows.evaluatedAt))
      .limit(400);
    const baseline: Baseline | null = ownBaseline(history) ?? cohortBaseline(peerRates(d.provider, d.id));
    const ev = evaluateHealth({
      sends: rows.map((r) => ({ sentAt: r.sentAt!, hardBounce: r.bounceType === "hard", humanReply: r.replyKind === "human" })),
      now,
      since: d.lastResumeAt ?? d.activatedAt,
      baseline,
      policies,
    });
    const prev = history[0];
    if (!prev || prev.verdict !== ev.verdict || prev.sends !== ev.sends || prev.lastSendAt?.getTime() !== ev.lastSendAt?.getTime()) {
      await db.insert(healthWindows).values({
        workspaceId,
        scopeType: "domain",
        scopeId: d.id,
        sends: ev.sends,
        hardBounces: ev.hardBounces,
        humanReplies: ev.humanReplies,
        replyRate: ev.replyRate,
        bounceRate: ev.bounceRate,
        baselineReplyRate: baseline?.replyRate ?? null,
        baselineBounceRate: baseline?.bounceRate ?? null,
        baselineSource: baseline?.source ?? null,
        verdict: ev.verdict,
        reasons: ev.reasons,
        firstSendAt: ev.firstSendAt,
        lastSendAt: ev.lastSendAt,
      });
    }
    await db.update(domains).set({ healthVerdict: ev.verdict }).where(eq(domains.id, d.id));
    results.push({ domain: d.name, verdict: ev.verdict });

    if (ev.verdict === "red" && d.state === "active") {
      await setState(d, "flagged", SYSTEM, "RED verdict: reply rate < 1% and bounce rate > 3%");
      await cancelScheduled(d.id, "DOMAIN_NOT_SENDING");
      await raiseAlert(workspaceId, {
        severity: "critical",
        kind: "health_red",
        key: `health:${d.id}`,
        title: `${d.name} is RED. Sending paused, diagnosis opened.`,
        body: ev.reasons.join(" "),
        entity: { type: "domain", id: d.id },
        action: { label: "Diagnose", href: `/diagnoses` },
      });
      await openDiagnosis(workspaceId, d.id, "red", SYSTEM);
    } else if (ev.verdict === "amber" && d.state === "active") {
      await raiseAlert(workspaceId, {
        severity: "warning",
        kind: "health_amber",
        key: `health:${d.id}`,
        title: `${d.name} is drifting from its baseline. Diagnose before replacing.`,
        body: ev.reasons.join(" "),
        entity: { type: "domain", id: d.id },
        action: { label: "Run diagnosis", href: `/health?domain=${d.id}` },
      });
    } else if (ev.verdict === "green") {
      await resolveAlert(workspaceId, `health:${d.id}`);
    }
  }

  await runBreakers(workspaceId, now);
  await correlatedCheck(workspaceId);
  return results;
}

/** HLT-8 circuit breakers: safety pauses that never produce rotation verdicts on their own. */
async function runBreakers(workspaceId: string, now: Date) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const h = policies.health;

  // (c) policy/spam-block bounces on a domain in 24h
  const blocks = await db
    .select({ domainId: sends.domainId, n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.bounceCategory, "policy_or_spam_block"), gte(sends.bouncedAt, new Date(now.getTime() - 86_400_000))))
    .groupBy(sends.domainId);
  for (const b of blocks) {
    if (b.n < h.breakerSpamBlocks24h) continue;
    const [d] = await db.select().from(domains).where(eq(domains.id, b.domainId));
    if (!d || d.state !== "active") continue;
    await setState(d, "flagged", SYSTEM, `${b.n} spam/policy blocks in 24h (circuit breaker)`);
    await cancelScheduled(d.id, "DOMAIN_NOT_SENDING");
    await raiseAlert(workspaceId, {
      severity: "critical",
      kind: "breaker_domain",
      key: `health:${d.id}`,
      title: `${d.name} paused: ${b.n} spam-block bounces in 24 hours.`,
      body: "Receivers are rejecting mail from this domain on reputation or policy grounds. A diagnosis is open.",
      entity: { type: "domain", id: d.id },
      action: { label: "Diagnose", href: "/diagnoses" },
    });
    await openDiagnosis(workspaceId, d.id, "breaker", SYSTEM);
  }

  // (b) list breaker
  const lists = await db
    .select({
      importId: sends.importId,
      sent: sql<number>`count(*)::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
    })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.status, "sent"), isNotNull(sends.importId), gte(sends.sentAt, new Date(now.getTime() - 30 * 86_400_000))))
    .groupBy(sends.importId);
  for (const l of lists) {
    if (!l.importId || l.sent < h.breakerListMinSends || l.bounces / l.sent <= h.breakerListBounceRate) continue;
    const [imp] = await db.select().from(listImports).where(eq(listImports.id, l.importId));
    if (!imp || imp.breakerTripped) continue;
    await db.update(listImports).set({ breakerTripped: true }).where(eq(listImports.id, imp.id));
    const ids = db.select({ id: prospects.id }).from(prospects).where(eq(prospects.importId, imp.id));
    await db.update(enrollments).set({ status: "paused" }).where(and(eq(enrollments.status, "active"), eq(enrollments.nextStep, 0), inArray(enrollments.prospectId, ids)));
    await raiseAlert(workspaceId, {
      severity: "critical",
      kind: "breaker_list",
      key: `breaker_list:${imp.id}`,
      title: `List "${imp.name}" paused: ${pct(l.bounces / l.sent)} hard bounces.`,
      body: `${l.bounces} of ${l.sent} sends bounced. This is a list problem, not a domain problem. Re-validate before resuming.`,
      entity: { type: "import", id: imp.id },
      action: { label: "Review list", href: `/lists/${imp.id}` },
    });
  }

  // blocklist hits
  const listed = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.blocklisted, true), eq(domains.state, "active")));
  for (const d of listed) {
    await setState(d, "flagged", SYSTEM, "Domain is on a blocklist");
    await cancelScheduled(d.id, "DOMAIN_NOT_SENDING");
    await openDiagnosis(workspaceId, d.id, "blocklist", SYSTEM);
  }
}

/** HLT-10: many domains in one pool degrading together points to copy or list. */
async function correlatedCheck(workspaceId: string) {
  const db = getDb();
  const rows = await db
    .select({ poolId: domains.poolId, total: sql<number>`count(*)::int`, bad: sql<number>`count(*) filter (where ${domains.healthVerdict} in ('red','amber'))::int` })
    .from(domains)
    .where(and(eq(domains.workspaceId, workspaceId), inArray(domains.state, ["active", "flagged", "diagnosing"])))
    .groupBy(domains.poolId);
  for (const r of rows) {
    if (r.total >= 3 && r.bad / r.total >= 0.3) {
      const cs = await db.select({ name: campaigns.name }).from(campaigns).where(and(eq(campaigns.poolId, r.poolId!), eq(campaigns.status, "active")));
      await raiseAlert(workspaceId, {
        severity: "warning",
        kind: "correlated",
        key: `correlated:${r.poolId}`,
        title: `${r.bad} of ${r.total} domains are degrading at the same time`,
        body: `When many domains drop together it's usually the copy or the list, not the infrastructure. Check ${cs.map((c) => `"${c.name}"`).join(", ") || "the active campaigns"} before rotating.`,
        action: { label: "Review campaigns", href: "/campaigns" },
      });
    } else await resolveAlert(workspaceId, `correlated:${r.poolId}`);
  }
}

export async function healthOverview(workspaceId: string) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const ds = await db
    .select()
    .from(domains)
    .where(and(eq(domains.workspaceId, workspaceId), inArray(domains.state, ["active", "flagged", "diagnosing", "layover"])));
  const latest = await latestWindows(workspaceId);
  const progress = await db
    .select({ domainId: sends.domainId, n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.status, "sent"), inArray(sends.kind, ["first_touch", "follow_up"]), lte(sends.sentAt, new Date(Date.now() - policies.health.maturityHours * 3_600_000)), gte(sends.sentAt, new Date(Date.now() - policies.health.maxLookbackDays * 86_400_000))))
    .groupBy(sends.domainId);
  return {
    thresholds: policies.health,
    domains: ds.map((d) => {
      const w = latest.find((x) => x.scopeId === d.id);
      const mature = progress.find((p) => p.domainId === d.id)?.n ?? 0;
      return { id: d.id, name: d.name, provider: d.provider, state: d.state, verdict: d.healthVerdict, window: w ?? null, matureSends: Math.min(mature, policies.health.minSample) };
    }),
  };
}

export async function domainHealthHistory(workspaceId: string, domainId: string) {
  const db = getDb();
  const windows = await db
    .select()
    .from(healthWindows)
    .where(and(eq(healthWindows.workspaceId, workspaceId), eq(healthWindows.scopeId, domainId)))
    .orderBy(desc(healthWindows.evaluatedAt))
    .limit(200);
  const daily = await db
    .select({
      day: sql<string>`to_char(${sends.sentAt}, 'YYYY-MM-DD')`,
      sent: sql<number>`count(*)::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
    })
    .from(sends)
    .where(and(eq(sends.domainId, domainId), eq(sends.status, "sent"), inArray(sends.kind, ["first_touch", "follow_up"]), gte(sends.sentAt, new Date(Date.now() - 60 * 86_400_000))))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { windows: windows.reverse(), daily };
}
