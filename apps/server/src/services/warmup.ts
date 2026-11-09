/**
 * Built-in warmup engine (replaces a paid warmup network). See packages/core/src/warmup.ts.
 *
 * - planWarmup: each inbox in the pool gets today's ramped quota of warmup emails to inboxes
 *   in other tenants/domains, spread across the day.
 * - handleWarmupInbound: when a warmup email arrives, record where it landed, rescue it from
 *   spam (or mark it read) and sometimes schedule a natural reply.
 * - updateWarmupRates: per-inbox warmup inbox rate (feeds the Ready gate) and an early
 *   warning when an active domain's warmup mail starts landing in spam.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { PoolMember } from "@cold/core";
import { localDate, pickWarmupRecipients, planSlots, seededRandom, warmupDailyTarget, warmupDays, warmupInboxRate, warmupMessage, warmupPoolHealth, warmupReply, weekdayOf } from "@cold/core";
import { getDb, schema } from "../db/client";
import { newMessageId } from "../lib/mime";
import { transportFor, type InboundItem } from "../adapters/transport";
import { getPolicies, getWorkspace, loadTenant, mailboxCtx, raiseAlert, resolveAlert } from "./common";

const { mailboxes, domains, sends } = schema;
type MailboxRow = typeof mailboxes.$inferSelect;
type DomainRow = typeof domains.$inferSelect;

const WARM_DOMAIN_STATES = ["warming", "ready", "active", "flagged", "diagnosing", "layover"] as const;
const WARM_MAILBOX_STATES = ["warming", "ready", "active", "paused"] as const;

export async function warmupEngine(workspaceId: string): Promise<"cold" | "external"> {
  return (await getWorkspace(workspaceId)).settings.warmupEngine ?? "cold";
}

async function poolRows(workspaceId: string) {
  return getDb()
    .select({ mailbox: mailboxes, domain: domains })
    .from(mailboxes)
    .innerJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(mailboxes.isSeed, false),
        eq(mailboxes.connection, "connected"),
        inArray(mailboxes.state, [...WARM_MAILBOX_STATES]),
        inArray(domains.state, [...WARM_DOMAIN_STATES]),
        isNotNull(domains.authVerifiedAt),
      ),
    );
}

const member = (m: MailboxRow, d: DomainRow): PoolMember => ({ id: m.id, address: m.address, domainId: d.id, tenantId: m.tenantId ?? d.tenantId, provider: d.provider });

export async function planWarmup(workspaceId: string, now = new Date()) {
  if ((await warmupEngine(workspaceId)) !== "cold") return { planned: 0, skipped: "external engine" };
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  const rows = await poolRows(workspaceId);
  const pool = rows.map((r) => member(r.mailbox, r.domain));
  const health = warmupPoolHealth(pool);
  if (!health.canRun) {
    if (pool.length > 0)
      await raiseAlert(workspaceId, {
        severity: "warning",
        kind: "warmup_pool",
        key: "warmup_pool",
        title: "Built-in warmup can't run yet",
        body: health.issues.join(" "),
        action: { label: "Open warmup", href: "/settings/integrations" },
      });
    return { planned: 0, skipped: "pool" };
  }
  await resolveAlert(workspaceId, "warmup_pool");

  const today0 = now.toISOString().slice(0, 10);
  const todays = await db
    .select({ mailboxId: sends.mailboxId, to: sends.toAddress, depth: sends.warmupDepth, localDate: sends.localDate })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "warmup"), gte(sends.scheduledAt, new Date(now.getTime() - 36 * 3_600_000))));
  const receivedToday = new Map<string, number>();
  const byAddress = new Map(pool.map((p) => [p.address, p.id]));
  for (const t of todays) {
    const id = byAddress.get(t.to);
    if (id) receivedToday.set(id, (receivedToday.get(id) ?? 0) + 1);
  }

  let planned = 0;
  for (const { mailbox: mb, domain: d } of rows) {
    const tz = mb.timezone;
    const today = localDate(now, tz);
    const local = DateTime.fromJSDate(now).setZone(tz);
    if (local.hour >= 19) continue;
    const day = mb.warmupStartedAt ? warmupDays(mb, now) : 30;
    const target = warmupDailyTarget(day, d.provider, { active: mb.state === "active", weekend: weekdayOf(now, tz) >= 6, policies });
    const already = todays.filter((t) => t.mailboxId === mb.id && t.localDate === today && (t.depth ?? 0) === 0).length;
    const remaining = target - already;
    if (remaining <= 0) continue;
    const rand = seededRandom(`warmup:${mb.id}:${today}:${now.getUTCHours()}`);
    const slots = planSlots({ date: today, mailboxTz: tz, startHour: 8, endHour: 19, count: remaining, rand, policies: { ...policies, schedule: { ...policies.schedule, minGapMin: 3, startJitterMaxMin: 120 } }, notBefore: now });
    // At most one new conversation per recipient per day from each inbox.
    const emailedToday = new Set(todays.filter((t) => t.mailboxId === mb.id && t.localDate === today).map((t) => t.to));
    const candidates = pool.filter((p) => !emailedToday.has(p.address));
    const recipients = pickWarmupRecipients(member(mb, d), candidates, slots.length, rand, receivedToday);
    const rowsToInsert: (typeof sends.$inferInsert)[] = [];
    for (let i = 0; i < Math.min(slots.length, recipients.length); i++) {
      const to = rows.find((r) => r.mailbox.id === recipients[i].id)!.mailbox;
      const msg = warmupMessage(rand, { firstName: mb.firstName || mb.address.split("@")[0] }, { firstName: to.firstName });
      rowsToInsert.push({
        workspaceId,
        kind: "warmup",
        mailboxId: mb.id,
        domainId: d.id,
        toAddress: to.address,
        scheduledAt: slots[i],
        localDate: today,
        subject: msg.subject,
        body: msg.body,
        warmupDepth: 0,
        rfcMessageId: newMessageId(d.name),
      });
    }
    if (rowsToInsert.length) {
      await db.insert(sends).values(rowsToInsert);
      planned += rowsToInsert.length;
    }
  }
  return { planned, pool: health.inboxes, today: today0 };
}

/** Find the warmup send an inbound message corresponds to (by its Message-ID). */
export async function findWarmupSend(workspaceId: string, item: InboundItem) {
  if (!item.rfcMessageId) return null;
  const [s] = await getDb()
    .select()
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "warmup"), eq(sends.rfcMessageId, item.rfcMessageId)))
    .limit(1);
  return s ?? null;
}

export async function handleWarmupInbound(receiver: MailboxRow, item: InboundItem, send: typeof sends.$inferSelect) {
  const db = getDb();
  const policies = await getPolicies(receiver.workspaceId);
  if (!send.placement) await db.update(sends).set({ placement: item.folder === "spam" ? "spam" : "inbox" }).where(eq(sends.id, send.id));

  // Engage like a real recipient: rescue from spam, otherwise mark read.
  try {
    const [rd] = receiver.domainId ? await db.select().from(domains).where(eq(domains.id, receiver.domainId)) : [];
    const ctx = await mailboxCtx(receiver, rd?.name ?? receiver.address.split("@")[1], await loadTenant(receiver.tenantId ?? rd?.tenantId ?? null));
    const t = transportFor(ctx.tenant);
    if (item.folder === "spam") await t.rescue(ctx, item.providerMessageId);
    else await t.markRead(ctx, item.providerMessageId);
  } catch {
    /* engagement is best-effort */
  }

  // Sometimes reply, keeping threads short.
  const depth = send.warmupDepth ?? 0;
  const rand = seededRandom(`reply:${send.id}`);
  if (depth >= 2 || rand() >= policies.warmup.replyRate || !WARM_MAILBOX_STATES.includes(receiver.state as any)) return;
  // A sync can see the same message twice; reply at most once.
  const [already] = await db.select({ id: sends.id }).from(sends).where(and(eq(sends.kind, "warmup"), eq(sends.inReplyTo, item.rfcMessageId!))).limit(1);
  if (already) return;
  const [rd] = receiver.domainId ? await db.select().from(domains).where(eq(domains.id, receiver.domainId)) : [];
  if (!rd) return;
  const [sender] = await db.select().from(mailboxes).where(eq(mailboxes.id, send.mailboxId));
  const delayMin = 10 + Math.floor(rand() * 110);
  const at = new Date(Date.now() + delayMin * 60_000);
  await db.insert(sends).values({
    workspaceId: receiver.workspaceId,
    kind: "warmup",
    mailboxId: receiver.id,
    domainId: rd.id,
    toAddress: send.toAddress === receiver.address ? (sender?.address ?? item.from) : item.from,
    scheduledAt: at,
    localDate: localDate(at, receiver.timezone),
    subject: `Re: ${item.subject.replace(/^re:\s*/i, "")}`,
    body: warmupReply(rand, { firstName: receiver.firstName || receiver.address.split("@")[0] }, { firstName: sender?.firstName ?? "" }),
    warmupDepth: depth + 1,
    inReplyTo: item.rfcMessageId,
    referencesHdr: [item.references, item.rfcMessageId].filter(Boolean).join(" "),
    providerThreadId: item.providerThreadId,
    rfcMessageId: newMessageId(rd.name),
  });
}

/** Per-inbox warmup inbox rate (7 days), unseen-for-24h → missing, early warning on active domains. */
export async function updateWarmupRates(workspaceId: string, now = new Date()) {
  if ((await warmupEngine(workspaceId)) !== "cold") return;
  const db = getDb();
  const policies = await getPolicies(workspaceId);
  await db
    .update(sends)
    .set({ placement: "missing" })
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "warmup"), eq(sends.status, "sent"), isNull(sends.placement), lt(sends.sentAt, new Date(now.getTime() - 24 * 3_600_000))));
  const rows = await db
    .select({ mailboxId: sends.mailboxId, domainId: sends.domainId, placement: sends.placement })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "warmup"), isNotNull(sends.placement), gte(sends.sentAt, new Date(now.getTime() - 7 * 86_400_000))));
  const byMailbox = new Map<string, ("inbox" | "promotions" | "spam" | "missing")[]>();
  const byDomain = new Map<string, ("inbox" | "promotions" | "spam" | "missing")[]>();
  for (const r of rows) {
    byMailbox.set(r.mailboxId, [...(byMailbox.get(r.mailboxId) ?? []), r.placement!]);
    byDomain.set(r.domainId, [...(byDomain.get(r.domainId) ?? []), r.placement!]);
  }
  for (const [id, ps] of byMailbox) {
    const rate = warmupInboxRate(ps);
    if (rate != null) await db.update(mailboxes).set({ warmupInboxRate: rate }).where(eq(mailboxes.id, id));
  }
  const active = await db.select().from(domains).where(and(eq(domains.workspaceId, workspaceId), inArray(domains.state, ["active", "ready"])));
  for (const d of active) {
    const rate = warmupInboxRate(byDomain.get(d.id) ?? [], 20);
    const key = `warmup_warning:${d.id}`;
    if (rate != null && rate < policies.warmup.earlyWarningRate) {
      await raiseAlert(workspaceId, {
        severity: "warning",
        kind: "warmup_warning",
        key,
        title: `${d.name}: only ${Math.round(rate * 100)}% of warmup emails reach the inbox`,
        body: "Warmup mail from this domain is landing in spam. It's often the first sign a domain is burning, days before reply and bounce rates move. Diagnose before replacing.",
        entity: { type: "domain", id: d.id },
        action: { label: "Open domain", href: `/domains/${d.id}` },
      });
    } else await resolveAlert(workspaceId, key);
  }
}

export async function warmupOverview(workspaceId: string) {
  const db = getDb();
  const engine = await warmupEngine(workspaceId);
  const rows = await poolRows(workspaceId);
  const health = warmupPoolHealth(rows.map((r) => member(r.mailbox, r.domain)));
  const since = new Date(Date.now() - 7 * 86_400_000);
  const stats = await db
    .select({
      domainId: sends.domainId,
      sent: sql<number>`count(*) filter (where ${sends.status} = 'sent')::int`,
      scheduled: sql<number>`count(*) filter (where ${sends.status} = 'scheduled')::int`,
      inbox: sql<number>`count(*) filter (where ${sends.placement} in ('inbox','promotions'))::int`,
      spam: sql<number>`count(*) filter (where ${sends.placement} = 'spam')::int`,
      missing: sql<number>`count(*) filter (where ${sends.placement} = 'missing')::int`,
      replies: sql<number>`count(*) filter (where ${sends.warmupDepth} > 0 and ${sends.status} = 'sent')::int`,
    })
    .from(sends)
    .where(and(eq(sends.workspaceId, workspaceId), eq(sends.kind, "warmup"), gte(sends.scheduledAt, since)))
    .groupBy(sends.domainId);
  const names = await db.select({ id: domains.id, name: domains.name, provider: domains.provider, state: domains.state }).from(domains).where(and(eq(domains.workspaceId, workspaceId), ne(domains.state, "retired")));
  const total = stats.reduce((a, s) => ({ sent: a.sent + s.sent, scheduled: a.scheduled + s.scheduled, inbox: a.inbox + s.inbox, spam: a.spam + s.spam, missing: a.missing + s.missing, replies: a.replies + s.replies }), { sent: 0, scheduled: 0, inbox: 0, spam: 0, missing: 0, replies: 0 });
  return {
    engine,
    pool: health,
    last7d: { ...total, inboxRate: total.inbox + total.spam > 0 ? total.inbox / (total.inbox + total.spam) : null },
    domains: stats
      .map((s) => ({ ...s, ...(names.find((n) => n.id === s.domainId) ?? { name: "?", provider: "google", state: "?" }), inboxRate: s.inbox + s.spam > 0 ? s.inbox / (s.inbox + s.spam) : null }))
      .sort((a, b) => (a.inboxRate ?? 1) - (b.inboxRate ?? 1)),
  };
}
