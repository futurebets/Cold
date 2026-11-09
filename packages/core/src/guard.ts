/**
 * Pre-flight guard (SPEC §5 invariants, SCH-9). Runs immediately before every send.
 * Any failure skips the send with a reason code.
 */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Connection, DomainState, MailboxState, ProspectBucket, Provider, Seg, ValidationStatus } from "./types";
import { authFresh, isProtected } from "./domains";

export type SendKind = "first_touch" | "follow_up" | "seed" | "header_test" | "warmup";

export type SkipReason =
  | "PROTECTED_DOMAIN"
  | "PROVIDER_NOT_ALLOWED"
  | "DOMAIN_NOT_SENDING"
  | "MAILBOX_NOT_SENDING"
  | "NOT_CONNECTED"
  | "CAP_MAILBOX"
  | "CAP_DOMAIN"
  | "AUTH_STALE"
  | "WARMUP_INCOMPLETE"
  | "NOT_VALIDATED"
  | "VALIDATION_EXPIRED"
  | "BUCKET_NOT_SENDABLE"
  | "SEG_BLOCKED"
  | "SUPPRESSED"
  | "LINT_BLOCK"
  | "MISSING_MERGE"
  | "TRACKING_CONTENT"
  | "CAMPAIGN_NOT_ACTIVE"
  | "OUT_OF_WINDOW";

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  PROTECTED_DOMAIN: "Sender is on a protected primary domain",
  PROVIDER_NOT_ALLOWED: "Mailbox is not Google Workspace or Microsoft 365",
  DOMAIN_NOT_SENDING: "Domain is not in a sending state",
  MAILBOX_NOT_SENDING: "Mailbox is not in a sending state",
  NOT_CONNECTED: "Mailbox is disconnected",
  CAP_MAILBOX: "Mailbox reached its daily cap",
  CAP_DOMAIN: "Domain reached its daily cap",
  AUTH_STALE: "SPF/DKIM/DMARC not verified in the last 24h",
  WARMUP_INCOMPLETE: "Mailbox warmup is below the minimum",
  NOT_VALIDATED: "Recipient was never validated",
  VALIDATION_EXPIRED: "Recipient validation expired",
  BUCKET_NOT_SENDABLE: "Recipient is invalid, unknown, or catch-all outside a catch-all campaign",
  SEG_BLOCKED: "Recipient is behind a blocked secure email gateway",
  SUPPRESSED: "Recipient is suppressed (opt-out, bounce or do-not-contact)",
  LINT_BLOCK: "Copy has blocking lint findings",
  MISSING_MERGE: "A merge field has no value and no fallback",
  TRACKING_CONTENT: "Message contains HTML, links, images or a tracking pixel",
  CAMPAIGN_NOT_ACTIVE: "Campaign is not active",
  OUT_OF_WINDOW: "Outside the recipient's sending window",
};

export interface PreflightContext {
  kind: SendKind;
  now?: Date;
  policies?: Policies;
  protectedDomains: string[];
  domain: { name: string; provider: Provider | string; state: DomainState; authVerifiedAt: Date | string | null };
  mailbox: { state: MailboxState; connection: Connection; warmupDays: number; address: string };
  caps: { mailboxSent: number; mailboxCap: number; domainSent: number; domainCap: number };
  prospect?: {
    validationStatus: ValidationStatus | null;
    validatedAt: Date | string | null;
    bucket: ProspectBucket;
    seg: Seg | null;
    suppressed: boolean;
  };
  campaign?: { status: string; isCatchAll: boolean };
  message?: { body: string; lintBlocks: number; missingMerge: string[] };
  inWindow?: boolean;
}

const SENDING_DOMAIN_STATES: Record<SendKind, DomainState[]> = {
  first_touch: ["active"],
  follow_up: ["active", "layover"],
  seed: ["active", "flagged", "diagnosing", "ready", "warming"],
  header_test: ["pending_dns", "auth_verified", "warming", "ready", "active", "flagged", "diagnosing", "auth_failed"],
  warmup: ["warming", "ready", "active", "flagged", "diagnosing", "layover"],
};

const SENDING_MAILBOX_STATES: Record<SendKind, MailboxState[]> = {
  first_touch: ["active"],
  follow_up: ["active", "relay"],
  seed: ["active", "paused", "ready", "warming"],
  header_test: ["provisioning", "warming", "ready", "active", "paused"],
  warmup: ["warming", "ready", "active", "paused"],
};

export function preflight(ctx: PreflightContext): { ok: boolean; reasons: SkipReason[] } {
  const policies = ctx.policies ?? DEFAULT_POLICIES;
  const now = ctx.now ?? new Date();
  const r: SkipReason[] = [];
  const senderDomain = ctx.mailbox.address.split("@").pop() ?? "";

  // I-1, I-2 (always)
  if (isProtected(ctx.domain.name, ctx.protectedDomains) || isProtected(senderDomain, ctx.protectedDomains)) r.push("PROTECTED_DOMAIN");
  if (ctx.domain.provider !== "google" && ctx.domain.provider !== "microsoft") r.push("PROVIDER_NOT_ALLOWED");
  if (ctx.mailbox.connection !== "connected") r.push("NOT_CONNECTED");

  if (!SENDING_DOMAIN_STATES[ctx.kind].includes(ctx.domain.state)) r.push("DOMAIN_NOT_SENDING");
  if (!SENDING_MAILBOX_STATES[ctx.kind].includes(ctx.mailbox.state)) r.push("MAILBOX_NOT_SENDING");

  // Warmup has its own daily quota and never counts toward cold-email caps (CAP-3).
  if (ctx.kind !== "header_test" && ctx.kind !== "warmup") {
    // I-3
    if (ctx.caps.mailboxSent >= ctx.caps.mailboxCap) r.push("CAP_MAILBOX");
    if (ctx.caps.domainSent >= ctx.caps.domainCap) r.push("CAP_DOMAIN");
  }
  // I-4 (warmup too: an unauthenticated domain warms itself into spam)
  if (ctx.kind !== "header_test" && !authFresh(ctx.domain.authVerifiedAt, policies, now)) r.push("AUTH_STALE");
  // I-5
  if ((ctx.kind === "first_touch" || ctx.kind === "follow_up") && ctx.mailbox.warmupDays < policies.warmup.minDays) r.push("WARMUP_INCOMPLETE");

  if (ctx.kind === "first_touch" || ctx.kind === "follow_up") {
    const p = ctx.prospect;
    if (!p) r.push("NOT_VALIDATED");
    else {
      // I-6, I-9
      if (p.suppressed) r.push("SUPPRESSED");
      if (p.seg && policies.lists.blockedSegs.includes(p.seg)) r.push("SEG_BLOCKED");
      if (!p.validationStatus || !p.validatedAt) r.push("NOT_VALIDATED");
      else if (ctx.kind === "first_touch" && now.getTime() - new Date(p.validatedAt).getTime() > policies.lists.validationTtlDays * 86_400_000)
        r.push("VALIDATION_EXPIRED");
      const sendable = ctx.campaign?.isCatchAll ? p.bucket === "catch_all" : p.bucket === "ready";
      if (!sendable) r.push("BUCKET_NOT_SENDABLE");
    }
    if (!ctx.campaign || ctx.campaign.status !== "active") r.push("CAMPAIGN_NOT_ACTIVE");
    if (ctx.inWindow === false) r.push("OUT_OF_WINDOW");
  }

  // I-7
  if (ctx.message) {
    if (ctx.message.lintBlocks > 0) r.push("LINT_BLOCK");
    if (ctx.message.missingMerge.length > 0) r.push("MISSING_MERGE");
    if (/<\s*(img|a|html|body|div|span|p)\b|https?:\/\//i.test(ctx.message.body)) r.push("TRACKING_CONTENT");
  }
  return { ok: r.length === 0, reasons: [...new Set(r)] };
}
