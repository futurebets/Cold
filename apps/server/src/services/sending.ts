/**
 * Planner + sender (SPEC §6.10, §8.2). The planner fills each mailbox's remaining daily
 * capacity with staggered, provider-mixed sends; the sender runs the pre-flight guard
 * (§5 invariants) and an atomic cap check immediately before every message.
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Policies, RecipientProvider, SkipReason } from "@cold/core";
import {
  addBusinessDays,
  composeBody,
  domainDailyCap,
  hashString,
  inSaturdayArm,
  inWindow,
  lintCopy,
  localDate,
  mailboxDailyCap,
  planSlots,
  preflight,
  renderTemplate,
  resolveTimezone,
  seededRandom,
  warmupDays,
  weekdayOf,
} from "@cold/core";
import { getDb, schema } from "../db/client";
import { ProviderError } from "../lib/http";
import { newMessageId } from "../lib/mime";
import { transportFor } from "../adapters/transport";
import { audit, getPolicies, getProtectedDomains, getWorkspace, mailboxCtx, raiseAlert, simProfile, SYSTEM, type Workspace } from "./common";
import { sequence, mergeVars } from "./campaigns";
import { isSuppressed } from "./lists";

const { sends, mailboxes, domains, tenants, enrollments, campaigns, prospects, capCounters, threads, messages } = schema;
type SendRow = typeof sends.$inferSelect;
type MailboxRow = typeof mailboxes.$inferSelect;
type DomainRow = typeof domains.$inferSelect;
type CampaignRow = typeof campaigns.$inferSelect;
type ProspectRow = typeof prospects.$inferSelect;

const COUNTED_KINDS = ["first_touch", "follow_up", "seed"] as const;

// ───────────────────────── Planner ─────────────────────────

interface Candidate {
  enrollment: typeof enrollments.$inferSelect;
  prospect: ProspectRow;
  campaign: CampaignRow;
  tz: string;
  followUp: boolean;
}

/** Interleave candidates by recipient provider so each batch mirrors the pool mix (SCH-6). */
export function interleaveByProvider<T extends { provider: RecipientProvider | null }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = it.provider ?? "other";
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const total = items.length;
  const taken = new Map<string, number>([...groups.keys()].map((k) => [k, 0]));
  const out: T[] = [];
  while (out.length < total) {
    let best: string | null = null;
    let bestDeficit = -Infinity;
    for (const [k, g] of groups) {
      const t = taken.get(k)!;
      if (t >= g.length) continue;
      const deficit = (g.length / total) * (out.length + 1) - t;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = k;
      }
    }
    const t = taken.get(best!)!;
    out.push(groups.get(best!)![t]);
    taken.set(best!, t + 1);
  }
  return out;
}

async function usedToday(mailboxIds: string[], date: string) {
  if (!mailboxIds.length) return new Map<string, number>();
  const rows = await getDb()
    .select({ mailboxId: sends.mailboxId, n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(inArray(sends.mailboxId, mailboxIds), eq(sends.localDate, date), inArray(sends.status, ["scheduled", "sending", "sent"]), inArray(sends.kind, [...COUNTED_KINDS])))
    .groupBy(sends.mailboxId);
  return new Map(rows.map((r) => [r.mailboxId, r.n]));
}

export async function planWorkspace(workspaceId: string, now = new Date()) {
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const active = await db.select().from(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")));
  if (!active.length) return { planned: 0 };
  const campaignById = new Map(active.map((c) => [c.id, c]));

  const rows = await db
    .select({ mailbox: mailboxes, domain: domains })
    .from(mailboxes)
    .innerJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(and(eq(mailboxes.workspaceId, workspaceId), inArray(domains.state, ["active", "layover"]), inArray(mailboxes.state, ["active"]), eq(mailboxes.connection, "connected")));
  if (!rows.length) return { planned: 0 };

  const seqCache = new Map<string, Awaited<ReturnType<typeof sequence>>>();
  const seqFor = async (id: string) => {
    if (!seqCache.has(id)) seqCache.set(id, await sequence(id));
    return seqCache.get(id)!;
  };

  // Domain-level usage today (per domain, in each mailbox's own local date).
  const byDomain = new Map<string, { domain: DomainRow; mbs: MailboxRow[] }>();
  for (const r of rows) {
    const e = byDomain.get(r.domain.id) ?? { domain: r.domain, mbs: [] };
    e.mbs.push(r.mailbox);
    byDomain.set(r.domain.id, e);
  }

  const companyWeek = new Map<string, number>();
  const weekRows = await db
    .select({ company: prospects.companyDomain, n: sql<number>`count(*)::int` })
    .from(sends)
    .innerJoin(prospects, eq(sends.prospectId, prospects.id))
    .where(and(eq(sends.workspaceId, workspaceId), inArray(sends.status, ["scheduled", "sending", "sent"]), gte(sends.scheduledAt, new Date(now.getTime() - 7 * 86_400_000))))
    .groupBy(prospects.companyDomain);
  for (const r of weekRows) companyWeek.set(r.company, r.n);

  let planned = 0;
  for (const { domain, mbs } of byDomain.values()) {
    const allMbCount = (await db.select({ n: sql<number>`count(*)::int` }).from(mailboxes).where(and(eq(mailboxes.domainId, domain.id), sql`${mailboxes.state} <> 'decommissioned'`)))[0].n;
    const domainCap = domainDailyCap(domain.provider, allMbCount, policies, domain.capOverride);
    const tz0 = mbs[0].timezone;
    const today0 = localDate(now, tz0);
    const used = await usedToday(mbs.map((m) => m.id), today0);
    let domainRemaining = domainCap - [...used.values()].reduce((a, b) => a + b, 0);
    const companiesToday = new Set<string>();

    for (const mb of [...mbs].sort(() => Math.random() - 0.5)) {
      if (domainRemaining <= 0) break;
      if (warmupDays(mb, now) < policies.warmup.minDays) continue;
      const tz = mb.timezone;
      const today = localDate(now, tz);
      const startHour = Math.min(...active.map((c) => c.schedule.startHour));
      const endHour = Math.max(...active.map((c) => c.schedule.endHour));
      const localNow = DateTime.fromJSDate(now).setZone(tz);
      if (localNow.hour >= endHour) continue;
      const cap = mailboxDailyCap(domain.provider, policies, mb.capOverride);
      const remaining = Math.min(cap - (used.get(mb.id) ?? 0), domainRemaining);
      if (remaining <= 0) continue;
      const endOfDay = localNow.endOf("day").toJSDate();

      // Follow-ups due on this mailbox (thread continuity), plus moved sequences (standaloneNext).
      const dueRows = await db
        .select({ enrollment: enrollments, prospect: prospects })
        .from(enrollments)
        .innerJoin(prospects, eq(enrollments.prospectId, prospects.id))
        .where(
          and(
            eq(enrollments.mailboxId, mb.id),
            eq(enrollments.status, "active"),
            sql`${enrollments.nextStep} > 0`,
            lte(enrollments.nextDueAt, endOfDay),
            sql`not exists (select 1 from ${sends} s where s.enrollment_id = ${enrollments.id} and s.status in ('scheduled','sending'))`,
          ),
        )
        .orderBy(asc(enrollments.nextDueAt))
        .limit(remaining * 3);
      const candidates: Candidate[] = [];
      for (const r of dueRows) {
        const c = campaignById.get(r.enrollment.campaignId);
        if (!c) continue;
        candidates.push({ ...r, campaign: c, tz: resolveTimezone(r.prospect, c.schedule.defaultTimezone), followUp: true });
      }

      // First touches: only from fully active domains (not layover), for campaigns using this domain's pool.
      if (domain.state === "active") {
        const poolCampaigns = active.filter((c) => c.poolId === domain.poolId);
        if (poolCampaigns.length) {
          const firstRows = await db
            .select({ enrollment: enrollments, prospect: prospects })
            .from(enrollments)
            .innerJoin(prospects, eq(enrollments.prospectId, prospects.id))
            .where(
              and(
                inArray(enrollments.campaignId, poolCampaigns.map((c) => c.id)),
                eq(enrollments.status, "active"),
                eq(enrollments.nextStep, 0),
                isNull(enrollments.mailboxId),
                sql`(${enrollments.reenrollAfter} is null or ${enrollments.reenrollAfter} <= ${now})`,
              ),
            )
            .orderBy(asc(enrollments.createdAt))
            .limit(remaining * 4);
          const firsts = firstRows.map((r) => {
            const c = campaignById.get(r.enrollment.campaignId)!;
            return { ...r, campaign: c, tz: resolveTimezone(r.prospect, c.schedule.defaultTimezone), followUp: false, provider: r.prospect.recipientProvider };
          });
          candidates.push(...interleaveByProvider(firsts));
        }
      }
      if (!candidates.length) continue;

      const rand = seededRandom(`${mb.id}:${today}:${now.getUTCHours()}`);
      const slots = planSlots({ date: today, mailboxTz: tz, startHour, endHour, count: remaining, rand, policies, notBefore: now });
      const used2 = new Set<string>();
      const inserts: (typeof sends.$inferInsert)[] = [];
      const claimFirst: string[] = [];
      for (const slot of slots) {
        const idx = candidates.findIndex((cand) => {
          if (used2.has(cand.enrollment.id)) return false;
          const s = cand.campaign.schedule;
          if (!inWindow(slot, cand.tz, s)) return false;
          const isSat = weekdayOf(slot, cand.tz) === 6;
          if (!cand.followUp && s.saturdayTestShare > 0) {
            const satArm = inSaturdayArm(cand.prospect.id, s.saturdayTestShare);
            if (satArm !== isSat) return false;
          } else if (isSat && !s.saturday && s.saturdayTestShare <= 0) return false;
          if (!cand.followUp) {
            const co = cand.prospect.companyDomain;
            if (companiesToday.has(co)) return false;
            if ((companyWeek.get(co) ?? 0) >= policies.schedule.maxCompanyContactsPerWeek) return false;
          }
          return true;
        });
        if (idx < 0) continue;
        const cand = candidates[idx];
        used2.add(cand.enrollment.id);
        if (!cand.followUp) {
          companiesToday.add(cand.prospect.companyDomain);
          claimFirst.push(cand.enrollment.id);
        }
        companyWeek.set(cand.prospect.companyDomain, (companyWeek.get(cand.prospect.companyDomain) ?? 0) + 1);
        const seq = await seqFor(cand.campaign.id);
        const stepIndex = cand.enrollment.nextStep;
        const step = seq[stepIndex];
        if (!step) continue;
        inserts.push({
          workspaceId,
          kind: cand.followUp ? "follow_up" : "first_touch",
          enrollmentId: cand.enrollment.id,
          campaignId: cand.campaign.id,
          stepId: step.id,
          stepIndex,
          mailboxId: mb.id,
          domainId: domain.id,
          prospectId: cand.prospect.id,
          importId: cand.prospect.importId,
          toAddress: cand.prospect.email,
          recipientProvider: cand.prospect.recipientProvider,
          scheduledAt: slot,
          localDate: today,
        });
      }
      if (claimFirst.length) {
        await db
          .update(enrollments)
          .set({ mailboxId: mb.id })
          .where(and(inArray(enrollments.id, claimFirst), isNull(enrollments.mailboxId)));
      }
      if (inserts.length) {
        await db.insert(sends).values(inserts);
        planned += inserts.length;
        domainRemaining -= inserts.length;
      }
    }
  }
  return { planned };
}

// ───────────────────────── Sender ─────────────────────────

async function incrementCap(scope: "mailbox" | "domain", scopeId: string, date: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const rows = await getDb()
    .insert(capCounters)
    .values({ scope, scopeId, localDate: date, count: 1 })
    .onConflictDoUpdate({
      target: [capCounters.scope, capCounters.scopeId, capCounters.localDate],
      set: { count: sql`${capCounters.count} + 1` },
      setWhere: sql`${capCounters.count} < ${cap}`,
    })
    .returning({ count: capCounters.count });
  return rows.length > 0;
}

async function decrementCap(scope: "mailbox" | "domain", scopeId: string, date: string) {
  await getDb()
    .update(capCounters)
    .set({ count: sql`greatest(${capCounters.count} - 1, 0)` })
    .where(and(eq(capCounters.scope, scope), eq(capCounters.scopeId, scopeId), eq(capCounters.localDate, date)));
}

async function capCount(scope: "mailbox" | "domain", scopeId: string, date: string) {
  const [r] = await getDb()
    .select({ count: capCounters.count })
    .from(capCounters)
    .where(and(eq(capCounters.scope, scope), eq(capCounters.scopeId, scopeId), eq(capCounters.localDate, date)));
  return r?.count ?? 0;
}

async function skip(send: SendRow, reasons: string[]) {
  await getDb().update(sends).set({ status: "skipped", skipReasons: reasons }).where(eq(sends.id, send.id));
  if (!send.enrollmentId) return;
  if (reasons.includes("SUPPRESSED")) await getDb().update(enrollments).set({ status: "opted_out" }).where(eq(enrollments.id, send.enrollmentId));
  else if (reasons.some((r) => ["BUCKET_NOT_SENDABLE", "SEG_BLOCKED", "NOT_VALIDATED", "MISSING_MERGE"].includes(r)))
    await getDb().update(enrollments).set({ status: "interrupted" }).where(eq(enrollments.id, send.enrollmentId));
  else if (send.kind === "first_touch" && reasons.some((r) => ["DOMAIN_NOT_SENDING", "MAILBOX_NOT_SENDING", "NOT_CONNECTED", "AUTH_STALE"].includes(r)))
    // Release the claim so another healthy mailbox can pick this prospect up.
    await getDb().update(enrollments).set({ mailboxId: null }).where(and(eq(enrollments.id, send.enrollmentId), eq(enrollments.nextStep, 0)));
}

export async function runSender(now = new Date(), limit = 100) {
  const db = getDb();
  const due = await db
    .select({ id: sends.id })
    .from(sends)
    .where(and(eq(sends.status, "scheduled"), lte(sends.scheduledAt, now)))
    .orderBy(asc(sends.scheduledAt))
    .limit(limit);
  let sent = 0;
  let skipped = 0;
  for (const { id } of due) {
    const [claimed] = await db
      .update(sends)
      .set({ status: "sending", attempts: sql`${sends.attempts} + 1` })
      .where(and(eq(sends.id, id), eq(sends.status, "scheduled")))
      .returning();
    if (!claimed) continue;
    try {
      const r = await deliver(claimed, now);
      if (r === "sent") sent++;
      else skipped++;
    } catch (e: any) {
      await db.update(sends).set({ status: "failed", error: String(e?.message ?? e).slice(0, 500) }).where(eq(sends.id, id));
    }
  }
  return { sent, skipped };
}

async function deliver(send: SendRow, now: Date): Promise<"sent" | "skipped" | "failed"> {
  const db = getDb();
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, send.mailboxId));
  const [domain] = await db.select().from(domains).where(eq(domains.id, send.domainId));
  if (!mb || !domain) {
    await skip(send, ["MAILBOX_NOT_SENDING"]);
    return "skipped";
  }
  const ws = await getWorkspace(send.workspaceId);
  const policies = await getPolicies(send.workspaceId);
  const protectedList = await getProtectedDomains(send.workspaceId);
  const tenant = domain.tenantId ? (await db.select().from(tenants).where(eq(tenants.id, domain.tenantId)))[0] ?? null : null;
  const date = send.localDate;

  let subject = send.subject ?? "";
  let text = send.body ?? "";
  let inReplyTo: string | null = null;
  let references: string | null = null;
  let providerThreadId: string | null = null;
  let enrollment: typeof enrollments.$inferSelect | null = null;
  let prospect: ProspectRow | null = null;
  let campaign: CampaignRow | null = null;
  let lintBlocks = 0;
  let missing: string[] = [];
  let variantId: string | null = null;
  let recipientTz = ws.timezone;
  let isNewThread = true;
  let seqLength = 0;
  let nextDelay = 3;

  if (send.kind === "first_touch" || send.kind === "follow_up") {
    [enrollment] = await db.select().from(enrollments).where(eq(enrollments.id, send.enrollmentId!));
    [prospect] = await db.select().from(prospects).where(eq(prospects.id, send.prospectId!));
    [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, send.campaignId!));
    if (!enrollment || !prospect || !campaign || enrollment.status !== "active") {
      await skip(send, ["CAMPAIGN_NOT_ACTIVE"]);
      return "skipped";
    }
    const seq = await sequence(campaign.id);
    seqLength = seq.length;
    const step = seq[send.stepIndex ?? 0];
    nextDelay = seq[(send.stepIndex ?? 0) + 1]?.delayDays ?? 3;
    const activeVariants = step?.variants.filter((v) => v.active) ?? [];
    if (!step || !activeVariants.length) {
      await skip(send, ["LINT_BLOCK"]);
      return "skipped";
    }
    const variant = activeVariants[hashString(enrollment.id) % activeVariants.length];
    variantId = variant.id;
    const standalone = enrollment.standaloneNext && (send.stepIndex ?? 0) > 0;
    const firstVariant = seq[0]?.variants.find((v) => v.active) ?? seq[0]?.variants[0];
    const vars = mergeVars(prospect, mb, ws.name);
    const rand = seededRandom(send.id);
    const bodyTpl = standalone ? variant.standaloneBody ?? "" : variant.body;
    const subjectTpl = (send.stepIndex ?? 0) === 0 ? variant.subject : standalone ? variant.subject || firstVariant?.subject || "" : "";
    const lint = lintCopy({
      subject: subjectTpl || (enrollment.firstSubject ?? ""),
      body: bodyTpl,
      signature: mb.signature,
      isFirstTouch: (send.stepIndex ?? 0) === 0 || standalone,
      jurisdiction: campaign.jurisdiction,
      postalAddressConfigured: !!ws.settings.postalAddress?.trim(),
      policies,
    });
    lintBlocks = lint.blocks;
    const renderedBody = renderTemplate(bodyTpl, vars, rand);
    missing = renderedBody.missing;
    if (subjectTpl) {
      const rs = renderTemplate(subjectTpl, vars, rand);
      subject = rs.text;
      missing.push(...rs.missing);
    } else {
      subject = `Re: ${(enrollment.firstSubject ?? "").replace(/^re:\s*/i, "")}`;
      inReplyTo = enrollment.lastMessageId;
      references = enrollment.references;
      providerThreadId = enrollment.providerThreadId;
      isNewThread = false;
    }
    text = composeBody(renderedBody.text, mb.signature, campaign.jurisdiction === "us" ? ws.settings.postalAddress : null);
    recipientTz = resolveTimezone(prospect, campaign.schedule.defaultTimezone);
  }

  const kind = send.kind;
  const mbCap = mailboxDailyCap(domain.provider, policies, mb.capOverride);
  const mbCount = (await db.select({ n: sql<number>`count(*)::int` }).from(mailboxes).where(and(eq(mailboxes.domainId, domain.id), sql`${mailboxes.state} <> 'decommissioned'`)))[0].n;
  const dCap = domainDailyCap(domain.provider, mbCount, policies, domain.capOverride);
  const suppressed = prospect ? await isSuppressed(send.workspaceId, prospect.email) : false;
  const window = campaign ? inWindow(new Date(now.getTime() - 5 * 60_000), recipientTz, campaign.schedule) || inWindow(now, recipientTz, campaign.schedule) : true;

  const check = preflight({
    kind,
    now,
    policies,
    protectedDomains: protectedList,
    domain: { name: domain.name, provider: domain.provider, state: domain.state, authVerifiedAt: domain.authVerifiedAt },
    mailbox: { state: mb.state, connection: mb.connection, warmupDays: warmupDays(mb, now), address: mb.address },
    caps: { mailboxSent: await capCount("mailbox", mb.id, date), mailboxCap: mbCap, domainSent: await capCount("domain", domain.id, date), domainCap: dCap },
    prospect: prospect
      ? { validationStatus: prospect.validationStatus, validatedAt: prospect.validatedAt, bucket: prospect.bucket, seg: prospect.seg, suppressed }
      : undefined,
    campaign: campaign ? { status: campaign.status, isCatchAll: campaign.isCatchAll } : undefined,
    message: { body: text + "\n" + subject, lintBlocks, missingMerge: missing },
    inWindow: window,
  });
  if (!check.ok) {
    await skip(send, check.reasons);
    return "skipped";
  }

  const counted = kind !== "header_test";
  if (counted) {
    if (!(await incrementCap("mailbox", mb.id, date, mbCap))) {
      await skip(send, ["CAP_MAILBOX" satisfies SkipReason]);
      return "skipped";
    }
    if (!(await incrementCap("domain", domain.id, date, dCap))) {
      await decrementCap("mailbox", mb.id, date);
      await skip(send, ["CAP_DOMAIN" satisfies SkipReason]);
      return "skipped";
    }
  }

  const ctx = await mailboxCtx(mb, domain.name, tenant);
  const transport = transportFor(ctx.tenant);
  const messageId = send.rfcMessageId ?? newMessageId(domain.name);
  try {
    const res = await transport.send(ctx, {
      to: send.toAddress,
      subject,
      text,
      messageId,
      inReplyTo,
      references,
      providerThreadId,
      sim: { kind, arm: send.arm, profile: simProfile(ws, domain) },
    });
    await db
      .update(sends)
      .set({ status: "sent", sentAt: now, subject, body: text, variantId, rfcMessageId: res.rfcMessageId, providerMessageId: res.providerMessageId, providerThreadId: res.providerThreadId, error: null })
      .where(eq(sends.id, send.id));
    if (enrollment && prospect && campaign) await afterCampaignSend({ send, enrollment, prospect, campaign, mb, subject, text, res, now, recipientTz, isNewThread, seqLength, nextDelay });
    return "sent";
  } catch (e: any) {
    if (counted) {
      await decrementCap("mailbox", mb.id, date);
      await decrementCap("domain", domain.id, date);
    }
    const err = e instanceof ProviderError ? e : new ProviderError(String(e?.message ?? e), 0);
    if (err.auth) {
      await db.update(mailboxes).set({ connection: "disconnected", connectionDetail: err.message }).where(eq(mailboxes.id, mb.id));
      await raiseAlert(send.workspaceId, {
        severity: "critical",
        kind: "mailbox_disconnected",
        key: `mailbox_disconnected:${mb.id}`,
        title: `${mb.address} disconnected. Sending paused for this inbox.`,
        body: err.message,
        entity: { type: "mailbox", id: mb.id },
        action: { label: "Reconnect", href: `/domains/${domain.id}` },
      });
    }
    if (err.transient && send.attempts < 3) {
      await db
        .update(sends)
        .set({ status: "scheduled", scheduledAt: new Date(now.getTime() + 10 * 60_000 * send.attempts), error: err.message.slice(0, 500) })
        .where(eq(sends.id, send.id));
      return "skipped";
    }
    await db.update(sends).set({ status: "failed", error: err.message.slice(0, 500) }).where(eq(sends.id, send.id));
    if (send.kind === "first_touch" && send.enrollmentId)
      await db.update(enrollments).set({ mailboxId: null }).where(and(eq(enrollments.id, send.enrollmentId), eq(enrollments.nextStep, 0)));
    return "failed";
  }
}

async function afterCampaignSend(p: {
  send: SendRow;
  enrollment: typeof enrollments.$inferSelect;
  prospect: ProspectRow;
  campaign: CampaignRow;
  mb: MailboxRow;
  subject: string;
  text: string;
  res: { rfcMessageId: string; providerMessageId: string; providerThreadId: string | null };
  now: Date;
  recipientTz: string;
  isNewThread: boolean;
  seqLength: number;
  nextDelay: number;
}) {
  const db = getDb();
  const { enrollment: e, send, now } = p;
  const nextStep = (send.stepIndex ?? 0) + 1;
  const done = nextStep >= p.seqLength;
  let threadId = p.isNewThread ? null : e.threadId;
  if (!threadId) {
    const [t] = await db
      .insert(threads)
      .values({
        workspaceId: send.workspaceId,
        mailboxId: p.mb.id,
        prospectId: p.prospect.id,
        enrollmentId: e.id,
        campaignId: p.campaign.id,
        providerThreadId: p.res.providerThreadId,
        subject: p.subject,
        counterpart: p.prospect.email,
        lastMessageAt: now,
      })
      .returning();
    threadId = t.id;
  } else {
    await db.update(threads).set({ lastMessageAt: now }).where(eq(threads.id, threadId));
  }
  await db.insert(messages).values({
    workspaceId: send.workspaceId,
    threadId,
    mailboxId: p.mb.id,
    direction: "out",
    fromAddr: p.mb.address,
    toAddr: p.prospect.email,
    subject: p.subject,
    bodyText: p.text,
    rfcMessageId: p.res.rfcMessageId,
    providerMessageId: p.res.providerMessageId,
    sendId: send.id,
  });
  const refs = [...(p.isNewThread ? [] : (e.references ?? "").split(/\s+/).filter(Boolean)), p.res.rfcMessageId].slice(-10).join(" ");
  await db
    .update(enrollments)
    .set({
      nextStep,
      status: done ? "completed" : "active",
      nextDueAt: done ? null : addBusinessDays(now, p.nextDelay, p.recipientTz, p.campaign.schedule.days),
      lastMessageId: p.res.rfcMessageId,
      references: refs,
      providerThreadId: p.res.providerThreadId,
      threadId,
      standaloneNext: false,
      ...(p.isNewThread ? { firstSubject: p.subject } : {}),
    })
    .where(eq(enrollments.id, e.id));
}

/** Cancel scheduled sends for a domain (pause, flag, rotation). */
export async function cancelScheduled(domainId: string, reason: string, kinds: SendRow["kind"][] = ["first_touch", "follow_up"]) {
  const db = getDb();
  const cancelled = await db
    .update(sends)
    .set({ status: "skipped", skipReasons: [reason] })
    .where(and(eq(sends.domainId, domainId), eq(sends.status, "scheduled"), inArray(sends.kind, kinds)))
    .returning({ enrollmentId: sends.enrollmentId, kind: sends.kind });
  const firstIds = cancelled.filter((c) => c.kind === "first_touch" && c.enrollmentId).map((c) => c.enrollmentId!) as string[];
  if (firstIds.length) await db.update(enrollments).set({ mailboxId: null }).where(and(inArray(enrollments.id, firstIds), eq(enrollments.nextStep, 0)));
  return cancelled.length;
}

/** Manual 1:1 reply from the unified inbox (in-thread, from the original mailbox). */
export async function sendManualReply(workspaceId: string, actorLabel: string, threadId: string, body: string) {
  const db = getDb();
  const [t] = await db.select().from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.id, threadId)));
  if (!t) throw new Error("Thread not found");
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId));
  const [domain] = await db.select().from(domains).where(eq(domains.id, mb.domainId!));
  if (mb.state === "decommissioned") throw new Error("This mailbox has been decommissioned; its conversation history is kept but it can't send.");
  if (mb.connection !== "connected") throw new Error("This mailbox is disconnected.");
  const ws = await getWorkspace(workspaceId);
  const tenant = domain.tenantId ? (await db.select().from(tenants).where(eq(tenants.id, domain.tenantId)))[0] ?? null : null;
  const lastIn = (await db.select().from(messages).where(and(eq(messages.threadId, t.id), eq(messages.direction, "in"))).orderBy(sql`${messages.createdAt} desc`).limit(1))[0];
  const ctx = await mailboxCtx(mb, domain.name, tenant);
  const subject = `Re: ${t.subject.replace(/^re:\s*/i, "")}`;
  const text = composeBody(body, mb.signature, null);
  const res = await transportFor(ctx.tenant).send(ctx, {
    to: t.counterpart,
    subject,
    text,
    messageId: newMessageId(domain.name),
    inReplyTo: lastIn?.rfcMessageId ?? null,
    references: lastIn?.headers?.References ? `${lastIn.headers.References} ${lastIn.rfcMessageId}` : lastIn?.rfcMessageId ?? null,
    providerThreadId: t.providerThreadId,
    sim: { kind: "manual", profile: simProfile(ws, domain) },
  });
  await db.insert(messages).values({
    workspaceId,
    threadId: t.id,
    mailboxId: mb.id,
    direction: "out",
    fromAddr: mb.address,
    toAddr: t.counterpart,
    subject,
    bodyText: text,
    rfcMessageId: res.rfcMessageId,
    providerMessageId: res.providerMessageId,
  });
  await db.update(threads).set({ lastMessageAt: new Date(), unread: false }).where(eq(threads.id, t.id));
  await audit(workspaceId, { id: null, label: actorLabel, role: "sdr" }, "thread.replied", { type: "thread", id: t.id });
}

export type { Workspace, Policies };
export { SYSTEM };
