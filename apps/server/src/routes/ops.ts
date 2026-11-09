/** Health, diagnoses, rotations. */
import type { FastifyInstance } from "fastify";
import * as health from "../services/health";
import * as diag from "../services/diagnosis";
import * as rot from "../services/rotation";
import { ctx, idParam, parse, z } from "./helpers";

export async function opsRoutes(app: FastifyInstance) {
  app.get("/api/health", async (req) => health.healthOverview(ctx(req).workspaceId));
  app.get("/api/health/domains/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return health.domainHealthHistory(c.workspaceId, id);
  });
  app.post("/api/health/evaluate", async (req) => {
    const c = ctx(req, "operator");
    return health.evaluateWorkspaceHealth(c.workspaceId);
  });

  app.get("/api/diagnoses", async (req) => diag.listDiagnoses(ctx(req).workspaceId));
  app.post("/api/diagnoses", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(z.object({ domainId: z.string(), campaignId: z.string().optional() }), req.body);
    return diag.openDiagnosis(c.workspaceId, body.domainId, "manual", c.actor, body.campaignId);
  });
  app.get("/api/diagnoses/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return diag.diagnosisDetail(c.workspaceId, id);
  });
  app.post("/api/diagnoses/:id/start-test", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return diag.startControlTest(c.workspaceId, id, c.actor);
  });
  app.post("/api/diagnoses/:id/manual-result", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ controlPass: z.boolean(), campaignPass: z.boolean() }), req.body);
    return diag.manualResult(c.workspaceId, id, c.actor, body.controlPass, body.campaignPass);
  });
  app.post("/api/diagnoses/:id/override", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ verdict: z.enum(["COPY", "INFRA", "LIST", "OFFER", "AUTH", "INCONCLUSIVE"]), reason: z.string().min(3) }), req.body);
    return diag.overrideVerdict(c.workspaceId, id, c.actor, body.verdict, body.reason);
  });
  app.post("/api/diagnoses/:id/apply", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return diag.applyDiagnosis(c.workspaceId, id, c.actor);
  });
  app.post("/api/diagnoses/:id/dismiss", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    const d = await diag.getDiagnosis(c.workspaceId, id);
    await diag.resumeDomain(c.workspaceId, d.domainId, c.actor, "Diagnosis dismissed by operator");
    await diag.closeDiagnosis(d);
    return { ok: true };
  });

  app.get("/api/rotations", async (req) => rot.listRotations(ctx(req).workspaceId));
  app.get("/api/rotations/:id", async (req) => {
    const c = ctx(req);
    const { id } = parse(idParam, req.params);
    return rot.rotationDetail(c.workspaceId, id);
  });
  app.post("/api/rotations", async (req) => {
    const c = ctx(req, "operator");
    const body = parse(z.object({ domainId: z.string(), diagnosisId: z.string().optional() }), req.body);
    return rot.planRotationFor(c.workspaceId, body.domainId, c.actor, body.diagnosisId);
  });
  app.post("/api/rotations/:id/execute", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    return rot.executeRotation(c.workspaceId, id, c.actor);
  });
  app.post("/api/rotations/:id/cancel", async (req) => {
    const c = ctx(req, "operator");
    const { id } = parse(idParam, req.params);
    await rot.cancelRotation(c.workspaceId, id, c.actor);
    return { ok: true };
  });
}
