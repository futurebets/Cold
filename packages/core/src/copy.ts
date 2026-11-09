/**
 * Copy linter and renderer (SPEC §6.8, playbook rule 9).
 * The same code runs live in the editor, on save, and in the send-time pre-flight guard.
 */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Jurisdiction } from "./types";

export type Severity = "block" | "warn";
export type CopyField = "subject" | "body" | "signature";

export interface LintFinding {
  rule: string;
  severity: Severity;
  field: CopyField;
  message: string;
  match?: string;
  index?: number;
  ruleRef?: number;
}

export interface LintInput {
  subject: string;
  body: string;
  signature?: string;
  /** First email in a sequence (subject required, no Re:/Fwd:). Follow-ups are sent in-thread. */
  isFirstTouch: boolean;
  jurisdiction?: Jurisdiction;
  postalAddressConfigured?: boolean;
  /** Merge fields available for this campaign. */
  knownFields?: string[];
  policies?: Policies;
}

export interface LintResult {
  findings: LintFinding[];
  blocks: number;
  warns: number;
  wordCount: number;
  score: number;
}

export const DEFAULT_MERGE_FIELDS = ["firstName", "lastName", "company", "title", "senderFirstName", "senderName", "senderCompany", "dayOfWeek"];

const TLD = "com|net|org|io|co|ai|app|dev|xyz|info|biz|me|us|uk|ca|de|fr|au|in|tech|site|online|store|so|ly|gg|tv|eu|nl|es|it|se|ch|link|page|website|cloud|agency|digital";
const URL_RE = new RegExp(String.raw`\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+(?:${TLD})\b(?:\/\S*)?`, "gi");
const HTML_RE = /<\/?(?:a|p|div|span|br|b|i|u|strong|em|img|table|tr|td|ul|ol|li|h[1-6]|font|style|html|body)\b[^>]*>/gi;
const IMG_RE = /!\[[^\]]*\]\([^)]*\)|<img\b/gi;
const MD_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}\s|\[[^\]]+\]\([^)]+\)/gm;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/gm;
const MERGE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

export const CORPORATE_PHRASES = [
  "i hope this email finds you well",
  "i hope this finds you well",
  "hope you're doing well",
  "synergy",
  "synergies",
  "leverage",
  "best-in-class",
  "best in class",
  "cutting-edge",
  "cutting edge",
  "world-class",
  "industry-leading",
  "game-changer",
  "game changing",
  "revolutionary",
  "paradigm",
  "circle back",
  "touch base",
  "value proposition",
  "end-to-end solution",
  "holistic",
  "robust solution",
  "seamless integration",
  "unlock",
  "empower",
  "streamline your",
  "i wanted to reach out",
  "i am reaching out",
  "i'm reaching out",
  "just following up",
  "per my last email",
  "as per",
  "at your earliest convenience",
  "don't hesitate to",
];

export const HARD_CTA_PHRASES = [
  "book a call",
  "book a meeting",
  "book a demo",
  "schedule a call",
  "schedule a demo",
  "schedule a meeting",
  "hop on a call",
  "jump on a call",
  "15 minutes",
  "15-minute",
  "20 minutes",
  "30 minutes",
  "30-minute",
  "my calendar",
  "calendly",
  "grab time",
  "find a time",
];

export const SPAM_PHRASES = [
  "for free",
  "free trial",
  "free of charge",
  "guarantee",
  "guaranteed",
  "act now",
  "limited time",
  "risk-free",
  "risk free",
  "100%",
  "$$$",
  "click here",
  "buy now",
  "no obligation",
  "winner",
  "cash",
  "urgent",
  "special promotion",
  "lowest price",
  "double your",
  "earn money",
  "make money",
];

const OPT_OUT_RE = /\b(unsubscribe|opt[- ]?out|not interested|reply ['"‘’“”]?(no|stop|not interested)|let me know (and|if) i|won'?t (follow up|reach out|email)|not (a fit|relevant)|stop (emailing|hearing)|remove you)\b/i;

function countWords(text: string): number {
  const stripped = text.replace(MERGE_RE, "x").trim();
  return stripped ? stripped.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length : 0;
}

function findAll(field: CopyField, text: string, re: RegExp, make: (m: RegExpExecArray) => Omit<LintFinding, "field" | "index" | "match">): LintFinding[] {
  const out: LintFinding[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    out.push({ ...make(m), field, index: m.index, match: m[0] });
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}

function phraseFindings(field: CopyField, text: string, phrases: string[], make: (p: string) => Omit<LintFinding, "field" | "index" | "match">): LintFinding[] {
  const lower = text.toLowerCase();
  const out: LintFinding[] = [];
  for (const p of phrases) {
    const re = new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}($|[^a-z0-9])`, "i");
    const m = re.exec(lower);
    if (m) {
      const idx = m.index + m[1].length;
      out.push({ ...make(p), field, index: idx, match: text.slice(idx, idx + p.length) });
    }
  }
  return out;
}

/** Last paragraph of the body, used to look for a soft question CTA. */
function closingText(body: string): string {
  const paras = body.trim().split(/\n\s*\n/);
  return paras.slice(-2).join("\n");
}

export function hasSoftCta(body: string): boolean {
  const end = closingText(body);
  return /\?\s*$/m.test(end) || /\b(interested|worth a (chat|look|conversation)|open to (it|this|a)|thoughts|make sense)\?/i.test(body);
}

export function lintCopy(input: LintInput): LintResult {
  const policies = input.policies ?? DEFAULT_POLICIES;
  const findings: LintFinding[] = [];
  const fields: [CopyField, string][] = [
    ["subject", input.subject ?? ""],
    ["body", input.body ?? ""],
    ["signature", input.signature ?? ""],
  ];
  const known = new Set(input.knownFields ?? DEFAULT_MERGE_FIELDS);

  for (const [field, text] of fields) {
    if (!text) continue;
    findings.push(
      ...findAll(field, text.replace(MERGE_RE, (m) => " ".repeat(m.length)), URL_RE, () => ({
        rule: "no_links",
        severity: "block",
        message: "Remove links and domains. Plain text only, no URLs.",
        ruleRef: 9,
      })),
      ...findAll(field, text, IMG_RE, () => ({ rule: "no_images", severity: "block", message: "Remove images.", ruleRef: 9 })),
      ...findAll(field, text, HTML_RE, () => ({ rule: "no_html", severity: "block", message: "Remove HTML. Emails are sent as plain text.", ruleRef: 9 })),
      ...findAll(field, text, MD_RE, () => ({ rule: "no_formatting", severity: "block", message: "Remove formatting (bold, headings, markdown links).", ruleRef: 9 })),
      ...findAll(field, text, MERGE_RE, (m) =>
        known.has(m[1])
          ? m[2] === undefined && !["senderFirstName", "senderName", "senderCompany", "dayOfWeek"].includes(m[1])
            ? { rule: "merge_fallback", severity: "warn", message: `Add a fallback: {{${m[1]}|there}}. Sends with an empty value are skipped.` }
            : { rule: "merge_ok", severity: "warn", message: "" }
          : { rule: "merge_unknown", severity: "block", message: `Unknown merge field {{${m[1]}}}.` },
      ).filter((f) => f.rule !== "merge_ok"),
    );
    findings.push(
      ...findAll(field, text, /\[[^\]\n]{1,60}\](?!\()/g, (m) => ({ rule: "placeholder", severity: "block", message: `Fill in the placeholder ${m[0]}.` })),
    );
    if (field !== "subject") {
      findings.push(...findAll(field, text, BULLET_RE, () => ({ rule: "no_bullets", severity: "warn", message: "Bullets read like a template. Write it as a short note.", ruleRef: 9 })));
    }
    findings.push(
      ...phraseFindings(field, text, CORPORATE_PHRASES, (p) => ({ rule: "corporate_language", severity: "warn", message: `Corporate language: "${p}". Say it like you would to a colleague.`, ruleRef: 9 })),
      ...phraseFindings(field, text, SPAM_PHRASES, (p) => ({ rule: "spam_words", severity: "warn", message: `Spam-filter trigger: "${p}".` })),
    );
    findings.push(
      ...findAll(field, text, /\b[A-Z]{5,}\b/g, () => ({ rule: "all_caps", severity: "warn", message: "Avoid ALL-CAPS words." })),
    );
    const bangs = (text.match(/!/g) ?? []).length;
    if (bangs > 1) findings.push({ rule: "exclamations", severity: "warn", field, message: "More than one exclamation mark." });
  }

  // Subject rules
  const subject = (input.subject ?? "").trim();
  if (input.isFirstTouch) {
    if (!subject) findings.push({ rule: "subject_required", severity: "block", field: "subject", message: "First emails need a subject." });
    if (/^(re|fwd?|fw)\s*:/i.test(subject))
      findings.push({ rule: "deceptive_subject", severity: "block", field: "subject", message: "Don't fake a reply or forward in the first email's subject." });
    if (subject.split(/\s+/).filter(Boolean).length > 7)
      findings.push({ rule: "subject_length", severity: "warn", field: "subject", message: "Keep subjects to a few words." });
  }

  // Length
  const wordCount = countWords(input.body ?? "");
  if (wordCount > policies.copy.maxWordsBlock)
    findings.push({ rule: "too_long", severity: "block", field: "body", message: `${wordCount} words. Keep it under ${policies.copy.maxWordsWarn}.`, ruleRef: 9 });
  else if (wordCount > policies.copy.maxWordsWarn)
    findings.push({ rule: "too_long", severity: "warn", field: "body", message: `${wordCount} words. Short emails get more replies (aim for under ${policies.copy.maxWordsWarn}).`, ruleRef: 9 });
  if ((input.body ?? "").trim() === "") findings.push({ rule: "body_required", severity: "block", field: "body", message: "The email body is empty." });

  // Signature
  const sigLines = (input.signature ?? "").split("\n").filter((l) => l.trim()).length;
  if (sigLines > policies.copy.signatureMaxLines)
    findings.push({ rule: "long_signature", severity: "warn", field: "signature", message: `Signature has ${sigLines} lines. Keep it to ${policies.copy.signatureMaxLines}.`, ruleRef: 9 });

  // CTA
  const body = input.body ?? "";
  const soft = hasSoftCta(body);
  const hard = phraseFindings("body", body, HARD_CTA_PHRASES, (p) => ({ rule: "hard_cta", severity: "warn", message: `Hard CTA: "${p}". Ask a soft question instead, like "Interested?"`, ruleRef: 9 }));
  if (!soft) {
    findings.push(...hard);
    if (body.trim()) findings.push({ rule: "soft_cta", severity: "warn", field: "body", message: 'End with a soft question CTA, like "Interested?"', ruleRef: 9 });
  }

  // Compliance
  const j = input.jurisdiction ?? "none";
  if (j !== "none" && !OPT_OUT_RE.test(body + "\n" + (input.signature ?? ""))) {
    findings.push({
      rule: "opt_out_missing",
      severity: "block",
      field: "body",
      message: 'Add a reply-based opt-out line, e.g. "Not relevant? Just reply \'no\' and I won\'t follow up."',
    });
  }
  if (j === "us" && input.postalAddressConfigured === false) {
    findings.push({ rule: "postal_address", severity: "block", field: "signature", message: "CAN-SPAM requires a postal address. Add one in Settings → Compliance." });
  }

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.length - blocks;
  return { findings, blocks, warns, wordCount, score: Math.max(0, 100 - blocks * 25 - warns * 6) };
}

// ───────────────────────── Rendering ─────────────────────────

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number | string): () => number {
  let a = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RenderResult {
  text: string;
  missing: string[];
}

/** Resolve {{field|fallback}} merge fields and {a|b|c} spintax. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>, rand: () => number = Math.random): RenderResult {
  const missing: string[] = [];
  let text = template.replace(MERGE_RE, (_m, name: string, fallback?: string) => {
    const v = vars[name];
    if (v != null && String(v).trim() !== "") return String(v).trim();
    if (fallback !== undefined) return fallback.trim();
    missing.push(name);
    return "";
  });
  // Spintax, innermost first.
  const SPIN = /\{([^{}]*\|[^{}]*)\}/;
  for (let guard = 0; guard < 100 && SPIN.test(text); guard++) {
    text = text.replace(SPIN, (_m, inner: string) => {
      const opts = inner.split("|");
      return opts[Math.floor(rand() * opts.length)] ?? "";
    });
  }
  return { text, missing };
}

const LEGAL_SUFFIX = /[,\s]+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|s\.a|bv|b\.v|plc|pty|pte|srl|oy|ab|as)\.?$/i;

/**
 * Clean a company name for use in copy: strips legal suffixes and web TLDs so
 * "Booking.com, Inc." renders as "Booking" (a bare domain would be auto-linked by mail clients).
 */
export function cleanCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  let n = name.trim();
  for (let i = 0; i < 3; i++) n = n.replace(LEGAL_SUFFIX, "").trim();
  n = n.replace(new RegExp(`\\.(${TLD})$`, "i"), "");
  return n.trim();
}

/** Compose the final plain-text message body: body + blank line + signature (+ postal address). */
export function composeBody(body: string, signature?: string | null, postalAddress?: string | null): string {
  const parts = [body.trim()];
  const sig = [signature?.trim(), postalAddress?.trim()].filter(Boolean).join("\n");
  if (sig) parts.push(sig);
  return parts.join("\n\n") + "\n";
}
