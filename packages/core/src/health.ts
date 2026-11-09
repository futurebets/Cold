/** Health measurement (SPEC §6.12, playbook rules 10 and 12). */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Verdict } from "./types";

export interface SendOutcome {
  sentAt: Date | string;
  hardBounce: boolean;
  humanReply: boolean;
}

export interface Baseline {
  replyRate: number;
  bounceRate: number;
  source: "own" | "cohort";
}

export interface HealthEvaluation {
  verdict: Verdict;
  sends: number;
  hardBounces: number;
  humanReplies: number;
  replyRate: number;
  bounceRate: number;
  firstSendAt: Date | null;
  lastSendAt: Date | null;
  baseline: Baseline | null;
  reasons: string[];
  /** Mature sends still needed for an actionable verdict. */
  needed: number;
}

const t = (d: Date | string) => new Date(d).getTime();

/**
 * Evaluate the most recent `minSample` mature sends (HLT-2, HLT-3) since `since` (HLT-9),
 * within the lookback cap (HLT-4), against the baseline (HLT-5, HLT-6).
 */
export function evaluateHealth(input: {
  sends: SendOutcome[];
  now?: Date;
  since?: Date | string | null;
  baseline?: Baseline | null;
  policies?: Policies;
}): HealthEvaluation {
  const policies = input.policies ?? DEFAULT_POLICIES;
  const h = policies.health;
  const now = (input.now ?? new Date()).getTime();
  const matureBefore = now - h.maturityHours * 3_600_000;
  const lookback = now - h.maxLookbackDays * 86_400_000;
  const since = input.since ? t(input.since) : -Infinity;

  const mature = input.sends
    .filter((s) => {
      const ts = t(s.sentAt);
      return ts <= matureBefore && ts >= lookback && ts >= since;
    })
    .sort((a, b) => t(b.sentAt) - t(a.sentAt));
  const window = mature.slice(0, h.minSample);
  const n = window.length;
  const hardBounces = window.filter((s) => s.hardBounce).length;
  const humanReplies = window.filter((s) => s.humanReply).length;
  const replyRate = n ? humanReplies / n : 0;
  const bounceRate = n ? hardBounces / n : 0;
  const base: HealthEvaluation = {
    verdict: "insufficient_data",
    sends: n,
    hardBounces,
    humanReplies,
    replyRate,
    bounceRate,
    firstSendAt: n ? new Date(window[n - 1].sentAt) : null,
    lastSendAt: n ? new Date(window[0].sentAt) : null,
    baseline: input.baseline ?? null,
    reasons: [],
    needed: Math.max(0, h.minSample - n),
  };
  if (n < h.minSample) {
    base.reasons.push(`${n.toLocaleString()} of ${h.minSample.toLocaleString()} mature sends. Keep sending before judging this domain.`);
    return base;
  }

  const lowReply = replyRate < h.redReplyRateBelow;
  const highBounce = bounceRate > h.redBounceRateAbove;
  if (lowReply && highBounce) {
    base.verdict = "red";
    base.reasons.push(`Reply rate ${pct(replyRate)} < ${pct(h.redReplyRateBelow)} and bounce rate ${pct(bounceRate)} > ${pct(h.redBounceRateAbove)}. Clear warning.`);
    return base;
  }
  const reasons: string[] = [];
  if (lowReply) reasons.push(`Reply rate ${pct(replyRate)} is below ${pct(h.redReplyRateBelow)}.`);
  if (highBounce) reasons.push(`Bounce rate ${pct(bounceRate)} is above ${pct(h.redBounceRateAbove)}.`);
  const b = input.baseline;
  if (b) {
    if (b.replyRate > 0 && replyRate < b.replyRate * h.amberReplyVsBaseline)
      reasons.push(`Reply rate ${pct(replyRate)} is under ${Math.round(h.amberReplyVsBaseline * 100)}% of this domain's normal ${pct(b.replyRate)}.`);
    if (bounceRate > b.bounceRate + h.amberBounceOverBaseline)
      reasons.push(`Bounce rate ${pct(bounceRate)} is ${pct(bounceRate - b.bounceRate)} above normal (${pct(b.bounceRate)}).`);
  }
  base.verdict = reasons.length ? "amber" : "green";
  base.reasons = reasons.length ? reasons : ["Within normal range."];
  return base;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface StoredWindow {
  verdict: Verdict;
  replyRate: number;
  bounceRate: number;
  firstSendAt: Date | string | null;
  lastSendAt: Date | string | null;
}

/** Median of the last 3 non-overlapping GREEN windows (HLT-5). */
export function ownBaseline(windows: StoredWindow[]): Baseline | null {
  const greens = windows
    .filter((w) => w.verdict === "green" && w.firstSendAt && w.lastSendAt)
    .sort((a, b) => t(b.lastSendAt!) - t(a.lastSendAt!));
  const picked: StoredWindow[] = [];
  for (const w of greens) {
    const prev = picked[picked.length - 1];
    if (!prev || t(w.lastSendAt!) < t(prev.firstSendAt!)) picked.push(w);
    if (picked.length === 3) break;
  }
  if (picked.length === 0) return null;
  return { replyRate: median(picked.map((w) => w.replyRate)), bounceRate: median(picked.map((w) => w.bounceRate)), source: "own" };
}

/** Cohort baseline from same-provider peers' latest green rates (HLT-5). */
export function cohortBaseline(peers: { replyRate: number; bounceRate: number }[]): Baseline | null {
  if (peers.length === 0) return null;
  return { replyRate: median(peers.map((p) => p.replyRate)), bounceRate: median(peers.map((p) => p.bounceRate)), source: "cohort" };
}

/** HLT-10: share of a campaign's active domains flagged within the window. */
export function correlatedFlag(flaggedDomains: number, activeDomains: number, threshold = 0.3): boolean {
  return activeDomains >= 3 && flaggedDomains / activeDomains >= threshold;
}
