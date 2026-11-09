import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config";
import { HttpError } from "./lib/http";
import { authenticate } from "./services/auth";
import { coreRoutes } from "./routes/core";
import { infraRoutes } from "./routes/infra";
import { outreachRoutes } from "./routes/outreach";
import { opsRoutes } from "./routes/ops";

function publicDir(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [config.publicDir, join(here, "public"), resolve(here, "../../web/dist"), resolve(process.cwd(), "apps/web/dist")].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(join(c, "index.html"))) ?? null;
}

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 60 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    if (!req.url.startsWith("/api/")) return;
    // CSRF: mutating API calls must carry a custom header. Browsers can't add one cross-site
    // without a CORS preflight, and Cold never enables CORS.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers["x-cold-csrf"] !== "1") {
      return reply.code(403).send({ error: "Missing X-Cold-CSRF header" });
    }
    req.auth = await authenticate(req.cookies["cold_session"]);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Invalid input", details: err.issues });
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    req.log.error(err);
    console.error(err);
    return reply.code(500).send({ error: "Something went wrong on our side", details: config.production ? undefined : String(err?.message ?? err) });
  });

  app.get("/healthz", async () => ({ ok: true }));
  await app.register(coreRoutes);
  await app.register(infraRoutes);
  await app.register(outreachRoutes);
  await app.register(opsRoutes);

  const dir = publicDir();
  if (dir) {
    await app.register(fastifyStatic, { root: dir, wildcard: true, maxAge: "1h" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/html").sendFile("index.html", { maxAge: 0 });
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "Not found" }));
  }
  return app;
}
