/** First-run setup on a public URL requires SETUP_TOKEN. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "cold-setup-"));
process.env.APP_SECRET = "test-secret-test-secret-test-secret-123";
process.env.SETUP_TOKEN = "let-me-in-please-0123456789";

const { initDb, closeDb } = await import("../src/db/client");
const { buildApp } = await import("../src/app");
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await initDb({ url: null, memory: true });
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const body = { name: "N", email: "owner@cleargraph.co", password: "correct-horse-battery", workspaceName: "Cleargraph", primaryDomain: "cleargraph.co" };
const post = (payload: object) => app.inject({ method: "POST", url: "/api/auth/setup", headers: { "x-cold-csrf": "1", "content-type": "application/json" }, payload: JSON.stringify(payload) });

describe("setup token", () => {
  it("advertises that a token is required", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/state" });
    expect(JSON.parse(res.body)).toMatchObject({ needsSetup: true, setupTokenRequired: true });
  });
  it("refuses setup without the right token", async () => {
    expect((await post(body)).statusCode).toBe(403);
    expect((await post({ ...body, setupToken: "wrong" })).statusCode).toBe(403);
  });
  it("accepts the right token once", async () => {
    expect((await post({ ...body, setupToken: process.env.SETUP_TOKEN })).statusCode).toBe(200);
    expect((await post({ ...body, setupToken: process.env.SETUP_TOKEN })).statusCode).toBe(403);
  });
});
