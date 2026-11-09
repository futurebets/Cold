/**
 * Built-in warmup (replaces a paid warmup network such as Instantly's).
 *
 * Cold's own inboxes email each other: a ramped daily volume of natural, link-free messages.
 * Receivers rescue them from spam, mark them read and reply to a share of them. Where each
 * one lands becomes the inbox's warmup placement rate, which feeds the readiness gate (WRM-4)
 * and an early warning on active domains.
 *
 * Pairing rule: never warm two inboxes in the same tenant against each other. Mail inside one
 * Microsoft 365 or Google Workspace tenant is delivered internally and builds no reputation.
 */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Provider } from "./types";

/** Emails an inbox should send today for warmup. Ramps from 2/day, then holds; lower once the inbox sends cold email. */
export function warmupDailyTarget(day: number, provider: Provider, opts: { active: boolean; weekend: boolean; policies?: Policies }): number {
  const p = opts.policies ?? DEFAULT_POLICIES;
  const max = provider === "google" ? p.warmup.dailyMaxGoogle : p.warmup.dailyMaxMicrosoft;
  let n = Math.min(max, 2 + Math.floor(Math.max(0, day) * p.warmup.rampPerDay));
  if (opts.active) n = Math.max(1, Math.round(n * p.warmup.activeShare));
  if (opts.weekend) n = Math.max(1, Math.round(n / 2));
  return n;
}

export interface PoolMember {
  id: string;
  address: string;
  domainId: string;
  /** Tenant the mailbox lives in (null when unknown). */
  tenantId: string | null;
  provider: Provider;
}

/**
 * Pick `count` recipients for `sender`: never the same domain or tenant, prefer the other
 * provider, prefer inboxes that have received the least today.
 */
export function pickWarmupRecipients(sender: PoolMember, pool: PoolMember[], count: number, rand: () => number, receivedToday: Map<string, number> = new Map()): PoolMember[] {
  const eligible = pool.filter((m) => m.id !== sender.id && m.domainId !== sender.domainId && (sender.tenantId == null || m.tenantId == null || m.tenantId !== sender.tenantId));
  const scored = eligible
    .map((m) => ({ m, score: (m.provider !== sender.provider ? 0 : 1) * 2 + (receivedToday.get(m.id) ?? 0) * 0.5 + rand() }))
    .sort((a, b) => a.score - b.score);
  const out = scored.slice(0, Math.max(0, count)).map((s) => s.m);
  for (const m of out) receivedToday.set(m.id, (receivedToday.get(m.id) ?? 0) + 1);
  return out;
}

/** Pool health: can warmup produce a meaningful signal? */
export function warmupPoolHealth(pool: PoolMember[]) {
  const tenants = new Set(pool.map((m) => m.tenantId ?? `domain:${m.domainId}`));
  const providers = new Set(pool.map((m) => m.provider));
  const domains = new Set(pool.map((m) => m.domainId));
  const issues: string[] = [];
  if (pool.length < 2 || domains.size < 2) issues.push("Warmup needs inboxes on at least two domains.");
  if (tenants.size < 2) issues.push("All inboxes are in one tenant. Mail inside a tenant is delivered internally and doesn't build reputation, so add a second tenant or provider.");
  if (providers.size < 2) issues.push("Only one provider in the pool. Mixing Google and Microsoft inboxes gives a stronger signal.");
  if (pool.length < 20) issues.push("A small pool sends the same few inboxes the same messages. 20+ inboxes works better.");
  return { inboxes: pool.length, domains: domains.size, tenants: tenants.size, providers: [...providers], ok: issues.length === 0, canRun: pool.length >= 2 && domains.size >= 2 && tenants.size >= 2, issues };
}

const SUBJECTS = [
  "quick question", "thursday", "notes from today", "following up", "re: the plan", "next week", "budget numbers", "draft attached below", "catching up",
  "lunch?", "timeline", "update", "one more thing", "thoughts?", "for review", "the proposal", "q1 planning", "agenda", "call recap", "small change",
  "checking in", "the schedule", "invoice question", "team offsite", "kickoff",
];

const OPENERS = ["Hi {name},", "Hey {name},", "Morning {name},", "Hi {name}, hope the week is going well.", "{name},", "Hi {name}, quick one."];

const BODIES = [
  "I went through the notes from yesterday. The second option looks more realistic given the timeline. Can we lock it in by Friday?",
  "Do you still have the numbers from last month? I want to compare them before the review.",
  "Moved our sync to Thursday at 2. Let me know if that clashes with anything on your side.",
  "I've cleaned up the draft and kept the structure you suggested. Mostly wording changes in the middle section.",
  "Are we still planning to start the rollout next week, or is that slipping?",
  "Thanks for sending this over. I'll read it properly tonight and send comments tomorrow morning.",
  "Can you remind me who owns the vendor contract? I need to ask them about the renewal date.",
  "The team liked the idea. A couple of people asked whether we could pilot it with one group first.",
  "I'm out Monday, so if anything urgent comes up, Sam can cover.",
  "Quick heads up that the shared folder moved. Same name, new location under projects.",
  "Got the update, thanks. One question on the estimate: does that include the setup work?",
  "Let's keep the meeting short this week. Three items max.",
  "Would it be easier to go through this on a call? Fifteen minutes should do it.",
  "I added my comments inline. Nothing major, mostly questions.",
  "Just confirming we're aligned on the dates before I send the invite.",
  "Sorry for the slow reply, it's been a busy week. The plan works for me.",
  "Do you want me to take the first pass at the summary, or are you already on it?",
  "Small change from my side: can we push the review by a day?",
];

const CLOSERS = ["Thanks,", "Cheers,", "Best,", "Talk soon,", "Thanks!", ""];

const REPLIES = [
  "Sounds good, thanks.",
  "Works for me. I'll update the calendar.",
  "Thanks, got it. I'll take a look this afternoon.",
  "Yes, Friday is fine.",
  "Good point. Let me check and get back to you.",
  "Agreed. Let's go with that.",
  "Thanks for the heads up.",
  "No clash on my side, Thursday works.",
  "I'll send the numbers over shortly.",
  "Perfect, appreciate it.",
  "Makes sense. I'll let the team know.",
];

const pick = <T>(xs: T[], rand: () => number): T => xs[Math.floor(rand() * xs.length) % xs.length];

/** A natural, link-free warmup email. */
export function warmupMessage(rand: () => number, sender: { firstName: string }, recipient: { firstName: string }): { subject: string; body: string } {
  const name = recipient.firstName || "there";
  const parts = [pick(OPENERS, rand).replace("{name}", name), "", pick(BODIES, rand)];
  if (rand() < 0.35) parts.push("", pick(BODIES, rand));
  const closer = pick(CLOSERS, rand);
  parts.push("", closer ? `${closer}\n${sender.firstName}` : sender.firstName);
  return { subject: pick(SUBJECTS, rand), body: parts.join("\n").replace(/\n{3,}/g, "\n\n") };
}

export function warmupReply(rand: () => number, sender: { firstName: string }, recipient: { firstName: string }): string {
  const greet = rand() < 0.5 ? `${recipient.firstName || "Hi"},\n\n` : "";
  return `${greet}${pick(REPLIES, rand)}\n\n${sender.firstName}`;
}

/** Inbox share of warmup emails with known placement. Null when there is too little data. */
export function warmupInboxRate(placements: ("inbox" | "promotions" | "spam" | "missing")[], minSample = 10): number | null {
  const known = placements.filter((p) => p !== "missing");
  if (known.length < minSample) return null;
  return known.filter((p) => p !== "spam").length / known.length;
}
