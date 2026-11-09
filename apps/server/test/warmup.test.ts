/** Built-in warmup end to end with simulated Microsoft + Google tenants. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "cold-warmup-"));
process.env.SIM_DELAY_MINUTES = "0";
process.env.APP_SECRET = "test-secret-test-secret-test-secret-123";

const { initDb, closeDb, getDb, schema } = await import("../src/db/client");
const { buildApp } = await import("../src/app");
const { runSender } = await import("../src/services/sending");
const { syncWorkspace } = await import("../src/services/inbox");
const { planWarmup, updateWarmupRates } = await import("../src/services/warmup");
const { eq, and, sql } = await import("drizzle-orm");

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
let ws = "";
async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, headers: { cookie, "x-cold-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers["set-cookie"];
  if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

beforeAll(async () => {
  await initDb({ url: null, memory: true });
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("built-in warmup", () => {
  const monday9 = new Date("2026-11-16T14:00:00Z"); // 09:00 New York
  const endOfDay = new Date("2026-11-16T23:59:00Z");

  it("sets up two tenants with authenticated, warming domains", async () => {
    await api("POST", "/api/auth/setup", { name: "N", email: "o@cleargraph.co", password: "correct-horse-battery", workspaceName: "Cleargraph", primaryDomain: "cleargraph.co" });
    ws = (await api("GET", "/api/auth/state")).data.user.workspaceId;
    await api("PUT", "/api/integrations", { simulation: true });
    const ms = (await api("POST", "/api/tenants", { name: "MS", provider: "microsoft", transport: "simulated" })).data;
    const gw = (await api("POST", "/api/tenants", { name: "GW", provider: "google", transport: "simulated" })).data;
    const gw2 = (await api("POST", "/api/tenants", { name: "GW2", provider: "google", transport: "simulated" })).data;
    const mk = async (name: string, provider: string, tenantId: string, people: string[]) => {
      const d = (await api("POST", "/api/domains", { names: [name], provider, tenantId, pool: "reserve" })).data.created[0];
      await api("POST", `/api/domains/${d.id}/mailboxes`, { personas: people.map((firstName) => ({ firstName })) });
      await api("POST", `/api/domains/${d.id}/check-dns`, {});
      await api("POST", `/api/domains/${d.id}/header-test`, { raw: `Authentication-Results: x; dkim=pass header.d=${name}; spf=pass smtp.mailfrom=${name}; dmarc=pass header.from=${name}\nFrom: a@${name}` });
      const w = await api("POST", `/api/domains/${d.id}/start-warmup`, { since: new Date(monday9.getTime() - 20 * 86_400_000).toISOString() });
      expect(w.status).toBe(200);
      return d.id as string;
    };
    await mk("getclear.com", "microsoft", ms.id, ["ana", "ben", "cara", "dev"]);
    await mk("tryclear.com", "microsoft", ms.id, ["eli", "fay", "gus", "hal"]);
    await mk("clearhq.com", "google", gw.id, ["ivy", "jon", "kim"]);
    await mk("meetclear.com", "google", gw2.id, ["lea", "max", "ned"]);
    await getDb().update(schema.mailboxes).set({ connection: "connected" }).where(eq(schema.mailboxes.workspaceId, ws));
    await getDb().update(schema.domains).set({ authVerifiedAt: monday9 }).where(eq(schema.domains.workspaceId, ws));
  });

  it("plans ramped warmup only across tenants, never inside one", async () => {
    const r = await planWarmup(ws, monday9);
    // Each inbox emails each eligible inbox at most once a day:
    // 8 Microsoft inboxes → 6 Google inboxes each; 6 Google inboxes → min(20, 8 + 3) each.
    expect(r.planned).toBe(8 * 6 + 6 * 11);
    const rows = await getDb().select().from(schema.sends).where(and(eq(schema.sends.workspaceId, ws), eq(schema.sends.kind, "warmup")));
    const mbs = await getDb().select().from(schema.mailboxes).where(eq(schema.mailboxes.workspaceId, ws));
    const byAddr = new Map(mbs.map((m) => [m.address, m]));
    const byId = new Map(mbs.map((m) => [m.id, m]));
    for (const s of rows) {
      const from = byId.get(s.mailboxId)!;
      const to = byAddr.get(s.toAddress)!;
      expect(to.tenantId).not.toBe(from.tenantId);
      expect(s.body).not.toMatch(/https?:|www\./);
    }
    const perMb = (addr: string) => rows.filter((s) => s.mailboxId === byAddr.get(addr)!.id).length;
    expect(perMb("ana@getclear.com")).toBe(6);
    expect(perMb("ivy@clearhq.com")).toBe(11);
    expect((await planWarmup(ws, monday9)).planned).toBe(0); // idempotent
  });

  it("sends warmup without touching cold-email caps", async () => {
    const r = await runSender(endOfDay, 1000);
    expect(r.sent).toBe(114);
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.capCounters);
    expect(n).toBe(0);
  });

  it("receivers record placement, engage and reply, and nothing reaches the inbox UI", async () => {
    await syncWorkspace(ws);
    const placed = await getDb().select().from(schema.sends).where(and(eq(schema.sends.kind, "warmup"), sql`${schema.sends.placement} is not null`));
    expect(placed.length).toBe(114);
    const replies = await getDb().select().from(schema.sends).where(and(eq(schema.sends.kind, "warmup"), sql`${schema.sends.warmupDepth} = 1`));
    expect(replies.length).toBeGreaterThan(5);
    expect(replies.every((r) => r.inReplyTo && r.subject?.startsWith("Re: "))).toBe(true);
    // Re-syncing must not schedule duplicate replies.
    await syncWorkspace(ws);
    const again = await getDb().select().from(schema.sends).where(and(eq(schema.sends.kind, "warmup"), sql`${schema.sends.warmupDepth} = 1`));
    expect(again.length).toBe(replies.length);
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.threads);
    expect(n).toBe(0);
  });

  it("computes warmup inbox rates that feed the Ready gate", async () => {
    // Day two.
    const tue9 = new Date("2026-11-17T14:00:00Z");
    await getDb().update(schema.domains).set({ authVerifiedAt: tue9 }).where(eq(schema.domains.workspaceId, ws));
    expect((await planWarmup(ws, tue9)).planned).toBe(114);
    await runSender(new Date("2026-11-17T23:59:00Z"), 1000);
    await syncWorkspace(ws);
    await updateWarmupRates(ws, new Date("2026-11-18T00:30:00Z"));
    const mbs = await getDb().select().from(schema.mailboxes).where(eq(schema.mailboxes.workspaceId, ws));
    const rated = mbs.filter((m) => m.warmupInboxRate != null);
    expect(rated.length).toBe(mbs.length);
    for (const m of rated) expect(m.warmupInboxRate!).toBeGreaterThan(0.8);
    const overview = (await api("GET", "/api/warmup")).data;
    expect(overview.engine).toBe("cold");
    expect(overview.pool.canRun).toBe(true);
    expect(overview.last7d.inboxRate).toBeGreaterThan(0.8);
  });

  it("stays out of the way when warmup runs in another tool", async () => {
    await api("PUT", "/api/settings", { warmupEngine: "external" });
    expect((await planWarmup(ws, new Date("2026-11-17T14:00:00Z"))).planned).toBe(0);
  });
});
