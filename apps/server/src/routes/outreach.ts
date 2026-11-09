/** Lists, suppressions, campaigns, copy, inbox. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { lintCopy } from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest } from "../lib/http";
import { audit, getPolicies, getWorkspace } from "../services/common";
import * as lists from "../services/lists";
import * as camp from "../services/campaigns";
import * as inbox from "../services/inbox";
import { sendManualReply } from "../services/sending";
import { ctx, idParam, parse, z } from "./helpers";

const { suppressions, sends, mailboxes, domains, prospects } = schema;

export async function outreachRoutes(app: FastifyInstance) {
  // ───────────── Lists ─────────────
  app.get("/api/lists", async (req) => lists.listImportsFor(ctx(req).workspaceId));
  app.post("/api/lists", async (req) => {
    const c = ctx(req, "sdr");
    const body = parse(z.object({ name: z.string().min(1), csv: z.string().min(1), mapping: z.record(z.string(), z.string()).optional(), segments: z.array(z.string()).optional() }), req.body);
    return lists.createImport(c.workspaceId, c.actor, body);
  });
  app.get("/api/lists/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return lists.getImport(c.workspaceId, id);
  });
  app.get("/api/lists/:id/export", async (req, reply) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    const { bucket } = parse(z.object({ bucket: z.string() }), req.query);
    const csv = await lists.exportProspectsCsv(c.workspaceId, id, bucket);
    reply.header("Content-Type", "text/csv").header("Content-Disposition", `attachment; filename="${bucket}.csv"`);
    return csv;
  });
  app.get("/api/prospects", async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ importId: z.string().optional(), bucket: z.string().optional(), search: z.string().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }), req.query);
    return lists.listProspects(c.workspaceId, q);
  });

  app.get("/api/suppressions", async (req) => {
    const c = ctx(req);
    return getDb().select().from(suppressions).where(eq(suppressions.workspaceId, c.workspaceId)).orderBy(desc(suppressions.createdAt)).limit(1000);
  });
  app.post("/api/suppressions", async (req) => {
    const c = ctx(req, "sdr");
    const body = parse(z.object({ entries: z.array(z.string()).min(1).max(10_000), reason: z.enum(["do_not_contact", "customer", "manual", "opt_out"]).default("manual") }), req.body);
    let n = 0;
    for (const e of body.entries) {
      const v = e.trim().toLowerCase();
      if (!v) continue;
      await lists.suppress(c.workspaceId, v.includes("@") ? { email: v, reason: body.reason, source: c.user.email } : { domain: v.replace(/^@/, ""), reason: body.reason, source: c.user.email });
      n++;
    }
    await audit(c.workspaceId, c.actor, "suppression.added", null, { count: n, reason: body.reason });
    return { added: n };
  });
  app.delete("/api/suppressions/:id", async (req) => {
    const c = ctx(req, "owner");
    const { id } = parse(idParam, req.params);
    const [s] = await getDb().select().from(suppressions).where(and(eq(suppressions.workspaceId, c.workspaceId), eq(suppressions.id, id)));
    if (s?.reason === "opt_out") throw badRequest("Opt-outs can't be removed. The person asked not to be contacted.");
    await getDb().delete(suppressions).where(and(eq(suppressions.workspaceId, c.workspaceId), eq(suppressions.id, id)));
    await audit(c.workspaceId, c.actor, "suppression.removed", null, { id });
    return { ok: true };
  });

  // ───────────── Campaigns ─────────────
  app.get("/api/campaigns", async (req) => camp.listCampaigns(ctx(req).workspaceId));
  app.post("/api/campaigns", async (req) => {
    const c = ctx(req, "sdr");
    const body = parse(z.object({ name: z.string().min(1), isCatchAll: z.boolean().optional(), jurisdiction: z.enum(["none", "us", "eu_uk", "ca"]).optional() }), req.body);
    return camp.createCampaign(c.workspaceId, c.actor, body);
  });
  app.get("/api/campaigns/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    const campaign = await camp.getCampaign(c.workspaceId, id);
    const seq = await camp.sequence(id);
    const withLint = await Promise.all(seq.map(async (s) => ({ ...s, variants: await Promise.all(s.variants.map(async (v) => ({ ...v, lint: await camp.lintVariant(c.workspaceId, campaign, s, v) }))) })));
    return { campaign, steps: withLint, checklist: await camp.launchChecklist(c.workspaceId, id) };
  });
  app.put("/api/campaigns/:id", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().optional(),
        jurisdiction: z.enum(["none", "us", "eu_uk", "ca"]).optional(),
        poolId: z.string().optional(),
        dailyNewLimit: z.number().int().min(0).nullable().optional(),
        schedule: z
          .object({
            days: z.array(z.number().int().min(1).max(7)).optional(),
            startHour: z.number().int().min(0).max(23).optional(),
            endHour: z.number().int().min(1).max(24).optional(),
            defaultTimezone: z.string().optional(),
            saturday: z.boolean().optional(),
            saturdayTestShare: z.number().min(0).max(0.5).optional(),
          })
          .optional(),
      }),
      req.body,
    );
    return camp.updateCampaign(c.workspaceId, c.actor, id, body);
  });
  app.delete("/api/campaigns/:id", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    await camp.deleteCampaign(c.workspaceId, c.actor, id);
    return { ok: true };
  });
  app.post("/api/campaigns/:id/launch", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await camp.setCampaignStatus(c.workspaceId, c.actor, id, "active");
    return { ok: true };
  });
  app.post("/api/campaigns/:id/pause", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await camp.setCampaignStatus(c.workspaceId, c.actor, id, "paused");
    return { ok: true };
  });
  app.post("/api/campaigns/:id/enroll", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ importIds: z.array(z.string()).optional(), segment: z.string().optional(), limit: z.number().int().optional() }), req.body);
    return lists.enrollProspects(c.workspaceId, c.actor, id, body);
  });
  app.get("/api/campaigns/:id/stats", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return camp.campaignStats(c.workspaceId, id);
  });
  app.post("/api/campaigns/:id/steps", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    return camp.addStep(c.workspaceId, c.actor, id);
  });
  app.put("/api/steps/:id", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await camp.updateStep(c.workspaceId, id, parse(z.object({ delayDays: z.number().int().optional() }), req.body));
    return { ok: true };
  });
  app.delete("/api/steps/:id", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await camp.deleteStep(c.workspaceId, c.actor, id);
    return { ok: true };
  });
  app.post("/api/steps/:id/variants", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    return camp.addVariant(c.workspaceId, id);
  });
  app.put("/api/variants/:id", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        subject: z.string().max(200).optional(),
        body: z.string().max(5000).optional(),
        standaloneBody: z.string().max(5000).nullable().optional(),
        active: z.boolean().optional(),
        acknowledgedWarnings: z.array(z.string()).optional(),
      }),
      req.body,
    );
    return camp.updateVariant(c.workspaceId, c.actor, id, body);
  });
  app.delete("/api/variants/:id", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    await camp.deleteVariant(c.workspaceId, id);
    return { ok: true };
  });
  app.get("/api/variants/:id/preview", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return camp.previewVariant(c.workspaceId, id);
  });
  app.post("/api/lint", async (req) => {
    const c = ctx(req);
    const body = parse(z.object({ subject: z.string().default(""), body: z.string().default(""), signature: z.string().optional(), isFirstTouch: z.boolean().default(true), jurisdiction: z.enum(["none", "us", "eu_uk", "ca"]).default("us") }), req.body);
    const ws = await getWorkspace(c.workspaceId);
    return lintCopy({ ...body, postalAddressConfigured: !!ws.settings.postalAddress?.trim(), policies: await getPolicies(c.workspaceId) });
  });

  // ───────────── Inbox ─────────────
  app.get("/api/threads", async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ filter: z.string().optional(), search: z.string().optional(), mailboxId: z.string().optional() }), req.query);
    return inbox.listThreads(c.workspaceId, q);
  });
  app.get("/api/threads/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return inbox.getThread(c.workspaceId, id);
  });
  app.post("/api/threads/:id/reply", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const { body } = parse(z.object({ body: z.string().min(1).max(10_000) }), req.body);
    if (/<\s*(img|a|html)\b/i.test(body)) throw badRequest("Replies are plain text");
    try {
      await sendManualReply(c.workspaceId, c.user.email, id, body);
    } catch (e: any) {
      throw badRequest(e.message);
    }
    return { ok: true };
  });
  app.post("/api/threads/:id/review", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const { suppress } = parse(z.object({ suppress: z.boolean() }), req.body);
    await inbox.resolveReview(c.workspaceId, id, suppress);
    return { ok: true };
  });
  app.post("/api/threads/:id/archive", async (req) => {
    const c = ctx(req, "sdr");
    const { id } = parse(idParam, req.params);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await inbox.archiveThread(c.workspaceId, id, archived);
    return { ok: true };
  });

  // ───────────── Send log ─────────────
  app.get("/api/sends", async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ status: z.string().optional(), domainId: z.string().optional(), kind: z.string().optional(), limit: z.coerce.number().default(200) }), req.query);
    const conds = [eq(sends.workspaceId, c.workspaceId)];
    if (q.status) conds.push(eq(sends.status, q.status as any));
    if (q.domainId) conds.push(eq(sends.domainId, q.domainId));
    if (q.kind) conds.push(eq(sends.kind, q.kind as any));
    return getDb()
      .select({
        id: sends.id,
        kind: sends.kind,
        status: sends.status,
        skipReasons: sends.skipReasons,
        error: sends.error,
        scheduledAt: sends.scheduledAt,
        sentAt: sends.sentAt,
        to: sends.toAddress,
        subject: sends.subject,
        from: mailboxes.address,
        domain: domains.name,
        recipientProvider: sends.recipientProvider,
        repliedAt: sends.repliedAt,
        replyKind: sends.replyKind,
        bounceType: sends.bounceType,
        bounceCategory: sends.bounceCategory,
        company: prospects.company,
      })
      .from(sends)
      .innerJoin(mailboxes, eq(sends.mailboxId, mailboxes.id))
      .innerJoin(domains, eq(sends.domainId, domains.id))
      .leftJoin(prospects, eq(sends.prospectId, prospects.id))
      .where(and(...conds))
      .orderBy(desc(sends.scheduledAt))
      .limit(Math.min(q.limit, 1000));
  });
}
