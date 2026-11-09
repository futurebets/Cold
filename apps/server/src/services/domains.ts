/** Sending domains and mailboxes: provisioning, authentication, warmup, lifecycle (SPEC §6.1–6.6, §7). */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DomainState, Pool, Provider } from "@cold/core";
import {
  analyzeHeaders,
  checkTransition,
  domainDailyCap,
  evaluateDns,
  expectedRecords,
  isProtected,
  isValidDomainName,
  maxMailboxesPerDomain,
  normalizeDomain,
  warmupDays,
  warmupStatus,
} from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, conflict, HttpError, notFound } from "../lib/http";
import { newMessageId } from "../lib/mime";
import { lookupDomainAuth, simulatedDomainAuth } from "../adapters/dns";
import { pushCloudflare } from "../adapters/external";
import type { Actor } from "./common";
import { audit, getPolicies, getProtectedDomains, getSecret, getWorkspace, loadTenant, raiseAlert, resolveAlert, SYSTEM } from "./common";

const { domains, mailboxes, dnsChecks, headerTests, tenants, mailboxPools, sends } = schema;
type DomainRow = typeof domains.$inferSelect;
type MailboxRow = typeof mailboxes.$inferSelect;

export async function getDomain(workspaceId: string, id: string): Promise<DomainRow> {
  const [d] = await getDb().select().from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.id, id)));
  if (!d) throw notFound("Domain not found");
  return d;
}

export async function domainMailboxes(domainId: string): Promise<MailboxRow[]> {
  return getDb().select().from(mailboxes).where(and(eq(mailboxes.domainId, domainId), ne(mailboxes.state, "decommissioned")));
}

export async function domainCapacity(d: DomainRow, mbs?: MailboxRow[]) {
  const policies = await getPolicies(d.workspaceId);
  const list = mbs ?? (await domainMailboxes(d.id));
  return domainDailyCap(d.provider, list.length, policies, d.capOverride);
}

export async function defaultPool(workspaceId: string, catchAll = false) {
  const db = getDb();
  const [p] = await db.select().from(mailboxPools).where(and(eq(mailboxPools.workspaceId, workspaceId), eq(mailboxPools.isCatchAll, catchAll)));
  if (p) return p;
  const [created] = await db.insert(mailboxPools).values({ workspaceId, name: catchAll ? "Catch-all" : "Main", isCatchAll: catchAll }).returning();
  return created;
}

export async function addDomains(
  workspaceId: string,
  actor: Actor,
  input: { names: string[]; provider: Provider; tenantId?: string | null; pool: Pool; vendor?: "hypertide" | "direct" | "other"; poolId?: string | null; dnsManaged?: "cloudflare" | "manual" },
) {
  const db = getDb();
  const protectedList = await getProtectedDomains(workspaceId);
  if (protectedList.length === 0) throw badRequest("Add your primary domain under Settings → Protected domains first, so Cold can make sure you never send from it.");
  const names = [...new Set(input.names.map(normalizeDomain).filter(Boolean))];
  const errors: { name: string; error: string }[] = [];
  const valid: string[] = [];
  for (const n of names) {
    if (!isValidDomainName(n)) errors.push({ name: n, error: "Not a valid domain name" });
    else if (isProtected(n, protectedList)) errors.push({ name: n, error: "This is your protected primary domain (or a subdomain of it). Cold email must go out from separate lookalike domains." });
    else valid.push(n);
  }
  if (input.tenantId) {
    const t = await loadTenant(input.tenantId);
    if (!t || t.workspaceId !== workspaceId) throw badRequest("Unknown tenant");
    if (t.provider !== input.provider) throw badRequest(`That tenant is ${t.provider}, not ${input.provider}`);
  }
  const pool = input.poolId ?? (await defaultPool(workspaceId)).id;
  const created: DomainRow[] = [];
  for (const name of valid) {
    const [existing] = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.name, name)));
    if (existing) {
      errors.push({ name, error: "Already added" });
      continue;
    }
    const [row] = await db
      .insert(domains)
      .values({
        workspaceId,
        name,
        provider: input.provider,
        tenantId: input.tenantId ?? null,
        pool: input.pool,
        poolId: pool,
        vendor: input.vendor ?? "direct",
        dnsManaged: input.dnsManaged ?? "manual",
        billingStatus: input.pool === "reserve" && input.vendor === "hypertide" ? "recovery_pool" : "active",
      })
      .returning();
    created.push(row);
  }
  if (created.length) await audit(workspaceId, actor, "domains.added", null, { names: created.map((d) => d.name), provider: input.provider, pool: input.pool });
  return { created, errors };
}

/** Add mailboxes (personas) to a domain, enforcing per-provider mailbox limits (rule 4). */
export async function addMailboxes(workspaceId: string, actor: Actor, domainId: string, personas: { firstName: string; lastName?: string; localPart?: string }[]) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  const policies = await getPolicies(workspaceId);
  const existing = await domainMailboxes(d.id);
  const max = maxMailboxesPerDomain(d.provider, policies);
  if (existing.length + personas.length > max)
    throw badRequest(`${d.provider === "google" ? "Google" : "Microsoft"} domains hold at most ${max} mailboxes (you'd have ${existing.length + personas.length}).`);
  const ws = await getWorkspace(workspaceId);
  const out: MailboxRow[] = [];
  for (const p of personas) {
    const first = p.firstName.trim();
    if (!first) continue;
    const local = (p.localPart?.trim() || first)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]/g, "");
    const address = `${local}@${d.name}`;
    const [dupe] = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.address, address)));
    if (dupe) throw conflict(`${address} already exists`);
    const [row] = await db
      .insert(mailboxes)
      .values({
        workspaceId,
        domainId: d.id,
        tenantId: d.tenantId,
        address,
        firstName: first,
        lastName: p.lastName?.trim() ?? "",
        signature: `${first}${p.lastName ? " " + p.lastName.trim() : ""}`,
        timezone: ws.timezone,
        state: d.state === "warming" ? "warming" : "provisioning",
        warmupStartedAt: d.state === "warming" ? new Date() : null,
      })
      .returning();
    out.push(row);
  }
  await audit(workspaceId, actor, "mailboxes.added", { type: "domain", id: d.id }, { addresses: out.map((m) => m.address) });
  return out;
}

// ───────────── Authentication (rule 5) ─────────────

export async function expectedForDomain(d: DomainRow) {
  const ws = await getWorkspace(d.workspaceId);
  const policies = await getPolicies(d.workspaceId);
  return expectedRecords(d.name, d.provider, {
    dmarcPolicy: policies.auth.dmarcPolicy,
    dmarcRua: ws.settings.dmarcRua ?? null,
    ...d.dnsValues,
  });
}

export async function isSimulatedDomain(d: DomainRow): Promise<boolean> {
  if (!d.tenantId) return !!(await getWorkspace(d.workspaceId)).settings.simulation;
  const t = await loadTenant(d.tenantId);
  return t?.transport === "simulated";
}

export async function checkDns(workspaceId: string, domainId: string, actor: Actor = SYSTEM) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  const lookup = (await isSimulatedDomain(d)) ? simulatedDomainAuth(d.name, d.provider) : await lookupDomainAuth(d.name, d.provider);
  const result = evaluateDns(d.provider, lookup);
  const now = new Date();
  await db.insert(dnsChecks).values({ domainId: d.id, pass: result.pass, items: result.items });
  await db
    .update(domains)
    .set({ lastDnsCheckAt: now, lastDnsResult: result, ...(result.pass ? { authVerifiedAt: now } : {}), updatedAt: now })
    .where(eq(domains.id, d.id));

  const fresh = await getDomain(workspaceId, domainId);
  if (result.pass) {
    await resolveAlert(workspaceId, `auth_failed:${d.id}`);
    if (fresh.state === "auth_failed" && fresh.previousState) await setState(fresh, fresh.previousState, actor, "Authentication passes again");
    else if (fresh.state === "pending_dns" && fresh.headerTestPassedAt) await setState(fresh, "auth_verified", actor, "DNS and header test passed");
  } else if (["warming", "ready", "active", "flagged", "diagnosing"].includes(fresh.state)) {
    await db.update(domains).set({ previousState: fresh.state }).where(eq(domains.id, d.id));
    await setState(fresh, "auth_failed", actor, "DNS re-verification failed");
    await raiseAlert(workspaceId, {
      severity: "critical",
      kind: "auth_failed",
      key: `auth_failed:${d.id}`,
      title: `${d.name}: authentication failing. Sending and warmup paused.`,
      body: result.items.filter((i) => !i.pass).map((i) => `${i.label}: ${i.detail}`).join("\n"),
      entity: { type: "domain", id: d.id },
      action: { label: "Fix DNS", href: `/domains/${d.id}` },
    });
  }
  return result;
}

export async function pushDns(workspaceId: string, domainId: string, actor: Actor) {
  const d = await getDomain(workspaceId, domainId);
  const token = await getSecret(workspaceId, "cloudflare.token");
  if (!token) throw badRequest("Connect Cloudflare in Settings → Integrations to write DNS automatically, or copy the records by hand.");
  const result = await pushCloudflare(token, d.name, await expectedForDomain(d));
  await getDb().update(domains).set({ dnsManaged: "cloudflare" }).where(eq(domains.id, d.id));
  await audit(workspaceId, actor, "dns.pushed", { type: "domain", id: d.id }, { ...result });
  return result;
}

/** Manual header test: user sends themselves a test email and pastes the headers (AUTH-4). */
export async function submitHeaders(workspaceId: string, domainId: string, raw: string, actor: Actor, mailboxId?: string | null, source: "manual" | "seed" = "manual") {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  if (!raw.trim()) throw badRequest("Paste the full headers of the test email");
  const a = analyzeHeaders(raw, d.name);
  await db.insert(headerTests).values({
    workspaceId,
    domainId: d.id,
    mailboxId: mailboxId ?? null,
    source,
    rawHeaders: raw.slice(0, 50_000),
    spf: a.spf,
    dkim: a.dkim,
    dkimDomain: a.dkimDomain ?? null,
    dkimAligned: a.dkimAligned,
    dmarc: a.dmarc,
    pass: a.pass,
    issues: a.issues,
  });
  if (a.pass) {
    await db.update(domains).set({ headerTestPassedAt: new Date() }).where(eq(domains.id, d.id));
    const fresh = await getDomain(workspaceId, domainId);
    if (fresh.state === "pending_dns" && fresh.authVerifiedAt) await setState(fresh, "auth_verified", actor, "DNS and header test passed");
  }
  await audit(workspaceId, actor, "header_test", { type: "domain", id: d.id }, { pass: a.pass, spf: a.spf, dkim: a.dkim, dmarc: a.dmarc });
  return a;
}

/** Automated header test: send from each mailbox to a seed inbox; the lifecycle job reads the headers back. */
export async function startAutoHeaderTest(workspaceId: string, domainId: string, actor: Actor) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  const mbs = (await domainMailboxes(d.id)).filter((m) => m.connection === "connected");
  if (mbs.length === 0) throw badRequest("Connect at least one mailbox on this domain first.");
  const seeds = await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.isSeed, true), eq(mailboxes.connection, "connected")));
  if (seeds.length === 0) throw badRequest("No seed inbox is connected. Paste headers manually, or mark a connected mailbox as a seed in Mailboxes.");
  const now = new Date();
  const rows = mbs.map((m, i) => ({
    workspaceId,
    kind: "header_test" as const,
    mailboxId: m.id,
    domainId: d.id,
    toAddress: seeds[i % seeds.length].address,
    scheduledAt: now,
    localDate: now.toISOString().slice(0, 10),
    subject: `Cold header test ${d.name}`,
    body: `Authentication test for ${m.address}. You can delete this message.`,
    rfcMessageId: newMessageId(d.name),
  }));
  await db.insert(sends).values(rows);
  await audit(workspaceId, actor, "header_test.started", { type: "domain", id: d.id }, { mailboxes: mbs.length });
  return { queued: rows.length };
}

// ───────────── Lifecycle (rule 6, §7) ─────────────

const MAILBOX_STATE_FOR: Partial<Record<DomainState, MailboxRow["state"]>> = {
  warming: "warming",
  ready: "ready",
  active: "active",
  relay: "relay",
  layover: "active",
  retired: "decommissioned",
};

/** Write a state change (no gate checks: callers use transition() for gated moves). */
export async function setState(d: DomainRow, to: DomainState, actor: Actor, reason: string) {
  const db = getDb();
  if (d.state === to) return;
  const now = new Date();
  await db
    .update(domains)
    .set({
      state: to,
      updatedAt: now,
      ...(to === "active" && !d.activatedAt ? { activatedAt: now } : {}),
      ...(to === "retired" ? { retiredAt: now, pool: "retired" as Pool, billingStatus: "cancelled" as const } : {}),
    })
    .where(eq(domains.id, d.id));
  const mbState = MAILBOX_STATE_FOR[to];
  if (mbState) await db.update(mailboxes).set({ state: mbState }).where(and(eq(mailboxes.domainId, d.id), ne(mailboxes.state, "decommissioned")));
  await audit(d.workspaceId, actor, "domain.state", { type: "domain", id: d.id }, { from: d.state, to, name: d.name }, reason);
}

/** Gated transition (SPEC §7.1). Throws 409 with blockers when a hard gate refuses. */
export async function transition(workspaceId: string, domainId: string, to: DomainState, actor: Actor, reason: string) {
  const d = await getDomain(workspaceId, domainId);
  const mbs = await domainMailboxes(d.id);
  const policies = await getPolicies(workspaceId);
  const gate = checkTransition(to, { domain: d, mailboxes: mbs, protectedDomains: await getProtectedDomains(workspaceId), policies });
  if (!gate.ok) throw new HttpError(409, gate.blockers[0].message, { blockers: gate.blockers });
  await setState(d, to, actor, reason);
  return getDomain(workspaceId, domainId);
}

/**
 * Start warmup tracking. Warmup itself runs in your warmup tool (or Hypertide); Cold gates
 * sending on its age. `since` records warmup that already started elsewhere (audited).
 */
export async function startWarmup(workspaceId: string, domainId: string, actor: Actor, since?: Date | null) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  if (since && since.getTime() > Date.now()) throw badRequest("Warmup start can't be in the future");
  await transition(workspaceId, domainId, "warming", actor, since ? `Warmup already running since ${since.toISOString().slice(0, 10)} (attested)` : "Warmup started");
  const start = since ?? new Date();
  await db.update(mailboxes).set({ warmupStartedAt: start, warmupPausedDays: 0 }).where(and(eq(mailboxes.domainId, d.id), sql`${mailboxes.warmupStartedAt} is null`));
  if (since) await audit(workspaceId, actor, "warmup.backdated", { type: "domain", id: d.id }, { since: start.toISOString() }, "Operator attested warmup started earlier in another tool");
  return getDomain(workspaceId, domainId);
}

export async function setPool(workspaceId: string, domainId: string, pool: "active" | "reserve", actor: Actor) {
  const db = getDb();
  const d = await getDomain(workspaceId, domainId);
  if (d.state === "retired" || d.state === "relay" || d.state === "layover") throw badRequest("Outgoing domains can't change pool");
  if (pool === "reserve" && ["active", "flagged", "diagnosing"].includes(d.state)) {
    await db.update(domains).set({ pool, billingStatus: d.vendor === "hypertide" ? "recovery_pool" : d.billingStatus }).where(eq(domains.id, d.id));
    await setState({ ...d, pool }, "ready", actor, "Moved to reserve");
  } else {
    await db.update(domains).set({ pool, billingStatus: pool === "reserve" && d.vendor === "hypertide" ? "recovery_pool" : pool === "active" ? "active" : d.billingStatus }).where(eq(domains.id, d.id));
  }
  await audit(workspaceId, actor, "domain.pool", { type: "domain", id: d.id }, { pool });
  if (pool === "active" && d.state === "ready") return transition(workspaceId, domainId, "active", actor, "Assigned to active pool");
  return getDomain(workspaceId, domainId);
}

export async function retireDomain(workspaceId: string, domainId: string, actor: Actor, reason: string) {
  const d = await getDomain(workspaceId, domainId);
  await getDb().update(domains).set({ retireReason: reason }).where(eq(domains.id, d.id));
  await setState(d, "retired", actor, reason);
}

// ───────────── Read models ─────────────

export async function listDomains(workspaceId: string) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const ds = await db.select().from(domains).where(eq(domains.workspaceId, workspaceId)).orderBy(domains.name);
  const mbs = ds.length ? await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), ne(mailboxes.state, "decommissioned"))) : [];
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = await db
    .select({ domainId: sends.domainId, n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.localDate, today), inArray(sends.status, ["sent", "sending", "scheduled"]), inArray(sends.kind, ["first_touch", "follow_up"])))
    .groupBy(sends.domainId);
  const sentMap = new Map(sentToday.map((r) => [r.domainId, r.n]));
  const now = new Date();
  return ds.map((d) => {
    const own = mbs.filter((m) => m.domainId === d.id);
    const days = own.length ? Math.min(...own.map((m) => warmupDays(m, now))) : 0;
    const w = own.length ? warmupStatus({ warmupStartedAt: own.find((m) => m.warmupStartedAt)?.warmupStartedAt ?? null }, policies, now) : null;
    return {
      ...d,
      mailboxCount: own.length,
      connectedCount: own.filter((m) => m.connection === "connected").length,
      capacity: domainDailyCap(d.provider, own.length, policies, d.capOverride),
      scheduledOrSentToday: sentMap.get(d.id) ?? 0,
      warmupDays: days,
      warmupLevel: w?.level ?? "not_started",
      readyAt: w?.readyAt ?? null,
    };
  });
}

export async function domainDetail(workspaceId: string, id: string) {
  const db = getDb();
  const d = await getDomain(workspaceId, id);
  const policies = await getPolicies(workspaceId);
  const mbs = await db.select().from(mailboxes).where(eq(mailboxes.domainId, d.id)).orderBy(mailboxes.address);
  const tests = await db.select().from(headerTests).where(eq(headerTests.domainId, d.id)).orderBy(sql`${headerTests.createdAt} desc`).limit(5);
  const tenant = d.tenantId ? (await db.select().from(tenants).where(eq(tenants.id, d.tenantId)))[0] ?? null : null;
  const now = new Date();
  const protectedList = await getProtectedDomains(workspaceId);
  const gates = Object.fromEntries(
    (["warming", "ready", "active"] as DomainState[]).map((to) => [
      to,
      checkTransition(to, { domain: d, mailboxes: mbs.filter((m) => m.state !== "decommissioned"), protectedDomains: protectedList, policies, now }),
    ]),
  );
  return {
    domain: d,
    tenant: tenant ? { id: tenant.id, name: tenant.name, provider: tenant.provider, transport: tenant.transport, vendor: tenant.vendor } : null,
    expected: await expectedForDomain(d),
    mailboxes: mbs.map((m) => ({ ...m, warmup: warmupStatus(m, policies, now) })),
    headerTests: tests,
    capacity: domainDailyCap(d.provider, mbs.filter((m) => m.state !== "decommissioned").length, policies, d.capOverride),
    gates,
  };
}
