/** Sending-domain helpers: protection (rule 1), name suggestions, lifecycle gates (§7), warmup (rule 6). */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Connection, DomainState, MailboxState, Pool, Provider } from "./types";

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

export function isValidDomainName(d: string): boolean {
  return /^(?=.{3,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/.test(d);
}

/** True when `domain` equals or is a subdomain of any protected domain (rule 1, I-1). */
export function isProtected(domain: string, protectedDomains: string[]): boolean {
  const d = normalizeDomain(domain);
  return protectedDomains.some((p) => {
    const pd = normalizeDomain(p);
    return d === pd || d.endsWith("." + pd);
  });
}

export interface NameSuggestion {
  name: string;
  score: number;
  pattern: string;
}

const PREFIXES = ["get", "try", "use", "hello", "meet", "join", "with", "go", "team"];
const SUFFIXES = ["hq", "team", "app", "labs", "mail", "group", "co", "online"];
const TLDS = ["com", "co", "io", "net"];

/** Brand-lookalike domain suggestions for the workspace's own brand (DOM-2). */
export function suggestDomainNames(primaryDomain: string, opts: { brand?: string; limit?: number; tlds?: string[] } = {}): NameSuggestion[] {
  const primary = normalizeDomain(primaryDomain);
  const brand = (opts.brand ?? primary.split(".")[0]).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!brand) return [];
  const tlds = opts.tlds ?? TLDS;
  const seen = new Set<string>([primary]);
  const out: NameSuggestion[] = [];
  const push = (label: string, tld: string, pattern: string) => {
    const name = `${label}.${tld}`;
    if (seen.has(name)) return;
    seen.add(name);
    let score = 100;
    if (tld === "com") score += 20;
    else if (tld === "co") score += 5;
    if (label.includes("-")) score -= 30;
    if (/\d/.test(label)) score -= 30;
    if (label.length > 20) score -= 20;
    score -= Math.max(0, label.length - brand.length - 3) * 2;
    out.push({ name, score, pattern });
  };
  for (const tld of tlds) {
    if (tld !== primary.split(".").slice(1).join(".")) push(brand, tld, "same name, different TLD");
    for (const p of PREFIXES) push(p + brand, tld, `${p} + brand`);
    for (const s of SUFFIXES) push(brand + s, tld, `brand + ${s}`);
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, opts.limit ?? 40);
}

// ───────────────────────── Warmup ─────────────────────────

export interface WarmupInfo {
  warmupStartedAt: Date | string | null;
  warmupPausedDays?: number | null;
  warmupInboxRate?: number | null;
}

const DAY = 86_400_000;

export function warmupDays(m: WarmupInfo, now: Date = new Date()): number {
  if (!m.warmupStartedAt) return 0;
  const started = new Date(m.warmupStartedAt).getTime();
  return Math.max(0, Math.floor((now.getTime() - started) / DAY) - (m.warmupPausedDays ?? 0));
}

export type WarmupLevel = "not_started" | "warming" | "ready_min" | "ready_recommended";

export function warmupStatus(m: WarmupInfo, policies: Policies = DEFAULT_POLICIES, now: Date = new Date()) {
  const days = warmupDays(m, now);
  const min = policies.warmup.minDays;
  const target = policies.warmup.targetDays;
  const rateOk = m.warmupInboxRate == null || m.warmupInboxRate >= policies.warmup.minInboxRate;
  const level: WarmupLevel = !m.warmupStartedAt ? "not_started" : days < min ? "warming" : days < target ? "ready_min" : "ready_recommended";
  const readyAt = m.warmupStartedAt ? new Date(new Date(m.warmupStartedAt).getTime() + (min + (m.warmupPausedDays ?? 0)) * DAY) : null;
  return { days, min, target, rateOk, level, ready: level !== "not_started" && level !== "warming" && rateOk, readyAt, daysLeft: Math.max(0, min - days) };
}

// ───────────────────────── Lifecycle gates ─────────────────────────

export interface GateDomain {
  name: string;
  provider: Provider;
  state: DomainState;
  pool: Pool;
  authVerifiedAt: Date | string | null;
  headerTestPassedAt: Date | string | null;
}

export interface GateMailbox extends WarmupInfo {
  state: MailboxState;
  connection: Connection;
}

export interface Blocker {
  code: string;
  message: string;
  rule?: number;
}

export const ALLOWED_TRANSITIONS: Record<DomainState, DomainState[]> = {
  pending_dns: ["auth_verified", "retired"],
  auth_verified: ["warming", "pending_dns", "auth_failed", "retired"],
  warming: ["ready", "auth_failed", "retired"],
  ready: ["active", "warming", "auth_failed", "retired"],
  active: ["flagged", "diagnosing", "layover", "relay", "auth_failed", "retired"],
  flagged: ["diagnosing", "active", "layover", "relay", "auth_failed", "retired"],
  diagnosing: ["active", "flagged", "layover", "relay", "auth_failed", "retired"],
  layover: ["relay", "retired"],
  relay: ["retired"],
  retired: [],
  auth_failed: ["pending_dns", "auth_verified", "warming", "ready", "active", "flagged", "retired"],
};

export function authFresh(authVerifiedAt: Date | string | null, policies: Policies, now: Date): boolean {
  if (!authVerifiedAt) return false;
  return now.getTime() - new Date(authVerifiedAt).getTime() <= policies.auth.reverifyHours * 3_600_000;
}

/** Hard gates on domain transitions (SPEC §7.1 transition guards). */
export function checkTransition(
  to: DomainState,
  ctx: { domain: GateDomain; mailboxes: GateMailbox[]; protectedDomains: string[]; policies?: Policies; now?: Date },
): { ok: boolean; blockers: Blocker[] } {
  const policies = ctx.policies ?? DEFAULT_POLICIES;
  const now = ctx.now ?? new Date();
  const { domain, mailboxes } = ctx;
  const blockers: Blocker[] = [];

  if (!ALLOWED_TRANSITIONS[domain.state].includes(to)) {
    blockers.push({ code: "INVALID_TRANSITION", message: `Cannot move from ${domain.state} to ${to}.` });
    return { ok: false, blockers };
  }
  if (isProtected(domain.name, ctx.protectedDomains) && ["warming", "ready", "active"].includes(to)) {
    blockers.push({ code: "PROTECTED_DOMAIN", message: "This is your primary domain (or a subdomain of it). It can never send cold email.", rule: 1 });
  }
  if (to === "warming" || to === "auth_verified") {
    if (!domain.authVerifiedAt) blockers.push({ code: "AUTH_MISSING", message: "SPF, DKIM and DMARC have not all passed yet.", rule: 5 });
    if (to === "warming" && !domain.headerTestPassedAt)
      blockers.push({ code: "HEADER_TEST_MISSING", message: "Send yourself a test email and pass the header test first.", rule: 5 });
    if (to === "warming" && mailboxes.length === 0) blockers.push({ code: "NO_MAILBOXES", message: "Add at least one mailbox before warming." });
  }
  if (to === "ready" || to === "active") {
    if (mailboxes.length === 0) blockers.push({ code: "NO_MAILBOXES", message: "The domain has no mailboxes." });
    for (const m of mailboxes) {
      const w = warmupStatus(m, policies, now);
      if (!w.ready) {
        blockers.push({
          code: "WARMUP_INCOMPLETE",
          message: !m.warmupStartedAt
            ? "Warmup has not started on every mailbox."
            : !w.rateOk
              ? `A mailbox's warmup inbox rate is below ${Math.round(policies.warmup.minInboxRate * 100)}%.`
              : `Mailboxes need ${policies.warmup.minDays} days of warmup (${w.days} so far). Never start sending immediately.`,
          rule: 6,
        });
        break;
      }
    }
    if (!authFresh(domain.authVerifiedAt, policies, now))
      blockers.push({ code: "AUTH_STALE", message: `Authentication must have passed within the last ${policies.auth.reverifyHours} hours.`, rule: 5 });
  }
  if (to === "active") {
    if (domain.state !== "ready" && domain.state !== "auth_failed" && domain.state !== "flagged" && domain.state !== "diagnosing")
      blockers.push({ code: "NOT_READY", message: "Only Ready domains can start sending." });
    if (!mailboxes.some((m) => m.connection === "connected"))
      blockers.push({ code: "NOT_CONNECTED", message: "No mailbox on this domain is connected." });
  }
  return { ok: blockers.length === 0, blockers };
}
