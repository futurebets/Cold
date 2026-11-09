import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? "./data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

function appSecret(): string {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (env.NODE_ENV === "production") throw new Error("APP_SECRET (≥32 chars) is required in production");
  const file = join(dataDir, ".app-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(32).toString("hex");
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

if (env.NODE_ENV === "production" && !env.DATABASE_URL && env.ALLOW_EMBEDDED_DB !== "true") {
  // Container disks (Cloudflare, Azure, etc.) are wiped on restart; refuse to run on a throwaway database.
  throw new Error("DATABASE_URL is required in production (set ALLOW_EMBEDDED_DB=true only for a persistent single-machine install)");
}

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? "0.0.0.0",
  production: env.NODE_ENV === "production",
  databaseUrl: env.DATABASE_URL || null,
  dataDir,
  appSecret: appSecret(),
  appUrl: env.APP_URL ?? `http://localhost:${env.PORT ?? 8080}`,
  jobsEnabled: env.JOBS_ENABLED !== "false",
  /** Seeds a demo workspace with simulated mailboxes on first boot. */
  demo: env.DEMO === "true",
  publicDir: env.PUBLIC_DIR ?? null,
  /** Required to complete first-run setup on a public URL (production). */
  setupToken: env.SETUP_TOKEN || null,
};
