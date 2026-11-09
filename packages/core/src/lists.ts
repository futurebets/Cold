/** List hygiene helpers (SPEC §6.7, playbook rule 8). IO (MX lookups, validation API) lives in the server. */
import type { ProspectBucket, RecipientProvider, Seg, ValidationStatus } from "./types";
import { isGoogleMx, isMicrosoftMx } from "./dns";

export function normalizeEmail(email: string): string {
  const e = email.trim().replace(/^mailto:/i, "");
  const at = e.lastIndexOf("@");
  if (at < 0) return e.toLowerCase();
  return e.slice(0, at) + "@" + e.slice(at + 1).toLowerCase();
}

export function emailKey(email: string): string {
  return normalizeEmail(email).toLowerCase();
}

export function emailDomain(email: string): string {
  return emailKey(email).split("@").pop() ?? "";
}

export function isValidEmailSyntax(email: string): boolean {
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/.test(
    email,
  ) && !email.includes("..");
}

const ROLE_LOCALS = new Set([
  "admin", "administrator", "billing", "contact", "contactus", "careers", "enquiries", "feedback", "hello", "help", "hi", "hr", "info", "inquiries",
  "jobs", "marketing", "media", "news", "noreply", "no-reply", "office", "orders", "postmaster", "press", "privacy", "sales", "security", "service",
  "support", "team", "webmaster", "accounts", "accounting", "abuse",
]);

export function isRoleAddress(email: string): boolean {
  return ROLE_LOCALS.has(emailKey(email).split("@")[0]);
}

const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com",
  "getnada.com", "sharklasers.com", "maildrop.cc", "dispostable.com", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "mohmal.com",
  "emailondeck.com", "tempail.com", "burnermail.io", "33mail.com",
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE.has(domain.toLowerCase());
}

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "proton.me",
  "protonmail.com", "gmx.com", "zoho.com", "yandex.com", "mail.com",
]);

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL.has(domain.toLowerCase());
}

export const SEG_PATTERNS: Record<Seg, RegExp[]> = {
  proofpoint: [/\.pphosted\.com$/, /\.ppe-hosted\.com$/, /\.proofpoint\.com$/],
  mimecast: [/(^|\.)mimecast\.com$/, /(^|\.)mimecast\.co\.za$/, /(^|\.)mimecast-offshore\.com$/],
  barracuda: [/\.barracudanetworks\.com$/, /\.barracuda\.com$/],
  cisco: [/\.iphmx\.com$/],
  trendmicro: [/\.tmes\.trendmicro\.com$/, /\.trendmicro\.eu$/],
  sophos: [/\.hydra\.sophos\.com$/],
  forcepoint: [/\.mailcontrol\.com$/],
};

export interface MxClassification {
  provider: RecipientProvider;
  seg: Seg | null;
  primaryHost: string | null;
}

/** Classify a recipient domain from its MX hosts. */
export function classifyMx(hosts: string[]): MxClassification {
  const clean = hosts.map((h) => h.toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (clean.length === 0) return { provider: "none", seg: null, primaryHost: null };
  let seg: Seg | null = null;
  for (const h of clean) {
    for (const [name, patterns] of Object.entries(SEG_PATTERNS) as [Seg, RegExp[]][]) {
      if (patterns.some((p) => p.test(h))) {
        seg = name;
        break;
      }
    }
    if (seg) break;
  }
  const provider: RecipientProvider = clean.some(isGoogleMx) ? "google" : clean.some(isMicrosoftMx) ? "microsoft" : "other";
  return { provider, seg, primaryHost: clean[0] };
}

/**
 * Final bucket for a prospect. Order matters: suppression and SEG removal happen before
 * paid validation so blocked addresses never cost a validation credit.
 */
export function bucketFor(p: {
  duplicate?: boolean;
  suppressed?: boolean;
  syntaxValid: boolean;
  seg: Seg | null;
  blockedSegs: string[];
  provider: RecipientProvider;
  validation: ValidationStatus | null;
  unknownWithCatchAll?: boolean;
}): ProspectBucket {
  if (p.duplicate) return "duplicate";
  if (p.suppressed) return "suppressed";
  if (!p.syntaxValid || p.provider === "none") return "invalid";
  if (p.seg && p.blockedSegs.includes(p.seg)) return "seg_blocked";
  switch (p.validation) {
    case "valid":
      return "ready";
    case "catch_all":
      return "catch_all";
    case "disposable":
      return "disposable";
    case "invalid":
      return "invalid";
    case "unknown":
      return p.unknownWithCatchAll ? "catch_all" : "unknown";
    default:
      return "unknown";
  }
}

/** True when bucket may be enrolled in a campaign of the given kind (I-6). */
export function bucketSendable(bucket: ProspectBucket, campaignIsCatchAll: boolean): boolean {
  return campaignIsCatchAll ? bucket === "catch_all" : bucket === "ready";
}

export function providerMix(rows: { provider: RecipientProvider }[]): Record<RecipientProvider, number> {
  const mix: Record<RecipientProvider, number> = { google: 0, microsoft: 0, other: 0, none: 0 };
  for (const r of rows) mix[r.provider]++;
  return mix;
}

export function providerSkew(mix: Record<RecipientProvider, number>): { top: RecipientProvider; share: number } {
  const total = mix.google + mix.microsoft + mix.other;
  if (total === 0) return { top: "other", share: 0 };
  const entries = (["google", "microsoft", "other"] as RecipientProvider[]).map((k) => [k, mix[k]] as const);
  const [top, count] = entries.sort((a, b) => b[1] - a[1])[0];
  return { top, share: count / total };
}

/** Map common CSV headers to prospect fields. */
export function guessColumnMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const rules: [string, RegExp][] = [
    ["email", /^(e-?mail|email ?address|work ?email)$/i],
    ["firstName", /^(first ?name|firstname|given ?name|first)$/i],
    ["lastName", /^(last ?name|lastname|surname|family ?name|last)$/i],
    ["company", /^(company|company ?name|organization|organisation|account ?name)$/i],
    ["title", /^(title|job ?title|position|role)$/i],
    ["timezone", /^(time ?zone|tz)$/i],
    ["country", /^(country|country ?code)$/i],
    ["state", /^(state|region|province)$/i],
    ["segment", /^(segment|segments|tier|company ?size ?segment)$/i],
    ["website", /^(website|domain|company ?domain|url)$/i],
  ];
  for (const h of headers) {
    for (const [field, re] of rules) {
      if (re.test(h.trim()) && !Object.values(map).includes(field)) {
        map[h] = field;
        break;
      }
    }
  }
  return map;
}
