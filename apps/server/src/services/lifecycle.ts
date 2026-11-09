/** Periodic lifecycle work: warmup gates, DNS re-verification, seed header tests, reserve coverage, expiry. */
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { checkTransition, domainDailyCap, reserveCoverage, warmupDays } from "@cold/core";
import { getDb, schema } from "../db/client";
import { transportFor } from "../adapters/transport";
import { checkBlocklist } from "../adapters/external";
import { getPolicies, getProtectedDomains, getSecret, loadTenant, mailboxCtx, raiseAlert, resolveAlert, SYSTEM } from "./common";
import { checkDns, isSimulatedDomain, setState, submitHeaders } from "./domains";
import { readControlTests } from "./diagnosis";
import { advanceRotations } from "./rotation";

const { domains, mailboxes, sends } = schema;

export async function runLifecycle(workspaceId: string, now = new Date()) {
  await progressWarmup(workspaceId, now);
  await reverifyAuth(workspaceId, now);
  await readSeedHeaderTests(workspaceId, now);
  await readControlTests(workspaceId, now);
  await advanceRotations(workspaceId, now);
  await coverageAlerts(workspaceId);
  await expiryAlerts(workspaceId, now);
}

/** warming → ready when gates pass; ready + active pool → active (initial launch / promotion). */
async function progressWarmup(workspaceId: string, now: Date) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const protectedList = await getProtectedDomains(workspaceId);
  const ds = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), inArray(domains.state, ["warming", "ready"])));
  for (const d of ds) {
    const mbs = await db.select().from(mailboxes).where(and(eq(mailboxes.domainId, d.id), ne(mailboxes.state, "decommissioned")));
    if (d.state === "warming") {
      const gate = checkTransition("ready", { domain: d, mailboxes: mbs, protectedDomains: protectedList, policies, now });
      if (gate.ok) {
        await setState(d, "ready", SYSTEM, `Warmup reached ${Math.min(...mbs.map((m) => warmupDays(m, now)))} days`);
        await raiseAlert(workspaceId, {
          severity: "info",
          kind: "domain_ready",
          key: `ready:${d.id}`,
          title: `${d.name} finished warmup and is ready`,
          body: d.pool === "active" ? "It will start sending automatically." : "It's in reserve, ready to replace a burned domain.",
          entity: { type: "domain", id: d.id },
          notify: false,
        });
      }
    }
    const fresh = (await db.select().from(domains).where(eq(domains.id, d.id)))[0];
    if (fresh.state === "ready" && fresh.pool === "active") {
      const gate = checkTransition("active", { domain: fresh, mailboxes: mbs, protectedDomains: protectedList, policies, now });
      if (gate.ok) await setState(fresh, "active", SYSTEM, "Ready and assigned to the active pool");
    }
  }
}

/** Keep auth fresh (< 24h) on every domain that warms or sends (AUTH-6), plus daily blocklist checks. */
async function reverifyAuth(workspaceId: string, now: Date) {
  const db = getDb();
  const stale = new Date(now.getTime() - 12 * 3_600_000);
  const ds = await db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.workspaceId, workspaceId),
        inArray(domains.state, ["pending_dns", "auth_verified", "warming", "ready", "active", "flagged", "diagnosing", "auth_failed", "layover"]),
        or(isNull(domains.lastDnsCheckAt), lt(domains.lastDnsCheckAt, stale)),
      ),
    )
    .limit(25);
  const dqs = await getSecret(workspaceId, "spamhaus.dqsKey");
  for (const d of ds) {
    if (d.state === "pending_dns" && d.lastDnsCheckAt && now.getTime() - d.lastDnsCheckAt.getTime() < 30 * 60_000) continue;
    await checkDns(workspaceId, d.id, SYSTEM).catch(() => undefined);
    if (dqs && !(await isSimulatedDomain(d)) && ["active", "ready", "warming"].includes(d.state)) {
      const bl = await checkBlocklist(d.name, dqs);
      if (bl.checked && bl.listed !== d.blocklisted) await db.update(domains).set({ blocklisted: bl.listed }).where(eq(domains.id, d.id));
      if (bl.listed)
        await raiseAlert(workspaceId, { severity: "critical", kind: "blocklist", key: `blocklist:${d.id}`, title: `${d.name} is on a blocklist`, body: bl.detail, entity: { type: "domain", id: d.id }, action: { label: "Open", href: `/domains/${d.id}` } });
    }
  }
}

/** Automated header tests: fetch headers of test emails from seed inboxes (AUTH-4). */
async function readSeedHeaderTests(workspaceId: string, now: Date) {
  const db = getDb();
  const rows = await db
    .select()
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "header_test"), isNull(sends.placement), inArray(sends.status, ["sent", "failed", "skipped"])))
    .limit(20);
  for (const s of rows) {
    if (s.status !== "sent") {
      await db.update(sends).set({ placement: "missing" }).where(eq(sends.id, s.id));
      continue;
    }
    if (now.getTime() - (s.sentAt?.getTime() ?? 0) < 60_000) continue;
    const [seed] = await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.address, s.toAddress)));
    if (!seed) continue;
    const sd = seed.domainId ? (await db.select().from(domains).where(eq(domains.id, seed.domainId)))[0] : null;
    const ctx = await mailboxCtx(seed, sd?.name ?? seed.address.split("@")[1], await loadTenant(seed.tenantId ?? sd?.tenantId ?? null));
    const raw = await transportFor(ctx.tenant).rawHeaders(ctx, s.rfcMessageId!).catch(() => null);
    if (!raw) {
      if (now.getTime() - (s.sentAt?.getTime() ?? 0) > 2 * 3_600_000) await db.update(sends).set({ placement: "missing" }).where(eq(sends.id, s.id));
      continue;
    }
    await submitHeaders(workspaceId, s.domainId, raw, SYSTEM, s.mailboxId, "seed");
    await db.update(sends).set({ placement: "inbox" }).where(eq(sends.id, s.id));
  }
}

async function coverageAlerts(workspaceId: string) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const ds = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), ne(domains.state, "retired")));
  const counts = await db
    .select({ domainId: mailboxes.domainId, n: sql<number>`count(*)::int` })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), ne(mailboxes.state, "decommissioned")))
    .groupBy(mailboxes.domainId);
  const cov = reserveCoverage(
    ds.map((d) => ({ provider: d.provider, pool: d.pool, state: d.state, capacity: domainDailyCap(d.provider, counts.find((c) => c.domainId === d.id)?.n ?? 0, policies, d.capOverride) })),
    policies,
  );
  for (const c of cov) {
    const key = `coverage:${c.provider}`;
    if (c.status === "warn" || c.status === "critical") {
      await raiseAlert(workspaceId, {
        severity: c.status === "critical" ? "critical" : "warning",
        kind: "coverage",
        key,
        title: `${c.provider === "google" ? "Google" : "Microsoft"} reserve covers ${Math.round((c.ratio ?? 0) * 100)}% of active capacity`,
        body: `Domains will burn. Keep warmed replacements equal to active capacity (target ${Math.round(c.target * 100)}%). ${c.warmingReserveCapacity} sends/day of capacity is still warming.`,
        action: { label: "Plan reserve", href: "/reserve" },
      });
    } else await resolveAlert(workspaceId, key);
  }
}

async function expiryAlerts(workspaceId: string, now: Date) {
  const db = getDb();
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const ds = await db
    .select()
    .from(domains)
    .where(and(eq(domains.workspaceId, workspaceId), inArray(domains.pool, ["active", "reserve"]), lt(domains.expiresAt, soon)));
  for (const d of ds)
    await raiseAlert(workspaceId, {
      severity: "warning",
      kind: "expiry",
      key: `expiry:${d.id}`,
      title: `${d.name} expires ${d.expiresAt?.toISOString().slice(0, 10)}`,
      body: "Renew it at your registrar, or retire it.",
      entity: { type: "domain", id: d.id },
    });
}

/** Re-test connections of mailboxes marked unknown (after adding tenants or credentials). */
export async function testConnections(workspaceId: string, limit = 50) {
  const db = getDb();
  const rows = await db
    .select({ mailbox: mailboxes, domain: domains })
    .from(mailboxes)
    .leftJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.connection, "unknown"), ne(mailboxes.state, "decommissioned")))
    .limit(limit);
  for (const { mailbox, domain } of rows) await testMailbox(mailbox, domain);
}

export async function testMailbox(mailbox: typeof mailboxes.$inferSelect, domain: typeof domains.$inferSelect | null) {
  const db = getDb();
  const tenant = await loadTenant(mailbox.tenantId ?? domain?.tenantId ?? null);
  if (!tenant) {
    await db.update(mailboxes).set({ connection: "disconnected", connectionDetail: "No Google/Microsoft tenant attached to this domain" }).where(eq(mailboxes.id, mailbox.id));
    return { ok: false, detail: "No tenant attached" };
  }
  const ctx = await mailboxCtx(mailbox, domain?.name ?? mailbox.address.split("@")[1], tenant);
  const r = await transportFor(ctx.tenant).test(ctx);
  await db.update(mailboxes).set({ connection: r.ok ? "connected" : "disconnected", connectionDetail: r.detail }).where(eq(mailboxes.id, mailbox.id));
  if (r.ok) await resolveAlert(mailbox.workspaceId, `mailbox_disconnected:${mailbox.id}`);
  return r;
}
