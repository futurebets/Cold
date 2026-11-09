/** Domains and mailboxes. */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { badRequest, notFound } from "../lib/http";
import { isProtected } from "@cold/core";
import { listCloudflareZones } from "../adapters/external";
import { audit, getPolicies, getProtectedDomains, getSecret } from "../services/common";
import * as domainsSvc from "../services/domains";
import { testMailbox } from "../services/lifecycle";
import { ctx, idParam, parse, z } from "./helpers";

const { mailboxes, domains, mailboxPools } = schema;

export async function infraRoutes(app: FastifyInstance) {
  app.get("/api/domains", async (req) => domainsSvc.listDomains(ctx(req).workspaceId));
  app.get("/api/pools", async (req) => getDb().select().from(mailboxPools).where(eq(mailboxPools.workspaceId, ctx(req).workspaceId)));

  app.post("/api/domains", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(
      z.object({
        names: z.array(z.string()).min(1).max(500),
        provider: z.enum(["google", "microsoft"]),
        tenantId: z.string().nullable().optional(),
        pool: z.enum(["active", "reserve"]),
        vendor: z.enum(["hypertide", "direct", "other"]).optional(),
        dnsManaged: z.enum(["cloudflare", "manual"]).optional(),
        mailboxes: z.array(z.object({ firstName: z.string(), lastName: z.string().optional(), localPart: z.string().optional() })).optional(),
      }),
      req.body,
    );
    const res = await domainsSvc.addDomains(c.workspaceId, c.actor, body);
    if (body.mailboxes?.length) for (const d of res.created) await domainsSvc.addMailboxes(c.workspaceId, c.actor, d.id, body.mailboxes);
    return res;
  });

  // Domains already on Cloudflare: list zones so they can be imported in one click.
  app.get("/api/cloudflare/zones", async (req) => {
    const c = ctx(req, "operator");
    const token = await getSecret(c.workspaceId, "cloudflare.token");
    if (!token) throw badRequest("Connect Cloudflare in Settings → Integrations first (API token with Zone:Read and DNS:Edit).");
    const zones = await listCloudflareZones(token).catch((e) => Promise.reject(badRequest(`Cloudflare: ${e.message}`)));
    const existing = new Set((await getDb().select({ name: domains.name }).from(domains).where(eq(domains.workspaceId, c.workspaceId))).map((d) => d.name));
    const prot = await getProtectedDomains(c.workspaceId);
    return zones
      .map((z) => ({ ...z, inCold: existing.has(z.name), protected: isProtected(z.name, prot) }))
      .sort((a, b) => Number(a.inCold) - Number(b.inCold) || a.name.localeCompare(b.name));
  });

  // Write + verify DNS for many domains at once through Cloudflare.
  app.post("/api/domains/bulk-dns", async (req) => {
    const c = ctx(req, "operator");
    const { domainIds } = parse(z.object({ domainIds: z.array(z.string()).min(1).max(200) }), req.body);
    const results = [];
    for (const id of domainIds) {
      const d = await domainsSvc.getDomain(c.workspaceId, id);
      try {
        const push = await domainsSvc.pushDns(c.workspaceId, id, c.actor);
        const check = await domainsSvc.checkDns(c.workspaceId, id, c.actor);
        results.push({ id, name: d.name, ok: true, applied: push.applied, skipped: push.skipped, warnings: push.warnings, pass: check.pass, failing: check.items.filter((i) => !i.pass).map((i) => i.label) });
      } catch (e: any) {
        results.push({ id, name: d.name, ok: false, error: String(e?.message ?? e) });
      }
    }
    return results;
  });

  app.get("/api/domains/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return domainsSvc.domainDetail(c.workspaceId, id);
  });

  app.patch("/api/domains/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        tenantId: z.string().nullable().optional(),
        poolId: z.string().optional(),
        vendor: z.enum(["hypertide", "direct", "other"]).optional(),
        registrar: z.string().nullable().optional(),
        expiresAt: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        capOverride: z.number().int().min(0).nullable().optional(),
        capReason: z.string().optional(),
        dnsValues: z.object({ googleDkimValue: z.string().optional(), msDkimSelector1: z.string().optional(), msDkimSelector2: z.string().optional(), msMxHost: z.string().optional() }).optional(),
      }),
      req.body,
    );
    const d = await domainsSvc.getDomain(c.workspaceId, id);
    const patch: Partial<typeof domains.$inferInsert> = {};
    if (body.tenantId !== undefined) {
      patch.tenantId = body.tenantId;
      await getDb().update(mailboxes).set({ tenantId: body.tenantId, connection: "unknown" }).where(eq(mailboxes.domainId, d.id));
    }
    if (body.poolId) patch.poolId = body.poolId;
    if (body.vendor) patch.vendor = body.vendor;
    if (body.registrar !== undefined) patch.registrar = body.registrar;
    if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.dnsValues) patch.dnsValues = { ...d.dnsValues, ...Object.fromEntries(Object.entries(body.dnsValues).filter(([, v]) => v !== undefined)) };
    if (body.capOverride !== undefined) {
      const policies = await getPolicies(c.workspaceId);
      const def = d.provider === "google" ? policies.caps.google.perDomainDaily : policies.caps.microsoft.perDomainDaily;
      if (body.capOverride !== null && body.capOverride > def) {
        if (c.role !== "owner") throw badRequest("Raising a domain above the playbook cap needs the Owner role");
        if (!body.capReason?.trim()) throw badRequest("Give a reason for going above the playbook cap");
      }
      patch.capOverride = body.capOverride;
    }
    await getDb().update(domains).set({ ...patch, updatedAt: new Date() }).where(eq(domains.id, d.id));
    await audit(c.workspaceId, c.actor, "domain.updated", { type: "domain", id: d.id }, body as Record<string, unknown>, body.capReason);
    return domainsSvc.domainDetail(c.workspaceId, id);
  });

  app.post("/api/domains/:id/check-dns", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return domainsSvc.checkDns(c.workspaceId, id, c.actor);
  });

  app.post("/api/domains/:id/push-dns", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return domainsSvc.pushDns(c.workspaceId, id, c.actor);
  });

  app.post("/api/domains/:id/header-test", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { raw, mailboxId } = parse(z.object({ raw: z.string().min(1).max(200_000), mailboxId: z.string().optional() }), req.body);
    return domainsSvc.submitHeaders(c.workspaceId, id, raw, c.actor, mailboxId);
  });

  app.post("/api/domains/:id/header-test/auto", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return domainsSvc.startAutoHeaderTest(c.workspaceId, id, c.actor);
  });

  app.post("/api/domains/:id/start-warmup", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { since } = parse(z.object({ since: z.string().nullable().optional() }), req.body);
    return domainsSvc.startWarmup(c.workspaceId, id, c.actor, since ? new Date(since) : null);
  });

  app.post("/api/domains/:id/pool", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { pool } = parse(z.object({ pool: z.enum(["active", "reserve"]) }), req.body);
    return domainsSvc.setPool(c.workspaceId, id, pool, c.actor);
  });

  app.post("/api/domains/:id/retire", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
    await domainsSvc.retireDomain(c.workspaceId, id, c.actor, reason);
    return { ok: true };
  });

  // ───────────── Mailboxes ─────────────
  app.get("/api/mailboxes", async (req) => {
    const c = ctx(req);
    return getDb()
      .select({ mailbox: mailboxes, domain: { id: domains.id, name: domains.name, state: domains.state, provider: domains.provider } })
      .from(mailboxes)
      .leftJoin(domains, eq(mailboxes.domainId, domains.id))
      .where(eq(mailboxes.workspaceId, c.workspaceId))
      .orderBy(mailboxes.address);
  });

  app.post("/api/domains/:id/mailboxes", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const { personas } = parse(z.object({ personas: z.array(z.object({ firstName: z.string().min(1), lastName: z.string().optional(), localPart: z.string().optional() })).min(1).max(50) }), req.body);
    return domainsSvc.addMailboxes(c.workspaceId, c.actor, id, personas);
  });

  app.patch("/api/mailboxes/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        signature: z.string().max(500).optional(),
        timezone: z.string().optional(),
        isSeed: z.boolean().optional(),
        seedFamily: z.enum(["gmail", "google_workspace", "outlook", "microsoft365"]).nullable().optional(),
        warmupInboxRate: z.number().min(0).max(1).nullable().optional(),
        capOverride: z.number().int().min(0).nullable().optional(),
      }),
      req.body,
    );
    const [mb] = await getDb().select().from(mailboxes).where(and(eq(mailboxes.workspaceId, c.workspaceId), eq(mailboxes.id, id)));
    if (!mb) throw notFound("Mailbox not found");
    if (body.signature !== undefined) {
      if (/https?:\/\/|www\./i.test(body.signature)) throw badRequest("Signatures can't contain links (playbook rule 9)");
    }
    if (body.capOverride != null) {
      const [d] = mb.domainId ? await getDb().select().from(domains).where(eq(domains.id, mb.domainId)) : [];
      const policies = await getPolicies(c.workspaceId);
      const def = d?.provider === "microsoft" ? policies.caps.microsoft.perMailboxDaily : policies.caps.google.perMailboxDaily;
      if (body.capOverride > def && c.role !== "owner") throw badRequest("Raising a mailbox above the playbook cap needs the Owner role");
    }
    await getDb().update(mailboxes).set(body).where(eq(mailboxes.id, id));
    await audit(c.workspaceId, c.actor, "mailbox.updated", { type: "mailbox", id }, body as Record<string, unknown>);
    return { ok: true };
  });

  app.post("/api/mailboxes/:id/test", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const [mb] = await getDb().select().from(mailboxes).where(and(eq(mailboxes.workspaceId, c.workspaceId), eq(mailboxes.id, id)));
    if (!mb) throw notFound("Mailbox not found");
    const [d] = mb.domainId ? await getDb().select().from(domains).where(eq(domains.id, mb.domainId)) : [];
    return testMailbox(mb, d ?? null);
  });

  app.post("/api/domains/:id/test-mailboxes", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const d = await domainsSvc.getDomain(c.workspaceId, id);
    const mbs = await domainsSvc.domainMailboxes(d.id);
    const results = [];
    for (const m of mbs) results.push({ address: m.address, ...(await testMailbox(m, d)) });
    return results;
  });

  app.delete("/api/mailboxes/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const [mb] = await getDb().select().from(mailboxes).where(and(eq(mailboxes.workspaceId, c.workspaceId), eq(mailboxes.id, id)));
    if (!mb) throw notFound("Mailbox not found");
    if (["active", "relay"].includes(mb.state)) throw badRequest("Active and relay mailboxes can't be deleted. Retire the domain instead so conversations are kept.");
    await getDb().update(mailboxes).set({ state: "decommissioned" }).where(eq(mailboxes.id, id));
    await audit(c.workspaceId, c.actor, "mailbox.decommissioned", { type: "mailbox", id }, { address: mb.address });
    return { ok: true };
  });
}
