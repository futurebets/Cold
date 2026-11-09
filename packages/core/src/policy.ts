/**
 * Policy engine (SPEC §14). Every playbook default lives here with its source and
 * override mode, so the UI can show "Playbook rule #4" badges and the API can
 * refuse loosening a hard gate.
 */
import type { Role } from "./types";
import { roleAtLeast } from "./types";

export type PolicySource = "playbook" | "proposed" | "compliance";
/**
 * hard       – cannot be changed at all
 * hard_floor – may be raised, never lowered below the default
 * soft       – moving in the safer direction is free; loosening needs Owner + reason (audited, "off-playbook")
 * free       – any Operator may change it
 */
export type OverrideMode = "hard" | "hard_floor" | "soft" | "free";

export interface PolicyDef {
  key: string;
  label: string;
  group: string;
  description: string;
  type: "number" | "percent" | "boolean" | "enum" | "list";
  default: number | boolean | string | string[];
  source: PolicySource;
  rule?: number;
  override: OverrideMode;
  /** Direction that is considered safer (free to move toward). */
  safer?: "lower" | "higher";
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
}

export const POLICY_DEFS: PolicyDef[] = [
  // Domains / providers
  { key: "domains.protectPrimary", group: "Domains", label: "Protect primary domain and subdomains", description: "Never send cold email from the primary domain or any subdomain of it.", type: "boolean", default: true, source: "playbook", rule: 1, override: "hard" },
  { key: "providers.allowed", group: "Domains", label: "Allowed sending providers", description: "Only Google Workspace and Microsoft 365. No generic SMTP relays.", type: "list", default: ["google", "microsoft"], source: "playbook", rule: 2, override: "hard" },

  // Caps
  { key: "caps.google.mailboxesPerDomain", group: "Volume caps", label: "Google: mailboxes per domain", description: "Three Google inboxes per domain.", type: "number", default: 3, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 10 },
  { key: "caps.google.perMailboxDaily", group: "Volume caps", label: "Google: emails per mailbox per day", description: "Around 15 cold emails per Google inbox per day.", type: "number", default: 15, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 100, unit: "emails" },
  { key: "caps.google.perDomainDaily", group: "Volume caps", label: "Google: emails per domain per day", description: "45 per Google domain per day.", type: "number", default: 45, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 500, unit: "emails" },
  { key: "caps.microsoft.mailboxesPerDomainMax", group: "Volume caps", label: "Microsoft: max mailboxes per domain", description: "Up to 50 Microsoft inboxes per domain.", type: "number", default: 50, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 100 },
  { key: "caps.microsoft.perMailboxDaily", group: "Volume caps", label: "Microsoft: emails per mailbox per day", description: "Three cold emails per Microsoft inbox per day.", type: "number", default: 3, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 50, unit: "emails" },
  { key: "caps.microsoft.perDomainDaily", group: "Volume caps", label: "Microsoft: emails per domain per day", description: "150 per Microsoft domain per day.", type: "number", default: 150, source: "playbook", rule: 4, override: "soft", safer: "lower", min: 1, max: 1000, unit: "emails" },

  // Auth
  { key: "auth.requireSpfDkimDmarc", group: "Authentication", label: "Require SPF, DKIM and DMARC", description: "A domain cannot warm or send until all three pass.", type: "boolean", default: true, source: "playbook", rule: 5, override: "hard" },
  { key: "auth.headerTestRequired", group: "Authentication", label: "Require header test", description: "Send yourself a test email and confirm spf/dkim/dmarc=pass in the headers.", type: "boolean", default: true, source: "playbook", rule: 5, override: "hard" },
  { key: "auth.reverifyHours", group: "Authentication", label: "Re-verify DNS every", description: "Sending stops if checks have not passed within this many hours.", type: "number", default: 24, source: "proposed", override: "free", min: 1, max: 24, unit: "hours" },
  { key: "auth.dmarcPolicy", group: "Authentication", label: "DMARC policy to publish", description: "Value of p= in generated DMARC records.", type: "enum", default: "none", options: ["none", "quarantine", "reject"], source: "proposed", override: "free" },

  // Warmup
  { key: "warmup.minDays", group: "Warmup", label: "Minimum warmup", description: "Never send from an inbox warmed for less than two weeks.", type: "number", default: 14, source: "playbook", rule: 6, override: "hard_floor", min: 14, max: 120, unit: "days" },
  { key: "warmup.targetDays", group: "Warmup", label: "Recommended warmup", description: "A month is better.", type: "number", default: 30, source: "playbook", rule: 6, override: "free", min: 14, max: 120, unit: "days" },
  { key: "warmup.minInboxRate", group: "Warmup", label: "Minimum warmup inbox rate", description: "If your warmup tool reports placement, require at least this inbox rate to become Ready.", type: "percent", default: 0.9, source: "proposed", override: "free", min: 0, max: 1 },

  // Reserve
  { key: "reserve.ratio", group: "Reserve", label: "Reserve ratio", description: "Warmed reserve capacity to keep per unit of active capacity (two infrastructure sets = 1.0).", type: "number", default: 1, source: "playbook", rule: 7, override: "free", min: 0, max: 3 },
  { key: "reserve.autoReplenish", group: "Reserve", label: "Auto-replenish reserve", description: "When a domain leaves the active pool, create a replacement order.", type: "enum", default: "draft", options: ["off", "draft"], source: "proposed", override: "free" },

  // Lists
  { key: "lists.validationTtlDays", group: "Lists", label: "Validation expires after", description: "Re-validate addresses older than this before sending.", type: "number", default: 30, source: "proposed", override: "free", min: 1, max: 180, unit: "days" },
  { key: "lists.blockedSegs", group: "Lists", label: "Blocked secure email gateways", description: "Remove prospects whose MX is behind these gateways.", type: "list", default: ["proofpoint", "mimecast", "barracuda"], options: ["proofpoint", "mimecast", "barracuda", "cisco", "trendmicro", "sophos", "forcepoint"], source: "playbook", rule: 8, override: "soft", safer: "higher" },
  { key: "lists.unknownWithCatchAll", group: "Lists", label: "Route 'unknown' with catch-alls", description: "Send unknown-status addresses through catch-all campaigns instead of excluding them.", type: "boolean", default: false, source: "proposed", override: "soft" },
  { key: "lists.providerSkewWarn", group: "Lists", label: "Warn when one recipient provider exceeds", description: "Mix recipient providers.", type: "percent", default: 0.8, source: "proposed", override: "free", min: 0.5, max: 1 },

  // Copy
  { key: "copy.maxWordsWarn", group: "Copy", label: "Body length warning", description: "Keep emails short.", type: "number", default: 100, source: "proposed", override: "free", min: 20, max: 400, unit: "words" },
  { key: "copy.maxWordsBlock", group: "Copy", label: "Body length limit", description: "Block launch above this many words.", type: "number", default: 150, source: "proposed", override: "free", min: 30, max: 500, unit: "words" },
  { key: "copy.signatureMaxLines", group: "Copy", label: "Signature max lines", description: "Remove long signatures.", type: "number", default: 3, source: "proposed", override: "free", min: 1, max: 8, unit: "lines" },

  // Tracking
  { key: "tracking.opens", group: "Tracking", label: "Open tracking", description: "Disabled. The data is unreliable and the pixel hurts deliverability.", type: "boolean", default: false, source: "playbook", rule: 10, override: "hard" },

  // Schedule
  { key: "schedule.startJitterMaxMin", group: "Scheduling", label: "Randomized start window", description: "Each inbox starts at a random time within this many minutes after the window opens.", type: "number", default: 90, source: "proposed", override: "free", min: 0, max: 240, unit: "minutes" },
  { key: "schedule.minGapMin", group: "Scheduling", label: "Minimum gap between sends", description: "Per inbox.", type: "number", default: 7, source: "proposed", override: "free", min: 1, max: 120, unit: "minutes" },
  { key: "schedule.gapJitter", group: "Scheduling", label: "Gap jitter", description: "Random variation applied to the spacing between sends.", type: "percent", default: 0.4, source: "proposed", override: "free", min: 0, max: 0.9 },
  { key: "schedule.maxCompanyContactsPerWeek", group: "Scheduling", label: "Max contacts per company per week", description: "Across the whole workspace.", type: "number", default: 3, source: "proposed", override: "free", min: 1, max: 50 },

  // Health
  { key: "health.minSample", group: "Health", label: "Minimum sample", description: "Send at least 1,000 emails before judging a domain.", type: "number", default: 1000, source: "playbook", rule: 12, override: "soft", safer: "higher", min: 100, max: 10000, unit: "sends" },
  { key: "health.maturityHours", group: "Health", label: "Wait before counting a send", description: "Wait 48 hours for replies and bounces to arrive.", type: "number", default: 48, source: "playbook", rule: 12, override: "soft", safer: "higher", min: 12, max: 168, unit: "hours" },
  { key: "health.redReplyRateBelow", group: "Health", label: "Red: reply rate below", description: "Reply rate below 1% …", type: "percent", default: 0.01, source: "playbook", rule: 12, override: "soft", safer: "higher", min: 0, max: 0.1 },
  { key: "health.redBounceRateAbove", group: "Health", label: "Red: bounce rate above", description: "… plus a bounce rate above 3% is a clear warning.", type: "percent", default: 0.03, source: "playbook", rule: 12, override: "soft", safer: "lower", min: 0, max: 0.2 },
  { key: "health.amberReplyVsBaseline", group: "Health", label: "Amber: reply rate under share of baseline", description: "Flag when replies fall below this share of the domain's normal rate.", type: "percent", default: 0.5, source: "proposed", override: "free", min: 0.1, max: 0.95 },
  { key: "health.amberBounceOverBaseline", group: "Health", label: "Amber: bounce rate over baseline by", description: "Percentage points above the domain's normal bounce rate.", type: "percent", default: 0.02, source: "proposed", override: "free", min: 0.005, max: 0.1 },
  { key: "health.maxLookbackDays", group: "Health", label: "Max lookback", description: "How far back a domain window may reach to collect its sample.", type: "number", default: 60, source: "proposed", override: "free", min: 14, max: 180, unit: "days" },
  { key: "health.breakerListBounceRate", group: "Health", label: "List breaker: bounce rate", description: "Pause a list's enrollments when its hard bounce rate exceeds this.", type: "percent", default: 0.05, source: "proposed", override: "free", min: 0.01, max: 0.3 },
  { key: "health.breakerListMinSends", group: "Health", label: "List breaker: minimum sends", description: "Sends from the list before the breaker can trip.", type: "number", default: 200, source: "proposed", override: "free", min: 20, max: 2000 },
  { key: "health.breakerSpamBlocks24h", group: "Health", label: "Domain breaker: spam blocks in 24h", description: "Pause a domain after this many policy/spam block bounces in 24 hours.", type: "number", default: 3, source: "proposed", override: "free", min: 1, max: 50 },

  // Diagnosis
  { key: "diagnosis.requiredBeforeRotation", group: "Diagnosis & rotation", label: "Diagnose before replacing", description: "Rotation requires an INFRA verdict (except blocklist or suspension).", type: "boolean", default: true, source: "playbook", rule: 13, override: "hard" },
  { key: "diagnosis.placementMaxFail", group: "Diagnosis & rotation", label: "Placement pass threshold", description: "A message passes if spam + missing is at most this share of seeds.", type: "percent", default: 0.2, source: "proposed", override: "free", min: 0, max: 0.6 },
  { key: "rotation.approval", group: "Diagnosis & rotation", label: "Rotation approval", description: "Who executes a rotation after an INFRA verdict.", type: "enum", default: "operator", options: ["operator", "auto"], source: "proposed", override: "free" },
  { key: "rotation.layoverDays", group: "Diagnosis & rotation", label: "Layover length", description: "Hold outgoing infrastructure while a replacement finishes warming.", type: "number", default: 15, source: "playbook", rule: 14, override: "free", min: 1, max: 30, unit: "days" },
  { key: "rotation.relayDays", group: "Diagnosis & rotation", label: "Relay period", description: "Keep receiving replies on outgoing inboxes for this long.", type: "number", default: 90, source: "proposed", override: "free", min: 14, max: 365, unit: "days" },
  { key: "rotation.reenrollCooldownDays", group: "Diagnosis & rotation", label: "Re-enroll cooldown", description: "Interrupted prospects may be contacted again after this many days.", type: "number", default: 30, source: "proposed", override: "free", min: 7, max: 365, unit: "days" },
  { key: "sequence.oooPauseDays", group: "Scheduling", label: "Out-of-office pause", description: "Pause a sequence this long when an auto-reply has no return date.", type: "number", default: 7, source: "proposed", override: "free", min: 1, max: 30, unit: "days" },
];

const DEF_BY_KEY = new Map(POLICY_DEFS.map((d) => [d.key, d]));

export function policyDef(key: string): PolicyDef | undefined {
  return DEF_BY_KEY.get(key);
}

export interface Policies {
  caps: {
    google: { mailboxesPerDomain: number; perMailboxDaily: number; perDomainDaily: number };
    microsoft: { mailboxesPerDomainMax: number; perMailboxDaily: number; perDomainDaily: number };
  };
  auth: { reverifyHours: number; dmarcPolicy: "none" | "quarantine" | "reject" };
  warmup: { minDays: number; targetDays: number; minInboxRate: number };
  reserve: { ratio: number; autoReplenish: "off" | "draft" };
  lists: { validationTtlDays: number; blockedSegs: string[]; unknownWithCatchAll: boolean; providerSkewWarn: number };
  copy: { maxWordsWarn: number; maxWordsBlock: number; signatureMaxLines: number };
  schedule: { startJitterMaxMin: number; minGapMin: number; gapJitter: number; maxCompanyContactsPerWeek: number };
  health: {
    minSample: number;
    maturityHours: number;
    redReplyRateBelow: number;
    redBounceRateAbove: number;
    amberReplyVsBaseline: number;
    amberBounceOverBaseline: number;
    maxLookbackDays: number;
    breakerListBounceRate: number;
    breakerListMinSends: number;
    breakerSpamBlocks24h: number;
  };
  diagnosis: { placementMaxFail: number };
  rotation: { approval: "operator" | "auto"; layoverDays: number; relayDays: number; reenrollCooldownDays: number };
  sequence: { oooPauseDays: number };
}

function setPath(obj: Record<string, any>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ??= {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Build the effective policy object from stored overrides. Invalid overrides are ignored. */
export function resolvePolicies(overrides: Record<string, unknown> = {}): Policies {
  const out: Record<string, any> = {};
  for (const def of POLICY_DEFS) {
    const raw = overrides[def.key];
    const value = raw !== undefined && checkValue(def, raw).ok ? raw : def.default;
    setPath(out, def.key, value);
  }
  return out as Policies;
}

export const DEFAULT_POLICIES: Policies = resolvePolicies();

function checkValue(def: PolicyDef, value: unknown): { ok: boolean; error?: string } {
  switch (def.type) {
    case "number":
    case "percent": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: "Must be a number" };
      if (def.min !== undefined && value < def.min) return { ok: false, error: `Must be ≥ ${def.min}` };
      if (def.max !== undefined && value > def.max) return { ok: false, error: `Must be ≤ ${def.max}` };
      if (def.override === "hard_floor" && value < (def.default as number))
        return { ok: false, error: `Playbook floor is ${def.default}; it can be raised, never lowered` };
      return { ok: true };
    }
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : { ok: false, error: "Must be true or false" };
    case "enum":
      return typeof value === "string" && def.options?.includes(value)
        ? { ok: true }
        : { ok: false, error: `Must be one of ${def.options?.join(", ")}` };
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && (!def.options || def.options.includes(v)))
        ? { ok: true }
        : { ok: false, error: "Invalid list" };
  }
}

export interface OverrideCheck {
  ok: boolean;
  error?: string;
  /** Change loosens a playbook default: needs Owner + reason, marks workspace off-playbook. */
  loosens: boolean;
  requiresReason: boolean;
}

/** Decide whether `role` may set policy `key` to `value` (SPEC CAP-4 / §14). */
export function checkOverride(key: string, value: unknown, role: Role): OverrideCheck {
  const def = DEF_BY_KEY.get(key);
  if (!def) return { ok: false, error: "Unknown policy", loosens: false, requiresReason: false };
  if (!roleAtLeast(role, "operator")) return { ok: false, error: "Operators and Owners can change policies", loosens: false, requiresReason: false };
  if (def.override === "hard") {
    if (JSON.stringify(value) === JSON.stringify(def.default)) return { ok: true, loosens: false, requiresReason: false };
    return { ok: false, error: "This is a hard guardrail and cannot be changed", loosens: false, requiresReason: false };
  }
  const valid = checkValue(def, value);
  if (!valid.ok) return { ok: false, error: valid.error, loosens: false, requiresReason: false };
  if (def.override === "soft") {
    const loosens = isLoosening(def, value);
    if (loosens && role !== "owner")
      return { ok: false, error: "Loosening a playbook limit requires the Owner role", loosens, requiresReason: true };
    return { ok: true, loosens, requiresReason: loosens };
  }
  return { ok: true, loosens: false, requiresReason: false };
}

function isLoosening(def: PolicyDef, value: unknown): boolean {
  if (def.type === "number" || def.type === "percent") {
    const d = def.default as number;
    const v = value as number;
    if (def.safer === "lower") return v > d;
    if (def.safer === "higher") return v < d;
    return v !== d;
  }
  if (def.type === "list") {
    const d = def.default as string[];
    const v = value as string[];
    if (def.safer === "higher") return d.some((x) => !v.includes(x));
    return JSON.stringify([...v].sort()) !== JSON.stringify([...d].sort());
  }
  return JSON.stringify(value) !== JSON.stringify(def.default);
}

/** Overrides that loosen playbook defaults (shown as an "off-playbook" badge). */
export function offPlaybookKeys(overrides: Record<string, unknown>): string[] {
  return Object.entries(overrides)
    .filter(([k, v]) => {
      const def = DEF_BY_KEY.get(k);
      return def && def.override === "soft" && isLoosening(def, v);
    })
    .map(([k]) => k);
}
