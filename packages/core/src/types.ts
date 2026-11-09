/** Shared domain types for Cold. Kept free of IO so they run in the browser and the server. */

export type Provider = "google" | "microsoft";
export const PROVIDERS: Provider[] = ["google", "microsoft"];
export const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google Workspace",
  microsoft: "Microsoft 365",
};

/** Lifecycle of a sending domain (SPEC §7.1, simplified: purchase happens outside Cold). */
export type DomainState =
  | "pending_dns" // added, DNS/auth not yet verified
  | "auth_verified" // SPF/DKIM/DMARC + header test passed, warmup not started
  | "warming" // warmup running
  | "ready" // warmup complete, not sending
  | "active" // sending campaign email
  | "flagged" // paused: RED verdict or circuit breaker, awaiting diagnosis
  | "diagnosing" // paused: control test running
  | "layover" // outgoing, replacement not ready: follow-ups + replies only
  | "relay" // outgoing: receive + reply only
  | "retired"
  | "auth_failed";

export const DOMAIN_STATES: DomainState[] = [
  "pending_dns",
  "auth_verified",
  "warming",
  "ready",
  "active",
  "flagged",
  "diagnosing",
  "layover",
  "relay",
  "retired",
  "auth_failed",
];

export type Pool = "active" | "reserve" | "retired";

export type MailboxState =
  | "provisioning"
  | "warming"
  | "ready"
  | "active"
  | "paused"
  | "relay"
  | "decommissioned";

export type Connection = "connected" | "disconnected" | "unknown";

export type Verdict = "green" | "amber" | "red" | "insufficient_data";

export type DiagnosisVerdict = "COPY" | "INFRA" | "LIST" | "OFFER" | "AUTH" | "INCONCLUSIVE";

export type ValidationStatus = "valid" | "invalid" | "catch_all" | "unknown" | "disposable";

export type ProspectBucket =
  | "ready"
  | "catch_all"
  | "invalid"
  | "unknown"
  | "disposable"
  | "suppressed"
  | "seg_blocked"
  | "duplicate";

export type RecipientProvider = "google" | "microsoft" | "other" | "none";

export type Seg = "proofpoint" | "mimecast" | "barracuda" | "cisco" | "trendmicro" | "sophos" | "forcepoint";

export type BounceCategory =
  | "user_unknown"
  | "mailbox_full"
  | "policy_or_spam_block"
  | "domain_not_found"
  | "other";

export type Jurisdiction = "none" | "us" | "eu_uk" | "ca";

export type Role = "owner" | "operator" | "sdr" | "viewer";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, sdr: 1, operator: 2, owner: 3 };
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface CampaignSchedule {
  /** ISO weekdays 1=Mon … 7=Sun */
  days: number[];
  startHour: number;
  endHour: number;
  defaultTimezone: string;
  saturday: boolean;
  /** Share (0–1) of weekly first touches moved to Saturday in Saturday-test mode. 0 = off. */
  saturdayTestShare: number;
}

export const DEFAULT_SCHEDULE: CampaignSchedule = {
  days: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 17,
  defaultTimezone: "America/New_York",
  saturday: false,
  saturdayTestShare: 0,
};
