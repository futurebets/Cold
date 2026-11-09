import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { config } from "../config";

export type DB = NodePgDatabase<typeof schema>;
export { schema };

let db: DB | null = null;
let closeFn: (() => Promise<void>) | null = null;
export let dbKind: "postgres" | "pglite" = "pglite";

function migrationsFolder(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [join(here, "drizzle"), join(here, "../../drizzle"), join(process.cwd(), "drizzle"), join(process.cwd(), "apps/server/drizzle")];
  const found = candidates.find((c) => existsSync(join(c, "meta/_journal.json")));
  if (!found) throw new Error("Migrations folder not found");
  return found;
}

/** Connect (Postgres when DATABASE_URL is set, otherwise embedded PGlite) and run migrations. */
export async function initDb(opts: { url?: string | null; memory?: boolean } = {}): Promise<DB> {
  const url = opts.url !== undefined ? opts.url : config.databaseUrl;
  if (url) {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    // TLS: honour sslmode in the URL ourselves so certificate verification stays on by default
    // (Azure Database for PostgreSQL certificates chain to public roots Node already trusts).
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get("sslmode");
    parsed.searchParams.delete("sslmode");
    const ssl = sslmode && sslmode !== "disable" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined;
    const pool = new pg.default.Pool({ connectionString: parsed.toString(), max: 10, ssl });
    const d = drizzle(pool, { schema });
    await migrate(d, { migrationsFolder: migrationsFolder() });
    db = d;
    dbKind = "postgres";
    closeFn = () => pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = opts.memory ? new PGlite() : new PGlite(join(config.dataDir, "pglite"));
    const d = drizzle(client, { schema });
    await migrate(d, { migrationsFolder: migrationsFolder() });
    db = d as unknown as DB;
    dbKind = "pglite";
    closeFn = () => client.close();
  }
  return db!;
}

export function getDb(): DB {
  if (!db) throw new Error("Database not initialized");
  return db;
}

export async function closeDb() {
  await closeFn?.();
  db = null;
}
