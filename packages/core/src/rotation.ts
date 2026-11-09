/** Rotation without stopping (SPEC §6.14, playbook rule 14) and reserve coverage (§6.6, rule 7). */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { DomainState, Pool, Provider } from "./types";
import { authFresh } from "./domains";

export interface CandidateDomain {
  id: string;
  name: string;
  provider: Provider;
  state: DomainState;
  pool: Pool;
  authVerifiedAt: Date | string | null;
  /** Minimum warmup days across the domain's mailboxes. */
  warmupDays: number;
  warmupHealthy: boolean;
  /** Daily cap of the domain. */
  capacity: number;
  /** Days until ready, for warming candidates. */
  readyInDays?: number;
}

export interface RankedCandidate extends CandidateDomain {
  eligible: boolean;
  reasons: string[];
}

export function rankReplacements(
  outgoing: { provider: Provider; capacity: number },
  candidates: CandidateDomain[],
  policies: Policies = DEFAULT_POLICIES,
  now: Date = new Date(),
): RankedCandidate[] {
  return candidates
    .filter((c) => c.pool === "reserve")
    .map((c) => {
      const reasons: string[] = [];
      if (c.provider !== outgoing.provider) reasons.push("Different provider");
      if (c.state !== "ready") reasons.push(c.state === "warming" ? `Still warming (${c.warmupDays}/${policies.warmup.minDays} days)` : `State is ${c.state}`);
      if (c.warmupDays < policies.warmup.minDays) reasons.push(`Warmup ${c.warmupDays}d < ${policies.warmup.minDays}d minimum`);
      if (!authFresh(c.authVerifiedAt, policies, now)) reasons.push("Authentication not verified in the last 24h");
      if (!c.warmupHealthy) reasons.push("Warmup placement below threshold");
      return { ...c, eligible: reasons.length === 0, reasons };
    })
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.provider !== b.provider) return a.provider === outgoing.provider ? -1 : 1;
      const capA = a.capacity >= outgoing.capacity ? 1 : 0;
      const capB = b.capacity >= outgoing.capacity ? 1 : 0;
      if (capA !== capB) return capB - capA;
      return b.warmupDays - a.warmupDays;
    });
}

export interface RotationPlan {
  mode: "immediate" | "layover";
  replacement: RankedCandidate | null;
  /** Best warming candidate when no replacement is ready. */
  nextUp: RankedCandidate | null;
  capacityBefore: number;
  capacityAfter: number;
  layoverDays: number;
  relayDays: number;
  steps: string[];
}

export function planRotation(
  outgoing: { name: string; provider: Provider; capacity: number },
  candidates: CandidateDomain[],
  activeCapacity: number,
  policies: Policies = DEFAULT_POLICIES,
  now: Date = new Date(),
): RotationPlan {
  const ranked = rankReplacements(outgoing, candidates, policies, now);
  const replacement = ranked.find((c) => c.eligible) ?? null;
  const nextUp = replacement ? null : ranked.find((c) => c.provider === outgoing.provider && c.state === "warming") ?? null;
  const layoverDays = policies.rotation.layoverDays;
  const relayDays = policies.rotation.relayDays;
  if (replacement) {
    return {
      mode: "immediate",
      replacement,
      nextUp: null,
      capacityBefore: activeCapacity,
      capacityAfter: activeCapacity - outgoing.capacity + replacement.capacity,
      layoverDays,
      relayDays,
      steps: [
        `Promote ${replacement.name} from reserve to active (${replacement.warmupDays} days warm).`,
        `Attach it to ${outgoing.name}'s mailbox pool so campaigns keep sending.`,
        `Move unreplied in-flight sequences to the new inboxes (standalone copy) or end them.`,
        `Put ${outgoing.name} into Relay for ${relayDays} days so every reply still arrives.`,
        "Order a like-for-like replacement into reserve.",
      ],
    };
  }
  return {
    mode: "layover",
    replacement: null,
    nextUp,
    capacityBefore: activeCapacity,
    capacityAfter: activeCapacity - outgoing.capacity,
    layoverDays,
    relayDays,
    steps: [
      `No warmed replacement is ready. ${outgoing.name} enters a ${layoverDays}-day Layover.`,
      "During Layover: no new first emails, but follow-ups continue in existing threads and replies keep arriving.",
      nextUp ? `${nextUp.name} becomes the replacement when ready (in ~${nextUp.readyInDays ?? "?"} days).` : "Order replacements now. Nothing is warming for this provider.",
      `After Layover, ${outgoing.name} moves to Relay for ${relayDays} days.`,
    ],
  };
}

export type MigrationAction = "keep_thread" | "move_standalone" | "end_sequence" | "none";

/** What happens to one enrollment on an outgoing mailbox (ROT-4). */
export function migrationFor(e: { status: string; hasReply: boolean; hasNextStep: boolean; standaloneAvailable: boolean }): MigrationAction {
  if (e.hasReply || e.status === "replied") return "keep_thread";
  if (e.status !== "active" || !e.hasNextStep) return "none";
  return e.standaloneAvailable ? "move_standalone" : "end_sequence";
}

export interface CoverageDomain {
  provider: Provider;
  pool: Pool;
  state: DomainState;
  capacity: number;
  readyInDays?: number | null;
}

export interface Coverage {
  provider: Provider;
  activeCapacity: number;
  readyReserveCapacity: number;
  warmingReserveCapacity: number;
  ratio: number | null;
  target: number;
  status: "ok" | "warn" | "critical" | "none";
}

/** Reserve coverage per provider (RSV-2, RSV-3). */
export function reserveCoverage(domains: CoverageDomain[], policies: Policies = DEFAULT_POLICIES): Coverage[] {
  const providers: Provider[] = ["google", "microsoft"];
  return providers
    .map((provider) => {
      const ds = domains.filter((d) => d.provider === provider);
      const activeCapacity = ds.filter((d) => d.pool === "active" && ["active", "flagged", "diagnosing"].includes(d.state)).reduce((a, d) => a + d.capacity, 0);
      const readyReserveCapacity = ds.filter((d) => d.pool === "reserve" && d.state === "ready").reduce((a, d) => a + d.capacity, 0);
      const warmingReserveCapacity = ds
        .filter((d) => d.pool === "reserve" && ["warming", "auth_verified", "pending_dns"].includes(d.state))
        .reduce((a, d) => a + d.capacity, 0);
      const ratio = activeCapacity > 0 ? readyReserveCapacity / activeCapacity : null;
      const target = policies.reserve.ratio;
      const status: Coverage["status"] =
        activeCapacity === 0 ? "none" : ratio! >= target ? "ok" : ratio! >= target * 0.5 ? "warn" : "critical";
      return { provider, activeCapacity, readyReserveCapacity, warmingReserveCapacity, ratio, target, status };
    })
    .filter((c) => c.activeCapacity > 0 || c.readyReserveCapacity > 0 || c.warmingReserveCapacity > 0);
}
