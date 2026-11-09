/**
 * Inbox sync and ingestion (SPEC §6.11). Every inbound message to any non-decommissioned
 * mailbox is stored and threaded (invariant I-8), including relay and layover mailboxes.
 */
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { classifyInbound, emailKey } from "@cold/core";
import { getDb, schema } from "../db/client";
import { notFound } from "../lib/http";
import { transportFor, type InboundItem } from "../adapters/transport";
import { getPolicies, getWorkspace, mailboxCtx, notify, raiseAlert } from "./common";
import { suppress } from "./lists";
import { findWarmupSend, handleWarmupInbound } from "./warmup";

const { mailboxes, domains, tenants, sends, enrollments, threads, messages, prospects } = schema;
type MailboxRow = typeof mailboxes.$inferSelect;

export async function syncWorkspace(workspaceId: string) {
  const db = getDb();
  const rows = await db
    .select({ mailbox: mailboxes, domain: domains })
    .from(mailboxes)
    .innerJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(mailboxes.state, ["warming", "ready", "active", "paused", "relay"]),
        eq(mailboxes.connection, "connected"),
        eq(mailboxes.isSeed, false),
      ),
    );
  let ingested = 0;
  for (const { mailbox, domain } of rows) {
    try {
      const tenant = domain.tenantId ? (await db.select().from(tenants).where(eq(tenants.id, domain.tenantId)))[0] ?? null : null;
      const ctx = await mailboxCtx(mailbox, domain.name, tenant);
      const { items, cursor } = await transportFor(ctx.tenant).fetchInbound(ctx, mailbox.syncCursor);
      for (const item of items) if (await ingest(mailbox, item)) ingested++;
      await db.update(mailboxes).set({ syncCursor: cursor, lastSyncedAt: new Date() }).where(eq(mailboxes.id, mailbox.id));
    } catch (e: any) {
      await db.update(mailboxes).set({ connectionDetail: `Sync failed: ${String(e?.message ?? e).slice(0, 300)}` }).where(eq(mailboxes.id, mailbox.id));
    }
  }
  return { mailboxes: rows.length, ingested };
}

async function matchSend(mb: MailboxRow, item: InboundItem, bounceRecipient: string | null) {
  const db = getDb();
  const ids = [item.inReplyTo, ...(item.references ?? "").split(/\s+/)].filter(Boolean).map((x) => x!.trim()) as string[];
  if (ids.length) {
    const [s] = await db
      .select()
      .from(sends)
      .where(and(eq(sends.mailboxId, mb.id), inArray(sends.rfcMessageId, ids)))
      .orderBy(desc(sends.sentAt))
      .limit(1);
    if (s) return s;
  }
  if (item.providerThreadId) {
    const [s] = await db
      .select()
      .from(sends)
      .where(and(eq(sends.mailboxId, mb.id), eq(sends.providerThreadId, item.providerThreadId), eq(sends.status, "sent")))
      .orderBy(desc(sends.sentAt))
      .limit(1);
    if (s) return s;
  }
  const to = bounceRecipient ?? (item.from ? emailKey(item.from) : null);
  if (to) {
    const [s] = await db
      .select()
      .from(sends)
      .where(and(eq(sends.mailboxId, mb.id), eq(sends.toAddress, to), eq(sends.status, "sent"), gte(sends.sentAt, new Date(Date.now() - 30 * 86_400_000))))
      .orderBy(desc(sends.sentAt))
      .limit(1);
    if (s) return s;
  }
  return null;
}

export async function ingest(mb: MailboxRow, item: InboundItem): Promise<boolean> {
  const db = getDb();
  const [dupe] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.mailboxId, mb.id), eq(messages.providerMessageId, item.providerMessageId)))
    .limit(1);
  if (dupe) return false;
  // Warmup mail between Cold's own inboxes: record placement, engage, maybe reply. Never shown in the inbox.
  const warm = await findWarmupSend(mb.workspaceId, item);
  if (warm) {
    await handleWarmupInbound(mb, item, warm);
    return false;
  }
  const ws = await getWorkspace(mb.workspaceId);
  const policies = await getPolicies(mb.workspaceId);
  const warmupPattern = ws.settings.warmupPattern ? safeRegex(ws.settings.warmupPattern) : undefined;
  const c = classifyInbound({ from: item.from, subject: item.subject, body: item.body, headers: item.headers, contentType: item.contentType }, { warmupPattern });
  if (c.kind === "warmup") return false;

  const send = await matchSend(mb, item, c.bounce?.recipient ?? null);
  const enrollment = send?.enrollmentId ? (await db.select().from(enrollments).where(eq(enrollments.id, send.enrollmentId)))[0] ?? null : null;

  // Thread: the send's thread, else provider thread, else a new one (never drop a conversation).
  let thread = enrollment?.threadId ? (await db.select().from(threads).where(eq(threads.id, enrollment.threadId)))[0] ?? null : null;
  if (!thread && item.providerThreadId)
    thread = (await db.select().from(threads).where(and(eq(threads.mailboxId, mb.id), eq(threads.providerThreadId, item.providerThreadId))))[0] ?? null;
  const counterpart = c.kind === "bounce" ? (send?.toAddress ?? c.bounce?.recipient ?? item.from) : emailKey(item.from);
  if (!thread) {
    [thread] = await db
      .insert(threads)
      .values({
        workspaceId: mb.workspaceId,
        mailboxId: mb.id,
        prospectId: send?.prospectId ?? null,
        enrollmentId: send?.enrollmentId ?? null,
        campaignId: send?.campaignId ?? null,
        providerThreadId: item.providerThreadId,
        subject: item.subject,
        counterpart,
        lastMessageAt: item.receivedAt,
      })
      .returning();
  }
  await db
    .insert(messages)
    .values({
      workspaceId: mb.workspaceId,
      threadId: thread.id,
      mailboxId: mb.id,
      direction: "in",
      fromAddr: item.from,
      toAddr: item.to,
      subject: item.subject,
      bodyText: item.body.slice(0, 100_000),
      headers: Object.fromEntries(Object.entries(item.headers).filter(([k]) => /^(message-id|in-reply-to|references|auto-submitted|content-type|authentication-results|precedence)$/i.test(k))),
      rfcMessageId: item.rfcMessageId,
      providerMessageId: item.providerMessageId,
      classification: c.kind,
      intent: c.intent ?? null,
      sendId: send?.id ?? null,
    })
    .onConflictDoNothing();

  const threadPatch: Partial<typeof threads.$inferInsert> = { lastMessageAt: item.receivedAt, classification: c.kind };

  if (c.kind === "bounce" && c.bounce) {
    if (send && !send.bouncedAt)
      await db.update(sends).set({ bouncedAt: item.receivedAt, bounceType: c.bounce.type, bounceCategory: c.bounce.category }).where(eq(sends.id, send.id));
    if (c.bounce.type === "hard") {
      const addr = send?.toAddress ?? c.bounce.recipient;
      if (addr) await suppress(mb.workspaceId, { email: addr, reason: "hard_bounce", source: `bounce ${c.bounce.status ?? ""} via ${mb.address}` });
      if (enrollment) await db.update(enrollments).set({ status: "bounced" }).where(eq(enrollments.id, enrollment.id));
    }
    threadPatch.archived = true;
  } else if (c.kind === "auto_reply") {
    if (send && !send.replyKind) await db.update(sends).set({ replyKind: "auto" }).where(eq(sends.id, send.id));
    if (enrollment && enrollment.status === "active") {
      const resume = c.returnDate ? new Date(`${c.returnDate}T13:00:00Z`) : new Date(Date.now() + policies.sequence.oooPauseDays * 86_400_000);
      if (!enrollment.nextDueAt || enrollment.nextDueAt < resume) await db.update(enrollments).set({ nextDueAt: resume }).where(eq(enrollments.id, enrollment.id));
    }
    threadPatch.archived = true;
  } else if (c.kind === "human") {
    if (send) await db.update(sends).set({ repliedAt: item.receivedAt, replyKind: "human" }).where(eq(sends.id, send.id));
    if (enrollment && ["active", "paused"].includes(enrollment.status)) await db.update(enrollments).set({ status: "replied" }).where(eq(enrollments.id, enrollment.id));
    threadPatch.unread = true;
    threadPatch.lastInboundAt = item.receivedAt;
    threadPatch.intent = c.intent ?? null;
    threadPatch.archived = false;
    if (c.intent === "opt_out" && c.optOutConfidence === "high") {
      await suppress(mb.workspaceId, { email: item.from, reason: "opt_out", source: `reply to ${mb.address}` });
    } else if (c.optOutConfidence === "low") {
      threadPatch.needsReview = true;
    }
    if (c.intent === "positive") {
      const p = thread.prospectId ? (await db.select().from(prospects).where(eq(prospects.id, thread.prospectId)))[0] : null;
      await notify(mb.workspaceId, `🟢 Positive reply from ${p ? `${p.firstName ?? ""} ${p.lastName ?? ""} (${p.company ?? item.from})` : item.from} to ${mb.address}:\n> ${c.cleanBody.slice(0, 280)}`);
    }
  }
  await db.update(threads).set(threadPatch).where(eq(threads.id, thread.id));
  return true;
}

function safeRegex(src: string): RegExp | undefined {
  try {
    return new RegExp(src, "i");
  } catch {
    return undefined;
  }
}

// ───────────── Read models ─────────────

export async function listThreads(workspaceId: string, q: { filter?: string; search?: string; mailboxId?: string; limit?: number }) {
  const db = getDb();
  const conds = [eq(threads.workspaceId, workspaceId), sql`${threads.lastInboundAt} is not null or ${threads.classification} is not null`];
  switch (q.filter) {
    case "positive":
      conds.push(eq(threads.intent, "positive"));
      break;
    case "review":
      conds.push(eq(threads.needsReview, true));
      break;
    case "unread":
      conds.push(eq(threads.unread, true));
      break;
    case "auto":
      conds.push(inArray(threads.classification, ["auto_reply", "bounce"]));
      break;
    case "all":
      break;
    default:
      conds.push(eq(threads.archived, false), eq(threads.classification, "human"));
  }
  if (q.mailboxId) conds.push(eq(threads.mailboxId, q.mailboxId));
  if (q.search) conds.push(or(sql`${threads.counterpart} ilike ${"%" + q.search + "%"}`, sql`${threads.subject} ilike ${"%" + q.search + "%"}`)!);
  const rows = await db
    .select({ thread: threads, mailbox: { address: mailboxes.address, state: mailboxes.state }, domain: { name: domains.name, state: domains.state }, prospect: { firstName: prospects.firstName, lastName: prospects.lastName, company: prospects.company, title: prospects.title } })
    .from(threads)
    .innerJoin(mailboxes, eq(threads.mailboxId, mailboxes.id))
    .leftJoin(domains, eq(mailboxes.domainId, domains.id))
    .leftJoin(prospects, eq(threads.prospectId, prospects.id))
    .where(and(...conds))
    .orderBy(desc(threads.lastMessageAt))
    .limit(Math.min(q.limit ?? 100, 300));
  const ids = rows.map((r) => r.thread.id);
  const last = ids.length
    ? await db
        .selectDistinctOn([messages.threadId], { threadId: messages.threadId, body: messages.bodyText, direction: messages.direction })
        .from(messages)
        .where(inArray(messages.threadId, ids))
        .orderBy(messages.threadId, desc(messages.createdAt))
    : [];
  const snippet = new Map(last.map((l) => [l.threadId, l.body.split(/\n\s*\n|\nOn .*wrote:/)[0].slice(0, 160)]));
  const counts = await db
    .select({
      positive: sql<number>`count(*) filter (where ${threads.intent} = 'positive' and not ${threads.archived})::int`,
      review: sql<number>`count(*) filter (where ${threads.needsReview})::int`,
      unread: sql<number>`count(*) filter (where ${threads.unread})::int`,
    })
    .from(threads)
    .where(eq(threads.workspaceId, workspaceId));
  return { threads: rows.map((r) => ({ ...r.thread, mailbox: r.mailbox, domain: r.domain, prospect: r.prospect, snippet: snippet.get(r.thread.id) ?? "" })), counts: counts[0] };
}

export async function getThread(workspaceId: string, id: string) {
  const db = getDb();
  const [t] = await db.select().from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.id, id)));
  if (!t) throw notFound("Conversation not found");
  const msgs = await db.select().from(messages).where(eq(messages.threadId, t.id)).orderBy(messages.createdAt);
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId));
  const [d] = mb?.domainId ? await db.select().from(domains).where(eq(domains.id, mb.domainId)) : [];
  const p = t.prospectId ? (await db.select().from(prospects).where(eq(prospects.id, t.prospectId)))[0] ?? null : null;
  if (t.unread) await db.update(threads).set({ unread: false }).where(eq(threads.id, t.id));
  return { thread: t, messages: msgs, mailbox: mb, domain: d ?? null, prospect: p };
}

export async function resolveReview(workspaceId: string, threadId: string, suppressIt: boolean) {
  const db = getDb();
  const [t] = await db.select().from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.id, threadId)));
  if (!t) throw notFound("Conversation not found");
  if (suppressIt) await suppress(workspaceId, { email: t.counterpart, reason: "opt_out", source: "reviewed reply" });
  await db.update(threads).set({ needsReview: false }).where(eq(threads.id, t.id));
}

export async function archiveThread(workspaceId: string, threadId: string, archived: boolean) {
  await getDb().update(threads).set({ archived, unread: false }).where(and(eq(threads.workspaceId, workspaceId), eq(threads.id, threadId)));
}

export { raiseAlert };
