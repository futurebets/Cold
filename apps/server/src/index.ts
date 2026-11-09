import { config } from "./config";
import { closeDb, dbKind, initDb } from "./db/client";
import { buildApp } from "./app";
import { startJobs, stopJobs } from "./jobs/runner";
import { needsSetup } from "./services/auth";
import { seedDemo, DEMO_LOGIN } from "./demo/seed";

async function main() {
  await initDb();
  console.log(`[db] ${dbKind === "postgres" ? "PostgreSQL" : `embedded PGlite at ${config.dataDir}/pglite`}`);
  if (config.demo && (await needsSetup())) {
    console.log("[demo] seeding demo workspace…");
    await seedDemo();
    console.log(`[demo] sign in with ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
  }
  const app = await buildApp({ logger: false });
  await app.listen({ port: config.port, host: config.host });
  console.log(`[http] Cold listening on http://localhost:${config.port}`);
  if (config.jobsEnabled) startJobs();

  const shutdown = async () => {
    stopJobs();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
