/** Dashboard read model and launch checklist (SPEC §12 item 1). */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { domainDailyCap, reserveCoverage } from "@cold/core";
import { getDb, schema } from "../db/client";
import { getPolicies, getProtectedDomains, getWorkspace, hasSecret } from "./common";

const { domains, mailboxes, sends, alerts, campaigns, listImports, threads, tenants, prospects } = schema;

export async function overview(workspaceId: string) {
  const db = getDb();
  const ws = await getWorkspace(workspaceId);
  const policies = await getPolicies(workspaceId);
  const ds = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), ne(domains.state, "retired")));
  const mbCounts = await db
    .select({ domainId: mailboxes.domainId, n: sql<number>`count(*)::int`, connected: sql<number>`count(*) filter (where ${mailboxes.connection} = 'connected')::int` })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), ne(mailboxes.state, "decommissioned"), eq(mailboxes.isSeed, false)))
    .groupBy(mailboxes.domainId);
  const cap = (d: (typeof ds)[number]) => domainDailyCap(d.provider, mbCounts.find((m) => m.domainId === d.id)?.n ?? 0, policies, d.capOverride);
  const coverage = reserveCoverage(ds.map((d) => ({ provider: d.provider, pool: d.pool, state: d.state, capacity: cap(d) })), policies);
  const activeCapacity = ds.filter((d) => d.state === "active").reduce((a, d) => a + cap(d), 0);

  const today = new Date().toISOString().slice(0, 10);
  const [todayStats] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${sends.status} = 'sent')::int`,
      scheduled: sql<number>`count(*) filter (where ${sends.status} in ('scheduled','sending'))::int`,
      skipped: sql<number>`count(*) filter (where ${sends.status} = 'skipped')::int`,
    })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.localDate, today), inArray(sends.kind, ["first_touch", "follow_up"])));

  const since = new Date(Date.now() - 30 * 86_400_000);
  const daily = await db
    .select({
      day: sql<string>`to_char(${sends.sentAt}, 'YYYY-MM-DD')`,
      sent: sql<number>`count(*)::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
    })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.status, "sent"), inArray(sends.kind, ["first_touch", "follow_up"]), gte(sends.sentAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const totals = daily.reduce((a, d) => ({ sent: a.sent + d.sent, replies: a.replies + d.replies, bounces: a.bounces + d.bounces }), { sent: 0, replies: 0, bounces: 0 });

  const openAlerts = await db.select().from(alerts).where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.status, "open"))).orderBy(desc(alerts.createdAt)).limit(50);
  const recentReplies = await db
    .select({ id: threads.id, counterpart: threads.counterpart, subject: threads.subject, intent: threads.intent, lastInboundAt: threads.lastInboundAt, company: prospects.company, firstName: prospects.firstName })
    .from(threads)
    .leftJoin(prospects, eq(threads.prospectId, prospects.id))
    .where(and(eq(threads.workspaceId, workspaceId), eq(threads.classification, "human")))
    .orderBy(desc(threads.lastInboundAt))
    .limit(6);

  const byState: Record<string, number> = {};
  for (const d of ds) byState[d.state] = (byState[d.state] ?? 0) + 1;
  const verdicts: Record<string, number> = {};
  for (const d of ds.filter((x) => ["active", "flagged", "diagnosing"].includes(x.state))) verdicts[d.healthVerdict] = (verdicts[d.healthVerdict] ?? 0) + 1;

  return {
    workspace: { id: ws.id, name: ws.name, simulation: !!ws.settings.simulation },
    capacity: { active: activeCapacity, today: todayStats, coverage },
    domains: { total: ds.length, byState, verdicts },
    totals30d: totals,
    daily,
    alerts: openAlerts,
    recentReplies,
    checklist: await setupChecklist(workspaceId),
  };
}

/** Guided setup from zero (playbook order). */
export async function setupChecklist(workspaceId: string) {
  const db = getDb();
  const ws = await getWorkspace(workspaceId);
  const [prot, tenantRows, ds, mbs, imports, cs] = await Promise.all([
    getProtectedDomains(workspaceId),
    db.select({ id: tenants.id }).from(tenants).where(eq(tenants.workspaceId, workspaceId)),
    db.select({ state: domains.state, pool: domains.pool, auth: domains.authVerifiedAt, header: domains.headerTestPassedAt }).from(domains).where(eq(domains.workspaceId, workspaceId)),
    db.select({ connection: mailboxes.connection, warm: mailboxes.warmupStartedAt }).from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.isSeed, false))),
    db.select({ status: listImports.status }).from(listImports).where(eq(listImports.workspaceId, workspaceId)),
    db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.workspaceId, workspaceId)),
  ]);
  const validation = ws.settings.simulation || (ws.settings.validationProvider && ws.settings.validationProvider !== "none" && (await hasSecret(workspaceId, "validation.apiKey")));
  const steps = [
    { id: "protect", rule: 1, title: "Protect your primary domain", done: prot.length > 0, href: "/settings" },
    { id: "plan", rule: 3, title: "Plan capacity: Google vs Microsoft", done: ds.length > 0, href: "/planner" },
    { id: "tenant", rule: 2, title: "Connect a Google Workspace or Microsoft 365 tenant", done: tenantRows.length > 0, href: "/settings/integrations" },
    { id: "domains", rule: 1, title: "Add lookalike sending domains (active + reserve)", done: ds.some((d) => d.pool === "active") && ds.some((d) => d.pool === "reserve"), href: "/domains" },
    { id: "mailboxes", rule: 4, title: "Create mailboxes within the per-domain limits", done: mbs.length > 0, href: "/domains" },
    { id: "auth", rule: 5, title: "Authenticate: SPF, DKIM, DMARC + header test", done: ds.some((d) => d.auth && d.header), href: "/domains" },
    { id: "warmup", rule: 6, title: "Warm every inbox for at least 14 days", done: mbs.some((m) => m.warm), href: "/domains" },
    { id: "validation", rule: 8, title: "Connect an email validation provider", done: !!validation, href: "/settings/integrations" },
    { id: "list", rule: 8, title: "Upload and clean your first list", done: imports.some((i) => i.status === "done"), href: "/lists" },
    { id: "campaign", rule: 9, title: "Write short plain-text copy and launch", done: cs.some((c) => c.status === "active"), href: "/campaigns" },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, dismissed: !!ws.settings.onboardingDismissed };
}

export async function reserveView(workspaceId: string) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const ds = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), ne(domains.state, "retired")));
  const mbs = await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), ne(mailboxes.state, "decommissioned"), eq(mailboxes.isSeed, false)));
  const now = new Date();
  const rows = ds.map((d) => {
    const own = mbs.filter((m) => m.domainId === d.id);
    const start = own.map((m) => m.warmupStartedAt?.getTime() ?? 0).filter(Boolean);
    const minStart = start.length ? Math.max(...start) : null;
    const days = minStart ? Math.floor((now.getTime() - minStart) / 86_400_000) : 0;
    return {
      id: d.id,
      name: d.name,
      provider: d.provider,
      pool: d.pool,
      state: d.state,
      billingStatus: d.billingStatus,
      vendor: d.vendor,
      mailboxes: own.length,
      capacity: domainDailyCap(d.provider, own.length, policies, d.capOverride),
      warmupDays: days,
      readyInDays: minStart ? Math.max(0, policies.warmup.minDays - days) : null,
    };
  });
  const orders = await db.select().from(schema.provisioningOrders).where(eq(schema.provisioningOrders.workspaceId, workspaceId)).orderBy(desc(schema.provisioningOrders.createdAt)).limit(50);
  return { coverage: reserveCoverage(rows, policies), domains: rows, orders, target: policies.reserve.ratio, minDays: policies.warmup.minDays, targetDays: policies.warmup.targetDays };
}
