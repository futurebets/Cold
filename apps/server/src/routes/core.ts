/** Auth, workspace settings, policies, integrations, team, overview, alerts, audit, system, planner. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { checkOverride, compareProviders, isValidDomainName, normalizeDomain, offPlaybookKeys, POLICY_DEFS, resolvePolicies, suggestDomainNames } from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, notFound } from "../lib/http";
import { config } from "../config";
import { checkAvailability, testCloudflare } from "../adapters/external";
import * as auth from "../services/auth";
import { audit, getWorkspace, hasSecret, setSecret, setTenantSecret, tenantHasSecret } from "../services/common";
import { overview, reserveView, setupChecklist } from "../services/overview";
import { jobStatus, runJob } from "../jobs/runner";
import { ctx, idParam, parse, z } from "./helpers";

const { workspaces, protectedDomains, alerts, auditEvents, tenants, provisioningOrders, controlMessages } = schema;
const COOKIE = "cold_session";

export async function coreRoutes(app: FastifyInstance) {
  // ───────────── Auth ─────────────
  app.get("/api/auth/state", async (req) => ({ needsSetup: await auth.needsSetup(), demo: config.demo, user: req.auth ? { ...req.auth.user, role: req.auth.role, workspaceId: req.auth.workspaceId } : null }));

  const setCookie = (reply: any, token: string, maxAge: number) =>
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.production, maxAge });

  app.post("/api/auth/setup", async (req, reply) => {
    const body = parse(
      z.object({ name: z.string().min(1), email: z.string().email(), password: z.string(), workspaceName: z.string().min(1), primaryDomain: z.string().min(3), timezone: z.string().optional() }),
      req.body,
    );
    const s = await auth.setup(body);
    setCookie(reply, s.token, s.maxAge);
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const s = await auth.login(body.email, body.password);
    setCookie(reply, s.token, s.maxAge);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await auth.logout(token);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/password", async (req) => {
    const c = ctx(req);
    const body = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    await auth.changePassword(c.user.id, body.current, body.next);
    return { ok: true };
  });

  // ───────────── Overview ─────────────
  app.get("/api/overview", async (req) => overview(ctx(req).workspaceId));
  app.get("/api/checklist", async (req) => setupChecklist(ctx(req).workspaceId));
  app.get("/api/reserve", async (req) => reserveView(ctx(req).workspaceId));

  // ───────────── Workspace settings ─────────────
  app.get("/api/settings", async (req) => {
    const c = ctx(req);
    const ws = await getWorkspace(c.workspaceId);
    const prot = await getDb().select().from(protectedDomains).where(eq(protectedDomains.workspaceId, c.workspaceId));
    const ctrl = await getDb().select().from(controlMessages).where(eq(controlMessages.workspaceId, c.workspaceId));
    return { workspace: { id: ws.id, name: ws.name, timezone: ws.timezone, settings: ws.settings }, protectedDomains: prot, controlMessages: ctrl, role: c.role, user: c.user };
  });

  app.put("/api/settings", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(
      z.object({
        name: z.string().min(1).optional(),
        timezone: z.string().optional(),
        postalAddress: z.string().max(300).optional(),
        dmarcRua: z.string().email().or(z.literal("")).optional(),
        warmupPattern: z.string().max(200).optional(),
        onboardingDismissed: z.boolean().optional(),
        prices: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      }),
      req.body,
    );
    const ws = await getWorkspace(c.workspaceId);
    const settings = { ...ws.settings };
    for (const k of ["postalAddress", "dmarcRua", "warmupPattern", "onboardingDismissed", "prices"] as const) if (body[k] !== undefined) (settings as any)[k] = body[k];
    await getDb()
      .update(workspaces)
      .set({ ...(body.name ? { name: body.name } : {}), ...(body.timezone ? { timezone: body.timezone } : {}), settings })
      .where(eq(workspaces.id, c.workspaceId));
    await audit(c.workspaceId, c.actor, "settings.updated", null, body as Record<string, unknown>);
    return { ok: true };
  });

  app.post("/api/protected-domains", async (req) => {
    const c = ctx(req, "operator");
    const { domain } = parse(z.object({ domain: z.string() }), req.body);
    const d = normalizeDomain(domain);
    if (!isValidDomainName(d)) throw badRequest("Not a valid domain");
    await getDb().insert(protectedDomains).values({ workspaceId: c.workspaceId, domain: d }).onConflictDoNothing();
    await audit(c.workspaceId, c.actor, "protected_domain.added", null, { domain: d });
    return { ok: true };
  });

  app.delete("/api/protected-domains/:id", async (req) => {
    const c = ctx(req, "owner");
    const { id } = parse(idParam, req.params);
    const all = await getDb().select().from(protectedDomains).where(eq(protectedDomains.workspaceId, c.workspaceId));
    if (all.length <= 1) throw badRequest("Keep at least one protected primary domain");
    await getDb().delete(protectedDomains).where(and(eq(protectedDomains.workspaceId, c.workspaceId), eq(protectedDomains.id, id)));
    await audit(c.workspaceId, c.actor, "protected_domain.removed", null, { id });
    return { ok: true };
  });

  app.put("/api/control-messages/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ subject: z.string().min(1), body: z.string().min(1) }), req.body);
    await getDb().update(controlMessages).set(body).where(and(eq(controlMessages.workspaceId, c.workspaceId), eq(controlMessages.id, id)));
    return { ok: true };
  });

  // ───────────── Policies (§14) ─────────────
  app.get("/api/policies", async (req) => {
    const c = ctx(req);
    const ws = await getWorkspace(c.workspaceId);
    return { defs: POLICY_DEFS, overrides: ws.policies, effective: resolvePolicies(ws.policies), offPlaybook: offPlaybookKeys(ws.policies) };
  });

  app.put("/api/policies/:key", async (req) => {
    const c = ctx(req, "operator");
    const { key } = parse(z.object({ key: z.string() }), req.params);
    const body = parse(z.object({ value: z.any(), reason: z.string().optional(), reset: z.boolean().optional() }), req.body);
    const ws = await getWorkspace(c.workspaceId);
    const next = { ...ws.policies };
    if (body.reset) delete next[key];
    else {
      const check = checkOverride(key, body.value, c.role);
      if (!check.ok) throw badRequest(check.error ?? "Not allowed");
      if (check.requiresReason && !body.reason?.trim()) throw badRequest("Loosening a playbook limit needs a written reason");
      next[key] = body.value;
    }
    await getDb().update(workspaces).set({ policies: next }).where(eq(workspaces.id, c.workspaceId));
    await audit(c.workspaceId, c.actor, body.reset ? "policy.reset" : "policy.changed", null, { key, value: body.value }, body.reason);
    return { ok: true };
  });

  // ───────────── Integrations ─────────────
  app.get("/api/integrations", async (req) => {
    const c = ctx(req);
    const ws = await getWorkspace(c.workspaceId);
    const ts = await getDb().select().from(tenants).where(eq(tenants.workspaceId, c.workspaceId));
    return {
      validationProvider: ws.settings.validationProvider ?? "none",
      validationKey: await hasSecret(c.workspaceId, "validation.apiKey"),
      cloudflare: await hasSecret(c.workspaceId, "cloudflare.token"),
      slack: await hasSecret(c.workspaceId, "slack.webhookUrl"),
      spamhaus: await hasSecret(c.workspaceId, "spamhaus.dqsKey"),
      simulation: !!ws.settings.simulation,
      tenants: await Promise.all(ts.map(async (t) => ({ ...t, hasSecret: await tenantHasSecret(c.workspaceId, t) }))),
    };
  });

  app.put("/api/integrations", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(
      z.object({
        validationProvider: z.enum(["millionverifier", "zerobounce", "none"]).optional(),
        validationKey: z.string().nullable().optional(),
        cloudflareToken: z.string().nullable().optional(),
        slackWebhookUrl: z.string().url().or(z.literal("")).nullable().optional(),
        spamhausDqsKey: z.string().nullable().optional(),
        simulation: z.boolean().optional(),
      }),
      req.body,
    );
    const ws = await getWorkspace(c.workspaceId);
    const settings = { ...ws.settings };
    if (body.validationProvider) settings.validationProvider = body.validationProvider;
    if (body.simulation !== undefined) {
      if (c.role !== "owner") throw badRequest("Only owners can switch simulation mode");
      settings.simulation = body.simulation;
    }
    await getDb().update(workspaces).set({ settings }).where(eq(workspaces.id, c.workspaceId));
    if (body.validationKey !== undefined) await setSecret(c.workspaceId, "validation.apiKey", body.validationKey);
    if (body.cloudflareToken !== undefined) {
      if (body.cloudflareToken) await testCloudflare(body.cloudflareToken).catch((e) => Promise.reject(badRequest(`Cloudflare rejected the token: ${e.message}`)));
      await setSecret(c.workspaceId, "cloudflare.token", body.cloudflareToken);
    }
    if (body.slackWebhookUrl !== undefined) await setSecret(c.workspaceId, "slack.webhookUrl", body.slackWebhookUrl);
    if (body.spamhausDqsKey !== undefined) await setSecret(c.workspaceId, "spamhaus.dqsKey", body.spamhausDqsKey);
    await audit(c.workspaceId, c.actor, "integrations.updated", null, {
      validationProvider: body.validationProvider,
      validationKey: body.validationKey !== undefined ? "updated" : undefined,
      cloudflare: body.cloudflareToken !== undefined ? "updated" : undefined,
      slack: body.slackWebhookUrl !== undefined ? "updated" : undefined,
    });
    return { ok: true };
  });

  // Tenants (Google Workspace / Microsoft 365)
  const tenantBody = z.object({
    name: z.string().min(1),
    provider: z.enum(["google", "microsoft"]),
    vendor: z.enum(["hypertide", "direct", "other"]).default("direct"),
    transport: z.enum(["api", "simulated"]).default("api"),
    config: z.record(z.string(), z.string()).default({}),
    secret: z.string().nullable().optional(),
  });
  app.post("/api/tenants", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(tenantBody, req.body);
    if (body.transport === "api") {
      if (body.provider === "microsoft" && (!body.config.tenantId || !body.config.clientId)) throw badRequest("Microsoft tenants need a Directory (tenant) ID and an Application (client) ID");
      if (body.provider === "google" && body.secret) {
        try {
          const sa = JSON.parse(body.secret);
          if (!sa.client_email || !sa.private_key) throw new Error();
        } catch {
          throw badRequest("Paste the service account's JSON key file contents");
        }
      }
    }
    const [t] = await getDb().insert(tenants).values({ workspaceId: c.workspaceId, name: body.name, provider: body.provider, vendor: body.vendor, transport: body.transport, config: body.config }).returning();
    if (body.secret) await setTenantSecret(c.workspaceId, t, body.secret);
    await audit(c.workspaceId, c.actor, "tenant.added", { type: "tenant", id: t.id }, { name: t.name, provider: t.provider, vendor: t.vendor });
    return t;
  });

  app.put("/api/tenants/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(tenantBody.partial(), req.body);
    const [t] = await getDb().select().from(tenants).where(and(eq(tenants.workspaceId, c.workspaceId), eq(tenants.id, id)));
    if (!t) throw notFound("Tenant not found");
    await getDb()
      .update(tenants)
      .set({ ...(body.name ? { name: body.name } : {}), ...(body.vendor ? { vendor: body.vendor } : {}), ...(body.config ? { config: { ...t.config, ...body.config } } : {}) })
      .where(eq(tenants.id, id));
    if (body.secret !== undefined) await setTenantSecret(c.workspaceId, t, body.secret);
    await getDb().update(schema.mailboxes).set({ connection: "unknown" }).where(eq(schema.mailboxes.tenantId, id));
    await audit(c.workspaceId, c.actor, "tenant.updated", { type: "tenant", id });
    return { ok: true };
  });

  app.delete("/api/tenants/:id", async (req) => {
    const c = ctx(req, "owner");
    const { id } = parse(idParam, req.params);
    await getDb().delete(tenants).where(and(eq(tenants.workspaceId, c.workspaceId), eq(tenants.id, id)));
    await audit(c.workspaceId, c.actor, "tenant.deleted", { type: "tenant", id });
    return { ok: true };
  });

  // ───────────── Team ─────────────
  app.get("/api/team", async (req) => auth.listTeam(ctx(req).workspaceId));
  app.post("/api/team", async (req) => {
    const c = ctx(req, "owner");
    const body = parse(z.object({ email: z.string().email(), name: z.string().default(""), role: z.enum(["owner", "operator", "sdr", "viewer"]) }), req.body);
    return auth.addMember(c.workspaceId, c.actor, body);
  });
  app.put("/api/team/:id", async (req) => {
    const c = ctx(req, "owner");
    const { id } = parse(idParam, req.params);
    const { role } = parse(z.object({ role: z.enum(["owner", "operator", "sdr", "viewer"]) }), req.body);
    await auth.setMemberRole(c.workspaceId, c.actor, id, role);
    return { ok: true };
  });
  app.delete("/api/team/:id", async (req) => {
    const c = ctx(req, "owner");
    const { id } = parse(idParam, req.params);
    await auth.removeMember(c.workspaceId, c.actor, id);
    return { ok: true };
  });

  // ───────────── Alerts & audit ─────────────
  app.get("/api/alerts", async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ status: z.enum(["open", "resolved"]).default("open") }), req.query);
    return getDb().select().from(alerts).where(and(eq(alerts.workspaceId, c.workspaceId), eq(alerts.status, q.status))).orderBy(desc(alerts.createdAt)).limit(200);
  });
  app.post("/api/alerts/:id/resolve", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await getDb().update(alerts).set({ status: "resolved", resolvedAt: new Date() }).where(and(eq(alerts.workspaceId, c.workspaceId), eq(alerts.id, id)));
    return { ok: true };
  });
  app.get("/api/audit", async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ entityId: z.string().optional(), limit: z.coerce.number().default(200) }), req.query);
    return getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, c.workspaceId), ...(q.entityId ? [eq(auditEvents.entityId, q.entityId)] : [])))
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(q.limit, 1000));
  });

  // ───────────── Planner (rules 3, 4, 7) ─────────────
  app.post("/api/planner", async (req) => {
    const c = ctx(req);
    const body = parse(
      z.object({
        targetDaily: z.number().min(0).max(1_000_000),
        includeSaturday: z.boolean().default(false),
        reserveRatio: z.number().min(0).max(3).optional(),
        mailboxesPerDomain: z.number().min(1).max(100).optional(),
        stepsPerSequence: z.number().min(1).max(10).optional(),
        prices: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      }),
      req.body,
    );
    const ws = await getWorkspace(c.workspaceId);
    return compareProviders({ ...body, policies: resolvePolicies(ws.policies), prices: (body.prices ?? ws.settings.prices) as any });
  });

  app.get("/api/domain-suggestions", async (req) => {
    const c = ctx(req, "operator");
    const q = parse(z.object({ brand: z.string().optional(), check: z.coerce.boolean().default(true) }), req.query);
    const prot = await getDb().select().from(protectedDomains).where(eq(protectedDomains.workspaceId, c.workspaceId));
    if (!prot.length) throw badRequest("Add your primary domain first");
    const suggestions = suggestDomainNames(prot[0].domain, { brand: q.brand || undefined, limit: 30 });
    const ws = await getWorkspace(c.workspaceId);
    const availability = q.check && !ws.settings.simulation ? await checkAvailability(suggestions.map((s) => s.name)) : {};
    return suggestions.map((s) => ({ ...s, availability: availability[s.name] ?? "unknown" }));
  });

  // ───────────── Provisioning orders (RSV-4) ─────────────
  app.post("/api/orders", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(z.object({ provider: z.enum(["google", "microsoft"]), domainCount: z.number().int().min(1).max(500), mailboxesPerDomain: z.number().int().min(1).max(50), reason: z.string().default("Manual order") }), req.body);
    const [o] = await getDb().insert(provisioningOrders).values({ workspaceId: c.workspaceId, ...body, targetPool: "reserve" }).returning();
    return o;
  });
  app.put("/api/orders/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { status } = parse(z.object({ status: z.enum(["draft", "ordered", "done", "cancelled"]) }), req.body);
    await getDb().update(provisioningOrders).set({ status }).where(and(eq(provisioningOrders.workspaceId, c.workspaceId), eq(provisioningOrders.id, id)));
    await audit(c.workspaceId, c.actor, "order.status", { type: "order", id }, { status });
    return { ok: true };
  });

  // ───────────── System ─────────────
  app.get("/api/system/jobs", async (req) => {
    ctx(req);
    return jobStatus();
  });
  app.post("/api/system/jobs/:name/run", async (req) => {
    const c = ctx(req, "operator");
    const { name } = parse(z.object({ name: z.string() }), req.params);
    await audit(c.workspaceId, c.actor, "job.run", null, { name });
    return runJob(name);
  });
}
