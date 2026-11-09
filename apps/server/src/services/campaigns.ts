/** Campaigns, sequences, copy and launch checklist (SPEC §6.8, §6.10). */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { CampaignSchedule, Jurisdiction } from "@cold/core";
import { cleanCompanyName, DEFAULT_SCHEDULE, lintCopy, renderTemplate, seededRandom, composeBody } from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, HttpError, notFound } from "../lib/http";
import type { Actor } from "./common";
import { audit, getPolicies, getWorkspace } from "./common";
import { defaultPool } from "./domains";

const { campaigns, steps, variants, enrollments, sends, domains, mailboxes, mailboxPools, prospects } = schema;
type CampaignRow = typeof campaigns.$inferSelect;
type VariantRow = typeof variants.$inferSelect;
type StepRow = typeof steps.$inferSelect;

export async function getCampaign(workspaceId: string, id: string): Promise<CampaignRow> {
  const [c] = await getDb().select().from(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, id)));
  if (!c) throw notFound("Campaign not found");
  return c;
}

export async function createCampaign(workspaceId: string, actor: Actor, input: { name: string; isCatchAll?: boolean; jurisdiction?: Jurisdiction; schedule?: Partial<CampaignSchedule> }) {
  const db = getDb();
  const ws = await getWorkspace(workspaceId);
  const pool = await defaultPool(workspaceId, !!input.isCatchAll);
  const [c] = await db
    .insert(campaigns)
    .values({
      workspaceId,
      name: input.name,
      isCatchAll: !!input.isCatchAll,
      poolId: pool.id,
      jurisdiction: input.jurisdiction ?? "us",
      schedule: { ...DEFAULT_SCHEDULE, defaultTimezone: ws.timezone, ...input.schedule },
    })
    .returning();
  // Seed a 3-step sequence with plain-text starter copy.
  const starters = [
    { delay: 0, subject: "quick question", body: "Hi {{firstName|there}},\n\n{Noticed|Saw} {{company|your team}} is [observation]. We help [who] [result] without [pain].\n\nNot relevant? Just reply 'no' and I won't follow up.\n\nInterested?" },
    { delay: 3, subject: "", body: "Hi {{firstName|there}}, one more thought: [one-line proof point].\n\nNot relevant? Just reply 'no'.\n\nWorth a chat?" },
    { delay: 4, subject: "", body: "Hi {{firstName|there}}, should I close the loop on this? If it's not a priority, reply 'no' and I won't follow up.\n\nOpen to it?" },
  ];
  for (const [i, s] of starters.entries()) {
    const [st] = await db.insert(steps).values({ campaignId: c.id, position: i, delayDays: s.delay }).returning();
    await db.insert(variants).values({ stepId: st.id, label: "A", subject: s.subject, body: s.body });
  }
  await audit(workspaceId, actor, "campaign.created", { type: "campaign", id: c.id }, { name: c.name });
  return c;
}

export async function updateCampaign(workspaceId: string, actor: Actor, id: string, patch: Partial<Pick<CampaignRow, "name" | "jurisdiction" | "poolId" | "dailyNewLimit">> & { schedule?: Partial<CampaignSchedule> }) {
  const c = await getCampaign(workspaceId, id);
  const next: Partial<CampaignRow> = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.jurisdiction !== undefined) next.jurisdiction = patch.jurisdiction;
  if (patch.dailyNewLimit !== undefined) next.dailyNewLimit = patch.dailyNewLimit;
  if (patch.poolId !== undefined) {
    const [p] = await getDb().select().from(mailboxPools).where(and(eq(mailboxPools.workspaceId, workspaceId), eq(mailboxPools.id, patch.poolId!)));
    if (!p) throw badRequest("Unknown mailbox pool");
    if (p.isCatchAll !== c.isCatchAll) throw badRequest(c.isCatchAll ? "Catch-all campaigns must use a catch-all pool" : "Regular campaigns can't use the catch-all pool");
    next.poolId = p.id;
  }
  if (patch.schedule) {
    const s = { ...c.schedule, ...patch.schedule };
    if (s.startHour >= s.endHour) throw badRequest("Window start must be before end");
    if (!s.days.length) throw badRequest("Pick at least one sending day");
    next.schedule = s;
  }
  await getDb().update(campaigns).set(next).where(eq(campaigns.id, id));
  await audit(workspaceId, actor, "campaign.updated", { type: "campaign", id }, patch as Record<string, unknown>);
  return getCampaign(workspaceId, id);
}

export async function sequence(campaignId: string) {
  const db = getDb();
  const st = await db.select().from(steps).where(eq(steps.campaignId, campaignId)).orderBy(asc(steps.position));
  const vs = st.length ? await db.select().from(variants).where(inArray(variants.stepId, st.map((s) => s.id))).orderBy(asc(variants.label)) : [];
  return st.map((s) => ({ ...s, variants: vs.filter((v) => v.stepId === s.id) }));
}

export async function lintVariant(workspaceId: string, c: CampaignRow, step: StepRow, v: Pick<VariantRow, "subject" | "body">, signature = "Jane") {
  const ws = await getWorkspace(workspaceId);
  const policies = await getPolicies(workspaceId);
  return lintCopy({
    subject: v.subject,
    body: v.body,
    signature,
    isFirstTouch: step.position === 0,
    jurisdiction: c.jurisdiction,
    postalAddressConfigured: !!ws.settings.postalAddress?.trim(),
    policies,
  });
}

export async function addStep(workspaceId: string, actor: Actor, campaignId: string) {
  const db = getDb();
  await getCampaign(workspaceId, campaignId);
  const existing = await db.select().from(steps).where(eq(steps.campaignId, campaignId));
  if (existing.length >= 6) throw badRequest("Keep sequences to 6 steps or fewer");
  const [st] = await db.insert(steps).values({ campaignId, position: existing.length, delayDays: 3 }).returning();
  await db.insert(variants).values({ stepId: st.id, label: "A", subject: "", body: "Hi {{firstName|there}}, [one short new thought].\n\nNot relevant? Reply 'no' and I won't follow up.\n\nInterested?" });
  await audit(workspaceId, actor, "step.added", { type: "campaign", id: campaignId });
  return st;
}

async function stepOwned(workspaceId: string, stepId: string) {
  const [row] = await getDb()
    .select({ step: steps, campaign: campaigns })
    .from(steps)
    .innerJoin(campaigns, eq(steps.campaignId, campaigns.id))
    .where(and(eq(steps.id, stepId), eq(campaigns.workspaceId, workspaceId)));
  if (!row) throw notFound("Step not found");
  return row;
}

export async function updateStep(workspaceId: string, stepId: string, patch: { delayDays?: number }) {
  await stepOwned(workspaceId, stepId);
  if (patch.delayDays !== undefined && (patch.delayDays < 1 || patch.delayDays > 30)) throw badRequest("Delay must be 1–30 business days");
  await getDb().update(steps).set(patch).where(eq(steps.id, stepId));
}

export async function deleteStep(workspaceId: string, actor: Actor, stepId: string) {
  const db = getDb();
  const { step, campaign } = await stepOwned(workspaceId, stepId);
  if (step.position === 0) throw badRequest("The first step can't be removed");
  await db.delete(steps).where(eq(steps.id, stepId));
  const rest = await db.select().from(steps).where(eq(steps.campaignId, campaign.id)).orderBy(asc(steps.position));
  for (const [i, s] of rest.entries()) if (s.position !== i) await db.update(steps).set({ position: i }).where(eq(steps.id, s.id));
  await audit(workspaceId, actor, "step.deleted", { type: "campaign", id: campaign.id });
}

export async function addVariant(workspaceId: string, stepId: string) {
  const db = getDb();
  await stepOwned(workspaceId, stepId);
  const vs = await db.select().from(variants).where(eq(variants.stepId, stepId));
  if (vs.length >= 4) throw badRequest("Up to 4 variants per step");
  const base = vs[0];
  const [v] = await db
    .insert(variants)
    .values({ stepId, label: String.fromCharCode(65 + vs.length), subject: base?.subject ?? "", body: base?.body ?? "" })
    .returning();
  return v;
}

async function variantOwned(workspaceId: string, variantId: string) {
  const [row] = await getDb()
    .select({ variant: variants, step: steps, campaign: campaigns })
    .from(variants)
    .innerJoin(steps, eq(variants.stepId, steps.id))
    .innerJoin(campaigns, eq(steps.campaignId, campaigns.id))
    .where(and(eq(variants.id, variantId), eq(campaigns.workspaceId, workspaceId)));
  if (!row) throw notFound("Variant not found");
  return row;
}

export async function updateVariant(workspaceId: string, actor: Actor, variantId: string, patch: Partial<Pick<VariantRow, "subject" | "body" | "standaloneBody" | "active" | "acknowledgedWarnings">>) {
  const { campaign } = await variantOwned(workspaceId, variantId);
  const next: Partial<VariantRow> = { ...patch };
  if (patch.active === true) next.pausedReason = null;
  await getDb().update(variants).set(next).where(eq(variants.id, variantId));
  if (patch.active !== undefined) await audit(workspaceId, actor, patch.active ? "variant.resumed" : "variant.paused", { type: "campaign", id: campaign.id }, { variantId });
  return (await variantOwned(workspaceId, variantId)).variant;
}

export async function deleteVariant(workspaceId: string, variantId: string) {
  const db = getDb();
  const { variant } = await variantOwned(workspaceId, variantId);
  const vs = await db.select().from(variants).where(eq(variants.stepId, variant.stepId));
  if (vs.length <= 1) throw badRequest("A step needs at least one variant");
  await db.delete(variants).where(eq(variants.id, variantId));
}

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail?: string;
  href?: string;
}

/** Everything that must be true before launch (SPEC §12 item 6). */
export async function launchChecklist(workspaceId: string, campaignId: string): Promise<ChecklistItem[]> {
  const db = getDb();
  const c = await getCampaign(workspaceId, campaignId);
  const ws = await getWorkspace(workspaceId);
  const seq = await sequence(campaignId);
  const items: ChecklistItem[] = [];
  let blocks = 0;
  let unacked = 0;
  for (const s of seq) {
    for (const v of s.variants.filter((x) => x.active)) {
      const lint = await lintVariant(workspaceId, c, s, v);
      blocks += lint.blocks;
      const warnRules = lint.findings.filter((f) => f.severity === "warn").map((f) => f.rule);
      unacked += warnRules.filter((r) => !v.acknowledgedWarnings.includes(r)).length;
    }
  }
  items.push({ id: "steps", label: "Sequence has copy", ok: seq.length > 0 && seq[0].variants.some((v) => v.active && v.body.trim()), blocking: true });
  items.push({ id: "lint", label: "No blocking copy issues (links, HTML, images, missing opt-out)", ok: blocks === 0, blocking: true, detail: blocks ? `${blocks} blocking issue(s)` : undefined });
  items.push({ id: "warnings", label: "Copy warnings reviewed", ok: unacked === 0, blocking: true, detail: unacked ? `${unacked} warning(s) to fix or acknowledge` : undefined });
  if (c.jurisdiction === "us")
    items.push({ id: "postal", label: "Postal address set (CAN-SPAM)", ok: !!ws.settings.postalAddress?.trim(), blocking: true, href: "/settings" });
  const sending = c.poolId
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(domains)
        .where(and(eq(domains.workspaceId, workspaceId), eq(domains.poolId, c.poolId), eq(domains.state, "active")))
    : [{ n: 0 }];
  items.push({
    id: "domains",
    label: "Warmed, authenticated domains are active in this campaign's pool",
    ok: sending[0].n > 0,
    blocking: false,
    detail: sending[0].n ? `${sending[0].n} active domain(s)` : "Nothing will send until a domain finishes warmup and goes active",
    href: "/domains",
  });
  const [{ n: enrolled }] = await db.select({ n: sql<number>`count(*)::int` }).from(enrollments).where(and(eq(enrollments.campaignId, campaignId), eq(enrollments.status, "active")));
  items.push({ id: "prospects", label: c.isCatchAll ? "Catch-all prospects enrolled" : "Validated prospects enrolled", ok: enrolled > 0, blocking: false, detail: `${enrolled.toLocaleString()} enrolled` });
  items.push({ id: "tracking", label: "Open tracking off, plain text only", ok: true, blocking: true, detail: "Always on in Cold (playbook rules 9–10)" });
  return items;
}

export async function setCampaignStatus(workspaceId: string, actor: Actor, campaignId: string, status: "active" | "paused") {
  const c = await getCampaign(workspaceId, campaignId);
  if (status === "active") {
    const list = await launchChecklist(workspaceId, campaignId);
    const failing = list.filter((i) => i.blocking && !i.ok);
    if (failing.length) throw new HttpError(409, `Can't launch yet: ${failing.map((f) => f.label).join("; ")}`, { checklist: list });
  }
  await getDb()
    .update(campaigns)
    .set({ status, ...(status === "active" && !c.launchedAt ? { launchedAt: new Date() } : {}) })
    .where(eq(campaigns.id, campaignId));
  if (status === "paused") {
    await getDb()
      .update(sends)
      .set({ status: "skipped", skipReasons: ["CAMPAIGN_NOT_ACTIVE"] })
      .where(and(eq(sends.campaignId, campaignId), eq(sends.status, "scheduled")));
  }
  await audit(workspaceId, actor, status === "active" ? "campaign.launched" : "campaign.paused", { type: "campaign", id: campaignId });
}

export async function deleteCampaign(workspaceId: string, actor: Actor, campaignId: string) {
  const c = await getCampaign(workspaceId, campaignId);
  if (c.status === "active") throw badRequest("Pause the campaign before deleting it");
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(sends).where(and(eq(sends.campaignId, campaignId), eq(sends.status, "sent")));
  if (n > 0) throw badRequest("This campaign has sent email. Pause it instead so its history and replies are kept.");
  await getDb().delete(campaigns).where(eq(campaigns.id, campaignId));
  await audit(workspaceId, actor, "campaign.deleted", { type: "campaign", id: campaignId }, { name: c.name });
}

export function mergeVars(p: typeof prospects.$inferSelect, mb?: { firstName: string; lastName: string } | null, company?: string) {
  return {
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    company: cleanCompanyName(p.company),
    title: p.title ?? "",
    senderFirstName: mb?.firstName ?? "",
    senderName: [mb?.firstName, mb?.lastName].filter(Boolean).join(" "),
    senderCompany: company ?? "",
    dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long" }),
    ...p.customFields,
  };
}

/** Render a variant for a sample prospect (preview in the editor). */
export async function previewVariant(workspaceId: string, variantId: string) {
  const db = getDb();
  const { variant, campaign } = await variantOwned(workspaceId, variantId);
  const ws = await getWorkspace(workspaceId);
  const [p] = await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.bucket, campaign.isCatchAll ? "catch_all" : "ready")))
    .limit(1);
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.workspaceId, workspaceId)).limit(1);
  const vars = p ? mergeVars(p, mb, ws.name) : { firstName: "Alex", company: "Northwind", senderFirstName: mb?.firstName ?? "Jane" };
  const rand = seededRandom(variantId + Date.now());
  const subject = renderTemplate(variant.subject, vars, rand);
  const body = renderTemplate(variant.body, vars, rand);
  return {
    prospect: p ? { email: p.email, firstName: p.firstName, company: p.company } : null,
    from: mb ? `${mb.firstName} ${mb.lastName} <${mb.address}>`.trim() : "Jane <jane@yourdomain.com>",
    subject: subject.text,
    text: composeBody(body.text, mb?.signature ?? null, campaign.jurisdiction === "us" ? ws.settings.postalAddress : null),
    missing: [...subject.missing, ...body.missing],
  };
}

export async function listCampaigns(workspaceId: string) {
  const db = getDb();
  const cs = await db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).orderBy(sql`${campaigns.createdAt} desc`);
  if (!cs.length) return [];
  const ids = cs.map((c) => c.id);
  const enr = await db
    .select({ campaignId: enrollments.campaignId, status: enrollments.status, n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(inArray(enrollments.campaignId, ids))
    .groupBy(enrollments.campaignId, enrollments.status);
  const st = await db
    .select({
      campaignId: sends.campaignId,
      sent: sql<number>`count(*) filter (where ${sends.status} = 'sent')::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
      scheduled: sql<number>`count(*) filter (where ${sends.status} = 'scheduled')::int`,
    })
    .from(sends)
    .where(and(inArray(sends.campaignId, ids), inArray(sends.kind, ["first_touch", "follow_up"])))
    .groupBy(sends.campaignId);
  return cs.map((c) => {
    const e = enr.filter((x) => x.campaignId === c.id);
    const s = st.find((x) => x.campaignId === c.id);
    return {
      ...c,
      enrolled: e.reduce((a, x) => a + x.n, 0),
      activeEnrollments: e.find((x) => x.status === "active")?.n ?? 0,
      replied: e.find((x) => x.status === "replied")?.n ?? 0,
      sent: s?.sent ?? 0,
      replies: s?.replies ?? 0,
      bounces: s?.bounces ?? 0,
      scheduled: s?.scheduled ?? 0,
    };
  });
}

export async function campaignStats(workspaceId: string, campaignId: string) {
  const db = getDb();
  await getCampaign(workspaceId, campaignId);
  const byDay = await db
    .select({
      day: sql<string>`to_char(${sends.sentAt}, 'YYYY-MM-DD')`,
      sent: sql<number>`count(*)::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
    })
    .from(sends)
    .where(and(eq(sends.campaignId, campaignId), eq(sends.status, "sent"), inArray(sends.kind, ["first_touch", "follow_up"])))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const byVariant = await db
    .select({
      variantId: sends.variantId,
      stepIndex: sends.stepIndex,
      sent: sql<number>`count(*)::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
      bounces: sql<number>`count(*) filter (where ${sends.bounceType} = 'hard')::int`,
    })
    .from(sends)
    .where(and(eq(sends.campaignId, campaignId), eq(sends.status, "sent")))
    .groupBy(sends.variantId, sends.stepIndex);
  const saturday = await db
    .select({
      saturday: sql<boolean>`extract(isodow from ${sends.sentAt}) = 6`,
      sent: sql<number>`count(*)::int`,
      replies: sql<number>`count(*) filter (where ${sends.replyKind} = 'human')::int`,
    })
    .from(sends)
    .where(and(eq(sends.campaignId, campaignId), eq(sends.status, "sent"), eq(sends.kind, "first_touch")))
    .groupBy(sql`1`);
  return { byDay, byVariant, saturday };
}
