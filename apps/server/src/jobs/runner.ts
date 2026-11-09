/**
 * In-process job scheduler. Run exactly one instance with jobs enabled
 * (Azure Container Apps: min = max = 1 replica, or JOBS_ENABLED=false on extra replicas).
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { listWorkspaceIds } from "../services/common";
import { planWorkspace, runSender } from "../services/sending";
import { syncWorkspace } from "../services/inbox";
import { runLifecycle, testConnections } from "../services/lifecycle";
import { evaluateWorkspaceHealth } from "../services/health";
import { resumeStuckImports } from "../services/lists";

type JobFn = (now: Date) => Promise<unknown>;

const perWorkspace =
  (fn: (ws: string, now: Date) => Promise<unknown>): JobFn =>
  async (now) => {
    const out: Record<string, unknown> = {};
    for (const ws of await listWorkspaceIds()) {
      try {
        out[ws] = await fn(ws, now);
      } catch (e: any) {
        out[ws] = { error: String(e?.message ?? e) };
        console.error(`[job] workspace ${ws}:`, e);
      }
    }
    return out;
  };

export const JOBS: { name: string; label: string; everyMs: number; run: JobFn }[] = [
  { name: "sender", label: "Send due emails (pre-flight guard + caps)", everyMs: 30_000, run: (now) => runSender(now) },
  { name: "planner", label: "Plan staggered sends", everyMs: 5 * 60_000, run: perWorkspace(planWorkspace) },
  { name: "inbox", label: "Sync inboxes (replies, bounces)", everyMs: 2 * 60_000, run: perWorkspace(syncWorkspace) },
  { name: "lifecycle", label: "Warmup gates, DNS, seeds, rotations", everyMs: 5 * 60_000, run: perWorkspace(runLifecycle) },
  { name: "health", label: "Evaluate domain health", everyMs: 60 * 60_000, run: perWorkspace(evaluateWorkspaceHealth) },
  { name: "connections", label: "Test new mailbox connections", everyMs: 15 * 60_000, run: perWorkspace((ws) => testConnections(ws)) },
  { name: "imports", label: "Resume list imports", everyMs: 10 * 60_000, run: () => resumeStuckImports() },
];

const running = new Set<string>();
const timers: NodeJS.Timeout[] = [];

export async function runJob(name: string, now = new Date()) {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown job ${name}`);
  if (running.has(name)) return { skipped: "already running" };
  running.add(name);
  const t0 = Date.now();
  const db = getDb();
  try {
    const result = await job.run(now);
    await db
      .insert(schema.jobRuns)
      .values({ name, lastRunAt: new Date(), lastStatus: "ok", lastError: null, lastDurationMs: Date.now() - t0 })
      .onConflictDoUpdate({ target: schema.jobRuns.name, set: { lastRunAt: new Date(), lastStatus: "ok", lastError: null, lastDurationMs: Date.now() - t0 } });
    return result;
  } catch (e: any) {
    console.error(`[job] ${name} failed:`, e);
    await db
      .insert(schema.jobRuns)
      .values({ name, lastRunAt: new Date(), lastStatus: "error", lastError: String(e?.message ?? e).slice(0, 1000), lastDurationMs: Date.now() - t0 })
      .onConflictDoUpdate({ target: schema.jobRuns.name, set: { lastRunAt: new Date(), lastStatus: "error", lastError: String(e?.message ?? e).slice(0, 1000), lastDurationMs: Date.now() - t0 } });
    return { error: String(e?.message ?? e) };
  } finally {
    running.delete(name);
  }
}

export function startJobs() {
  for (const [i, job] of JOBS.entries()) {
    // Stagger first runs so boot isn't a thundering herd.
    timers.push(
      setTimeout(() => {
        void runJob(job.name);
        timers.push(setInterval(() => void runJob(job.name), job.everyMs));
      }, 3_000 + i * 1_500),
    );
  }
  console.log(`[jobs] started ${JOBS.length} jobs`);
}

export function stopJobs() {
  for (const t of timers) clearTimeout(t), clearInterval(t);
  timers.length = 0;
}

export async function jobStatus() {
  const rows = await getDb().select().from(schema.jobRuns);
  return JOBS.map((j) => ({ name: j.name, label: j.label, everyMs: j.everyMs, running: running.has(j.name), ...(rows.find((r) => r.name === j.name) ?? {}) }));
}

export { eq };
