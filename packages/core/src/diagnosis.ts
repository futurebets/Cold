/** Diagnose before replacing (SPEC §6.13, playbook rule 13). */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { BounceCategory, DiagnosisVerdict } from "./types";

export type Folder = "inbox" | "promotions" | "spam" | "missing";

export interface PlacementSummary {
  total: number;
  inbox: number;
  promotions: number;
  spam: number;
  missing: number;
  failShare: number;
  pass: boolean;
}

export function summarizePlacement(folders: Folder[], policies: Policies = DEFAULT_POLICIES): PlacementSummary {
  const s = { total: folders.length, inbox: 0, promotions: 0, spam: 0, missing: 0 };
  for (const f of folders) s[f]++;
  const failShare = s.total ? (s.spam + s.missing) / s.total : 1;
  return { ...s, failShare, pass: s.total > 0 && failShare <= policies.diagnosis.placementMaxFail };
}

export interface BounceComposition {
  total: number;
  byCategory: Record<BounceCategory, number>;
  dominant: BounceCategory | null;
  listShare: number;
  reputationShare: number;
}

export function bounceComposition(categories: BounceCategory[]): BounceComposition {
  const byCategory: Record<BounceCategory, number> = { user_unknown: 0, mailbox_full: 0, policy_or_spam_block: 0, domain_not_found: 0, other: 0 };
  for (const c of categories) byCategory[c]++;
  const total = categories.length;
  const dominant = total ? (Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0][0] as BounceCategory) : null;
  return {
    total,
    byCategory,
    dominant,
    listShare: total ? (byCategory.user_unknown + byCategory.domain_not_found + byCategory.mailbox_full) / total : 0,
    reputationShare: total ? byCategory.policy_or_spam_block / total : 0,
  };
}

export interface DecisionInput {
  authOk: boolean;
  blocklisted?: boolean;
  suspended?: boolean;
  control: boolean | null;
  campaign: boolean | null;
  bounces?: BounceComposition;
  attempt?: number;
}

export interface Decision {
  verdict: DiagnosisVerdict;
  action: "fix_auth" | "rotate" | "rewrite_copy" | "fix_list" | "review_offer" | "retest" | "operator_decides" | "await_test";
  headline: string;
  explanation: string;
  /** Rotation may proceed (DGN-1). */
  allowsRotation: boolean;
}

/** Decision table (DGN-5) with pre-check short-circuits (DGN-2) and hard-evidence exceptions (DGN-1). */
export function decide(i: DecisionInput): Decision {
  if (!i.authOk)
    return {
      verdict: "AUTH",
      action: "fix_auth",
      headline: "Authentication is broken. Fix it, don't replace the domain.",
      explanation: "SPF, DKIM or DMARC no longer pass. Fix the DNS records, re-verify, then resume sending.",
      allowsRotation: false,
    };
  if (i.blocklisted || i.suspended)
    return {
      verdict: "INFRA",
      action: "rotate",
      headline: i.blocklisted ? "Domain is on a blocklist. Replace it." : "Provider suspended this infrastructure. Replace it.",
      explanation: "This is hard evidence of an infrastructure problem, so no control test is needed.",
      allowsRotation: true,
    };
  if (i.control === null || i.campaign === null)
    return { verdict: "INCONCLUSIVE", action: "await_test", headline: "Waiting for the control test.", explanation: "Send control and campaign copy to the seed inboxes, then record where each landed.", allowsRotation: false };

  if (i.control && !i.campaign)
    return {
      verdict: "COPY",
      action: "rewrite_copy",
      headline: "Only the campaign copy fails. Rewrite it.",
      explanation: "Neutral control copy lands in the inbox from the same inbox, so the infrastructure is fine. Pause this variant, rewrite it, and resume the domain.",
      allowsRotation: false,
    };
  if (!i.control && !i.campaign)
    return {
      verdict: "INFRA",
      action: "rotate",
      headline: "Both control and campaign copy fail. Replace the infrastructure.",
      explanation: "Even neutral copy is filtered from this inbox, so the domain's reputation is the problem. Rotate in a warmed replacement.",
      allowsRotation: true,
    };
  if (i.control && i.campaign) {
    const listy = (i.bounces?.listShare ?? 0) >= 0.5 && (i.bounces?.total ?? 0) > 0;
    return listy
      ? {
          verdict: "LIST",
          action: "fix_list",
          headline: "Placement is fine. The list is the problem.",
          explanation: "Both messages land in the inbox, and most bounces are unknown or nonexistent mailboxes. Re-validate the list, tighten filters, and resume.",
          allowsRotation: false,
        }
      : {
          verdict: "OFFER",
          action: "review_offer",
          headline: "Placement is fine. Review targeting and offer.",
          explanation: "Both messages land in the inbox, so deliverability isn't why replies are low. Review the segment and the offer, then resume.",
          allowsRotation: false,
        };
  }
  // control fails, campaign passes
  return (i.attempt ?? 1) < 2
    ? { verdict: "INCONCLUSIVE", action: "retest", headline: "Unexpected result. Re-run the test.", explanation: "Control failed but campaign passed. This is usually noise, so test once more.", allowsRotation: false }
    : {
        verdict: "INCONCLUSIVE",
        action: "operator_decides",
        headline: "Still inconclusive. Your call.",
        explanation: "The result repeated. Look at the placement grid and the bounce mix, then decide whether to rotate.",
        allowsRotation: false,
      };
}

/** Neutral control messages (CPY-6). */
export const DEFAULT_CONTROL_MESSAGES = [
  { subject: "quick question", body: "Hi,\n\nAre you the right person to talk to about scheduling for next quarter?\n\nThanks," },
  { subject: "thursday", body: "Hi,\n\nDoes Thursday afternoon still work on your end?\n\nThanks," },
];
