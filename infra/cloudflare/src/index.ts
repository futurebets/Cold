/**
 * Cloudflare Worker that fronts the Cold container.
 *
 * - Every HTTP request goes to a single named container instance ("cold").
 * - A cron trigger pings it every 5 minutes. Cold runs its own background jobs (sender,
 *   planner, inbox sync, health, rotation timers), so it must stay up; the ping restarts it
 *   within 5 minutes if it ever stops, and keeps it from hitting the idle timeout.
 * - Secrets (DATABASE_URL, APP_SECRET) are Worker secrets passed into the container's env.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  COLD: DurableObjectNamespace<ColdContainer>;
  DATABASE_URL: string;
  APP_SECRET: string;
  SETUP_TOKEN?: string;
}

export class ColdContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true; // Microsoft Graph, Gmail API, validation vendors, Postgres

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      APP_URL: "https://cold.cleargraph.co",
      DATABASE_URL: env.DATABASE_URL,
      APP_SECRET: env.APP_SECRET,
      ...(env.SETUP_TOKEN ? { SETUP_TOKEN: env.SETUP_TOKEN } : {}),
    };
  }
}

const cold = (env: Env) => getContainer(env.COLD, "cold");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return cold(env).fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cold(env)
        .fetch(new Request("https://cold.internal/healthz"))
        .then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
