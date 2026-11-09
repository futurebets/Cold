/**
 * End-to-end: boots the API on in-memory PGlite and walks the whole playbook with simulated
 * mailboxes: protect → provision → authenticate → warm → clean list → copy → send → replies →
 * health → diagnose → rotate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "cold-test-"));
process.env.SIM_DELAY_MINUTES = "0";
process.env.APP_SECRET = "test-secret-test-secret-test-secret-123";

const { initDb, closeDb, getDb, schema } = await import("../src/db/client");
const { buildApp } = await import("../src/app");
const { planWorkspace, runSender } = await import("../src/services/sending");
const { syncWorkspace } = await import("../src/services/inbox");
const { runLifecycle } = await import("../src/services/lifecycle");
const { evaluateWorkspaceHealth } = await import("../src/services/health");
const { eq, and, sql } = await import("drizzle-orm");

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
let workspaceId = "";

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as any,
    url,
    headers: { cookie, "x-cold-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers["set-cookie"];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  const data = res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : null;
  return { status: res.statusCode, data };
}

beforeAll(async () => {
  // TEST_DATABASE_URL runs the same suite against real PostgreSQL (CI / pre-deploy check).
  // The database is wiped first so the suite can be re-run.
  if (process.env.TEST_DATABASE_URL) {
    const pg = await import("pg");
    const c = new pg.default.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    await c.query("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
    await c.end();
  }
  await initDb({ url: process.env.TEST_DATABASE_URL ?? null, memory: true });
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("Cold end-to-end", () => {
  let tenantId = "";
  let activeDomainId = "";
  let reserveDomainId = "";
  let campaignId = "";
  let importId = "";

  it("refuses API mutations without the CSRF header", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x", password: "y" } });
    expect(res.statusCode).toBe(403);
  });

  it("sets up the workspace with a protected primary domain (rule 1)", async () => {
    expect((await api("GET", "/api/auth/state")).data.needsSetup).toBe(true);
    const r = await api("POST", "/api/auth/setup", { name: "Nat", email: "owner@acme.com", password: "correct-horse-battery", workspaceName: "Acme", primaryDomain: "acme.com" });
    expect(r.status).toBe(200);
    const st = await api("GET", "/api/auth/state");
    expect(st.data.user.role).toBe("owner");
    workspaceId = st.data.user.workspaceId;
    // turn on simulation so list validation + MX are simulated
    expect((await api("PUT", "/api/integrations", { simulation: true })).status).toBe(200);
  });

  it("never lets the primary domain or its subdomains become sending domains", async () => {
    const t = await api("POST", "/api/tenants", { name: "MS sim", provider: "microsoft", transport: "simulated", vendor: "hypertide" });
    tenantId = t.data.id;
    const r = await api("POST", "/api/domains", { names: ["acme.com", "mail.acme.com", "getacme.com", "tryacme.com"], provider: "microsoft", tenantId, pool: "active", vendor: "hypertide" });
    expect(r.data.errors.map((e: any) => e.name)).toEqual(["acme.com", "mail.acme.com"]);
    expect(r.data.created.length).toBe(2);
    activeDomainId = r.data.created.find((d: any) => d.name === "getacme.com").id;
    const tryId = r.data.created.find((d: any) => d.name === "tryacme.com").id;
    await api("POST", `/api/domains/${tryId}/pool`, { pool: "reserve" });
    reserveDomainId = tryId;
  });

  it("enforces mailbox limits per domain (rule 4)", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ firstName: `p${i}` }));
    expect((await api("POST", `/api/domains/${activeDomainId}/mailboxes`, { personas: tooMany })).status).toBe(400);
    const ok = Array.from({ length: 10 }, (_, i) => ({ firstName: `Rep${i}`, lastName: "Smith" }));
    expect((await api("POST", `/api/domains/${activeDomainId}/mailboxes`, { personas: ok })).status).toBe(200);
    expect((await api("POST", `/api/domains/${reserveDomainId}/mailboxes`, { personas: ok })).status).toBe(200);
    const detail = await api("GET", `/api/domains/${activeDomainId}`);
    expect(detail.data.capacity).toBe(30);
  });

  it("blocks warmup until SPF/DKIM/DMARC and a header test pass (rule 5)", async () => {
    let r = await api("POST", `/api/domains/${activeDomainId}/start-warmup`, {});
    expect(r.status).toBe(409);
    r = await api("POST", `/api/domains/${activeDomainId}/check-dns`, {});
    expect(r.data.pass).toBe(true);
    r = await api("POST", `/api/domains/${activeDomainId}/header-test`, {
      raw: "Authentication-Results: mx.google.com; dkim=pass header.i=@getacme.com; spf=pass smtp.mailfrom=rep0@getacme.com; dmarc=fail header.from=getacme.com\nFrom: Rep <rep0@getacme.com>",
    });
    expect(r.data.pass).toBe(false);
    r = await api("POST", `/api/domains/${activeDomainId}/header-test`, {
      raw: "Authentication-Results: mx.google.com; dkim=pass header.i=@getacme.com; spf=pass smtp.mailfrom=rep0@getacme.com; dmarc=pass header.from=getacme.com\nFrom: Rep <rep0@getacme.com>",
    });
    expect(r.data.pass).toBe(true);
    const d = await api("GET", `/api/domains/${activeDomainId}`);
    expect(d.data.domain.state).toBe("auth_verified");
  });

  it("never starts sending immediately: 14-day warmup gate (rule 6)", async () => {
    let r = await api("POST", `/api/domains/${activeDomainId}/start-warmup`, {});
    expect(r.data.state).toBe("warming");
    await getDb().update(schema.mailboxes).set({ connection: "connected" }).where(eq(schema.mailboxes.workspaceId, workspaceId));
    await runLifecycle(workspaceId);
    expect((await api("GET", `/api/domains/${activeDomainId}`)).data.domain.state).toBe("warming");
    // Backdate warmup 20 days (operator attests warmup ran in another tool).
    await getDb().update(schema.mailboxes).set({ warmupStartedAt: new Date(Date.now() - 20 * 86_400_000) }).where(eq(schema.mailboxes.domainId, activeDomainId));
    await runLifecycle(workspaceId);
    expect((await api("GET", `/api/domains/${activeDomainId}`)).data.domain.state).toBe("active");

    // Reserve domain: warmed and ready, stays in reserve.
    await api("POST", `/api/domains/${reserveDomainId}/check-dns`, {});
    await api("POST", `/api/domains/${reserveDomainId}/header-test`, {
      raw: "Authentication-Results: x; dkim=pass header.d=tryacme.com; spf=pass smtp.mailfrom=tryacme.com; dmarc=pass header.from=tryacme.com\nFrom: a@tryacme.com",
    });
    r = await api("POST", `/api/domains/${reserveDomainId}/start-warmup`, { since: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    expect(r.status).toBe(200);
    await runLifecycle(workspaceId);
    const res = await api("GET", "/api/reserve");
    expect(res.data.coverage[0]).toMatchObject({ provider: "microsoft", activeCapacity: 30, readyReserveCapacity: 30, status: "ok" });
  });

  it("cleans a list: validation, catch-alls, SEG removal, provider mix (rule 8)", async () => {
    const rows = ["email,first_name,company,state"];
    for (let i = 0; i < 300; i++) rows.push(`person${i}@company${i}.com,Pat${i},Company ${i} Inc,NY`);
    rows.push("dupe@company1.com,Dupe,Co,NY", "dupe@company1.com,Dupe,Co,NY", "bad-email,Bad,Co,NY", "x@mailinator.com,Junk,Co,NY");
    const r = await api("POST", "/api/lists", { name: "Test list", csv: rows.join("\n") });
    expect(r.status).toBe(200);
    importId = r.data.id;
    for (let i = 0; i < 100; i++) {
      const s = await api("GET", `/api/lists/${importId}`);
      if (s.data.status !== "processing") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const imp = (await api("GET", `/api/lists/${importId}`)).data;
    expect(imp.status).toBe("done");
    expect(imp.counts.duplicate).toBe(1);
    expect(imp.counts.invalid).toBeGreaterThan(0);
    expect((imp.counts.ready ?? 0) + (imp.counts.catch_all ?? 0)).toBeGreaterThan(200);
    expect(imp.counts.seg_blocked ?? 0).toBeGreaterThan(0);
    expect(imp.validationsSaved).toBeGreaterThan(0);
  });

  it("lints copy and refuses launch until it's clean (rule 9, 10)", async () => {
    const c = await api("POST", "/api/campaigns", { name: "Test campaign", jurisdiction: "us" });
    campaignId = c.data.id;
    let launch = await api("POST", `/api/campaigns/${campaignId}/launch`, {});
    expect(launch.status).toBe(409); // starter copy has [placeholders], no postal address
    await api("PUT", "/api/settings", { postalAddress: "Acme, 1 Main St, Austin TX" });
    const camp = (await api("GET", `/api/campaigns/${campaignId}`)).data;
    const bodies = [
      { subject: "quick question", body: "Hi {{firstName|there}},\n\nWe help ops teams at {{company|companies like yours}} cut scheduling time in half.\n\nNot relevant? Reply 'no' and I won't follow up.\n\nInterested?" },
      { subject: "", body: "Hi {{firstName|there}}, one more thought on scheduling.\n\nNot relevant? Reply 'no'.\n\nWorth a chat?", standaloneBody: "Hi {{firstName|there}},\n\nWe help ops teams cut scheduling time in half.\n\nNot relevant? Reply 'no' and I won't follow up.\n\nWorth a chat?" },
      { subject: "", body: "Hi {{firstName|there}}, should I close the loop? If not, reply 'no' and I won't follow up.\n\nOpen to it?" },
    ];
    for (const [i, s] of camp.steps.entries()) {
      const v = s.variants[0];
      const upd = await api("PUT", `/api/variants/${v.id}`, bodies[i]);
      expect(upd.status).toBe(200);
    }
    const linkTry = await api("POST", "/api/lint", { subject: "hi", body: "see https://acme.com <img src=x>", isFirstTouch: true });
    expect(linkTry.data.blocks).toBeGreaterThanOrEqual(2);
    const camp2 = (await api("GET", `/api/campaigns/${campaignId}`)).data;
    for (const s of camp2.steps) for (const v of s.variants) await api("PUT", `/api/variants/${v.id}`, { acknowledgedWarnings: v.lint.findings.map((f: any) => f.rule) });
    const enroll = await api("POST", `/api/campaigns/${campaignId}/enroll`, { importIds: [importId] });
    expect(enroll.data.enrolled).toBeGreaterThan(100);
    launch = await api("POST", `/api/campaigns/${campaignId}/launch`, {});
    expect(launch.status).toBe(200);
  });

  it("plans staggered sends within caps and sends through the pre-flight guard (rules 4, 11)", async () => {
    // Plan for a fixed weekday morning in New York.
    const monday = new Date("2026-11-16T13:30:00Z"); // 08:30 ET
    await getDb().update(schema.domains).set({ authVerifiedAt: monday }).where(eq(schema.domains.workspaceId, workspaceId));
    const p = await planWorkspace(workspaceId, monday);
    expect(p.planned).toBe(30); // 10 mailboxes × 3, domain cap 30
    const planned = await getDb().select().from(schema.sends).where(and(eq(schema.sends.workspaceId, workspaceId), eq(schema.sends.status, "scheduled")));
    const firstByMailbox = new Map<string, number>();
    for (const s of planned) {
      const t = s.scheduledAt.getTime();
      if (!firstByMailbox.has(s.mailboxId) || t < firstByMailbox.get(s.mailboxId)!) firstByMailbox.set(s.mailboxId, t);
    }
    expect(new Set(firstByMailbox.values()).size).toBeGreaterThan(5); // inboxes don't all fire at once
    // Planning again adds nothing: caps are full.
    expect((await planWorkspace(workspaceId, monday)).planned).toBe(0);

    const end = new Date("2026-11-16T22:00:00Z");
    const s = await runSender(end, 500);
    expect(s.sent).toBe(30);
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.sends).where(and(eq(schema.sends.status, "sent"), eq(schema.sends.kind, "first_touch")));
    expect(n).toBe(30);
    const sentRows = await getDb().select().from(schema.sends).where(eq(schema.sends.status, "sent"));
    for (const r of sentRows) expect(r.body).not.toMatch(/https?:|<img|<a /);
  });

  it("refuses to send from a protected domain even if a row slipped in (I-1)", async () => {
    const [mb] = await getDb().select().from(schema.mailboxes).where(eq(schema.mailboxes.domainId, activeDomainId)).limit(1);
    await getDb().update(schema.domains).set({ name: "news.acme.com" }).where(eq(schema.domains.id, activeDomainId));
    await getDb().insert(schema.sends).values({ workspaceId, kind: "seed", mailboxId: mb.id, domainId: activeDomainId, toAddress: "x@y.com", scheduledAt: new Date(), localDate: "2026-11-17", subject: "s", body: "b" });
    await runSender(new Date(), 10);
    const [row] = await getDb().select().from(schema.sends).where(eq(schema.sends.toAddress, "x@y.com"));
    expect(row.status).toBe("skipped");
    expect(row.skipReasons).toContain("PROTECTED_DOMAIN");
    await getDb().update(schema.domains).set({ name: "getacme.com" }).where(eq(schema.domains.id, activeDomainId));
  });

  it("ingests replies and bounces into threads and suppressions", async () => {
    const r = await syncWorkspace(workspaceId);
    const threads = await api("GET", "/api/threads?filter=all");
    const [{ n: bounced }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.sends).where(eq(schema.sends.bounceType, "hard"));
    const [{ n: sup }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.suppressions).where(eq(schema.suppressions.reason, "hard_bounce"));
    expect(sup).toBe(bounced);
    expect(r.mailboxes).toBeGreaterThan(0);
    expect(Array.isArray(threads.data.threads)).toBe(true);
  });

  it("flags a burning domain, diagnoses INFRA, and rotates without stopping (rules 12–14)", async () => {
    // Fabricate 1,000 mature sends with a burned profile on the active domain.
    const [mb] = await getDb().select().from(schema.mailboxes).where(eq(schema.mailboxes.domainId, activeDomainId)).limit(1);
    const base = Date.now() - 5 * 86_400_000;
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      workspaceId,
      kind: "first_touch" as const,
      mailboxId: mb.id,
      domainId: activeDomainId,
      toAddress: `h${i}@x.com`,
      scheduledAt: new Date(base + i * 60_000),
      localDate: "2026-11-01",
      status: "sent" as const,
      sentAt: new Date(base + i * 60_000),
      replyKind: i < 5 ? ("human" as const) : null,
      bounceType: i >= 960 ? ("hard" as const) : null,
      bounceCategory: i >= 960 ? ("policy_or_spam_block" as const) : null,
    }));
    await getDb().update(schema.domains).set({ activatedAt: new Date(base - 86_400_000), lastResumeAt: null, authVerifiedAt: new Date() }).where(eq(schema.domains.id, activeDomainId));
    for (let i = 0; i < rows.length; i += 250) await getDb().insert(schema.sends).values(rows.slice(i, i + 250));
    const ws = await getDb().select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await getDb().update(schema.workspaces).set({ settings: { ...ws[0].settings, simProfiles: { "getacme.com": { replyRate: 0.004, bounceRate: 0.05, placement: "burned" } } } as any }).where(eq(schema.workspaces.id, workspaceId));

    await evaluateWorkspaceHealth(workspaceId);
    let d = (await api("GET", `/api/domains/${activeDomainId}`)).data.domain;
    expect(d.healthVerdict).toBe("red");
    expect(d.state).toBe("flagged");

    // Rotation is refused before diagnosis (rule 13).
    const early = await api("POST", "/api/rotations", { domainId: activeDomainId });
    expect(early.status).toBe(409);

    const diags = (await api("GET", "/api/diagnoses")).data;
    const diagId = diags[0].diagnosis.id;
    // Seeds: two connected seed mailboxes on a separate simulated domain.
    const seedDom = await api("POST", "/api/domains", { names: ["seedbox.net"], provider: "microsoft", tenantId, pool: "reserve" });
    const sd = seedDom.data.created[0].id;
    const sm = await api("POST", `/api/domains/${sd}/mailboxes`, { personas: [{ firstName: "seed1" }, { firstName: "seed2" }] });
    for (const m of sm.data) await api("PATCH", `/api/mailboxes/${m.id}`, { isSeed: true });
    await getDb().update(schema.mailboxes).set({ connection: "connected" }).where(eq(schema.mailboxes.domainId, sd));

    const test = await api("POST", `/api/diagnoses/${diagId}/start-test`, {});
    expect(test.status).toBe(200);
    await getDb().update(schema.sends).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.sends.diagnosisId, diagId));
    await runSender(new Date(), 100);
    // Age the seed sends past the 4h window so messages that never arrived count as "missing".
    await getDb().update(schema.sends).set({ sentAt: new Date(Date.now() - 5 * 3_600_000) }).where(eq(schema.sends.diagnosisId, diagId));
    await runLifecycle(workspaceId);
    const det = (await api("GET", `/api/diagnoses/${diagId}`)).data;
    expect(det.diagnosis.verdict).toBe("INFRA");

    const applied = await api("POST", `/api/diagnoses/${diagId}/apply`, {});
    expect(applied.data.rotationId).toBeTruthy();
    const exec = await api("POST", `/api/rotations/${applied.data.rotationId}/execute`, {});
    expect(exec.status).toBe(200);
    expect(exec.data.mode).toBe("immediate");

    d = (await api("GET", `/api/domains/${activeDomainId}`)).data.domain;
    expect(d.state).toBe("relay");
    const rep = (await api("GET", `/api/domains/${reserveDomainId}`)).data.domain;
    expect(rep.state).toBe("active");
    expect(rep.pool).toBe("active");
    // Replenishment order created.
    const reserve = (await api("GET", "/api/reserve")).data;
    expect(reserve.orders.length).toBe(1);
    // Relay mailboxes are still synced (replies preserved).
    const relayMbs = await getDb().select().from(schema.mailboxes).where(eq(schema.mailboxes.domainId, activeDomainId));
    expect(relayMbs.every((m) => m.state === "relay")).toBe(true);
  });

  it("records an audit trail", async () => {
    const audit = (await api("GET", "/api/audit")).data;
    const actions = new Set(audit.map((a: any) => a.action));
    for (const a of ["workspace.created", "domains.added", "header_test", "campaign.launched", "rotation.executed"]) expect(actions.has(a)).toBe(true);
  });
});
