/** Inbound mail classification (SPEC INB-2, INB-5, INB-6): bounces, auto-replies, opt-outs, sentiment. */
import type { BounceCategory } from "./types";

export type InboundKind = "bounce" | "auto_reply" | "human" | "warmup";
export type Intent = "positive" | "question" | "not_interested" | "referral" | "opt_out" | "neutral";

export interface InboundMessage {
  from: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
  contentType?: string;
}

export interface BounceInfo {
  type: "hard" | "soft";
  status: string | null;
  category: BounceCategory;
  recipient: string | null;
  diagnostic: string;
}

export interface Classification {
  kind: InboundKind;
  bounce?: BounceInfo;
  intent?: Intent;
  /** Opt-out detected with high confidence: suppress immediately. Low confidence goes to review. */
  optOutConfidence?: "high" | "low";
  returnDate?: string | null;
  cleanBody: string;
}

const h = (headers: Record<string, string> | undefined, name: string) => {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|microsoftexchange[0-9a-f]+|noreply@.*\.?(?:outlook|google)\.com)/i;
const BOUNCE_SUBJECT = /(undeliverable|undelivered|delivery status notification|delivery has failed|mail delivery failed|returned mail|failure notice|could not be delivered|message not delivered|non[- ]?delivery|delivery failure|address not found)/i;

export function isBounce(m: InboundMessage): boolean {
  if (/multipart\/report/i.test(m.contentType ?? "") && /delivery-status/i.test(m.contentType ?? "")) return true;
  return BOUNCE_FROM.test(m.from) && (BOUNCE_SUBJECT.test(m.subject) || /\b5\.\d{1,3}\.\d{1,3}\b/.test(m.body))
    || BOUNCE_SUBJECT.test(m.subject) && /\b[45]\.\d{1,3}\.\d{1,3}\b/.test(m.body);
}

export function categorizeBounce(status: string | null, text: string): BounceCategory {
  const t = text.toLowerCase();
  if (status) {
    if (/^5\.1\.(1|0|10|6)$/.test(status)) return "user_unknown";
    if (/^[45]\.2\.2$/.test(status)) return "mailbox_full";
    if (/^5\.7\./.test(status)) return "policy_or_spam_block";
    if (/^5\.(1\.2|4\.4|4\.310)$/.test(status)) return "domain_not_found";
  }
  if (/(user unknown|unknown user|does not exist|doesn't exist|no such user|recipient address rejected|mailbox unavailable|address not found|invalid recipient|not found)/.test(t)) return "user_unknown";
  if (/(mailbox full|quota exceeded|over quota|insufficient storage)/.test(t)) return "mailbox_full";
  if (/(spam|blocked|blacklist|blocklist|reputation|policy|denied|rejected due to|not accepted|junk)/.test(t)) return "policy_or_spam_block";
  if (/(domain not found|host not found|no mx|dns)/.test(t)) return "domain_not_found";
  return "other";
}

export function parseBounce(m: InboundMessage): BounceInfo {
  const text = m.body;
  const statusMatch = text.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i) ?? text.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/);
  const status = statusMatch?.[1] ?? null;
  const recipient =
    text.match(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/i)?.[1] ??
    text.match(/(?:wasn't delivered to|could not be delivered to|delivery to the following recipients? failed[^:]*:|to these recipients[^:]*:)\s*<?([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i)?.[1] ??
    null;
  const diagLine = text.match(/Diagnostic-Code:[^\n]*(\n[ \t][^\n]*)*/i)?.[0] ?? text.match(/(Remote Server returned[^\n]*|[45]\d\d[ -][45]\.\d+\.\d+[^\n]*)/i)?.[0] ?? "";
  const type: "hard" | "soft" = status?.startsWith("4") ? "soft" : "hard";
  return { type, status, category: categorizeBounce(status, diagLine || text), recipient: recipient?.toLowerCase() ?? null, diagnostic: diagLine.trim().slice(0, 500) };
}

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?(reply|response)|auto:|out of (the )?office|ooo\b|away from|on vacation|on leave|abwesenheit|absence|réponse automatique|respuesta automática)/i;
const AUTO_BODY = /(i am (currently )?(out of (the )?office|away|on (annual |parental |maternity |paternity )?leave|travell?ing)|i'?m (currently )?(out of (the )?office|away from|on (annual |parental )?leave)|limited access to (my )?e-?mail|will (be back|return) (on|in)|this is an automated (reply|response)|no longer with (the company|[a-z]+)|has left the company)/i;

export function isAutoReply(m: InboundMessage): boolean {
  const auto = h(m.headers, "Auto-Submitted");
  if (auto && auto.toLowerCase() !== "no") return true;
  if (h(m.headers, "X-Autoreply") || h(m.headers, "X-Autorespond") || h(m.headers, "X-Auto-Response-Suppress")?.toLowerCase() === "all") return true;
  if (/^(auto_reply|auto-reply)$/i.test(h(m.headers, "Precedence") ?? "")) return true;
  return AUTO_SUBJECT.test(m.subject.trim()) || AUTO_BODY.test(m.body.slice(0, 1500));
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** Best-effort return date from an out-of-office message (yyyy-mm-dd), relative to `now`. */
export function extractReturnDate(body: string, now: Date = new Date()): string | null {
  const re1 = new RegExp(`(?:back|return(?:ing)?|in the office)[^.\\n]{0,40}?\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, "i");
  const re2 = new RegExp(`(?:back|return(?:ing)?|in the office)[^.\\n]{0,40}?\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})`, "i");
  const re3 = /(?:back|return(?:ing)?|in the office)[^.\n]{0,40}?\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i;
  const monthIdx = (s: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(s.slice(0, 3).toLowerCase());
  let month = -1;
  let day = -1;
  let m = body.match(re1);
  if (m) {
    month = monthIdx(m[1]);
    day = Number(m[2]);
  } else if ((m = body.match(re2))) {
    day = Number(m[1]);
    month = monthIdx(m[2]);
  } else if ((m = body.match(re3))) {
    month = Number(m[1]) - 1;
    day = Number(m[2]);
  }
  if (month < 0 || day < 1 || day > 31) return null;
  let year = now.getUTCFullYear();
  let d = new Date(Date.UTC(year, month, day));
  if (d.getTime() < now.getTime() - 86_400_000 * 2) d = new Date(Date.UTC(++year, month, day));
  if (d.getTime() - now.getTime() > 86_400_000 * 120) return null;
  return d.toISOString().slice(0, 10);
}

/** Remove quoted history and signatures so intent detection sees only the new text. */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .{5,200}wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From:\s.+/i.test(line.trim()) && out.length > 0) break;
    if (/^_{10,}$/.test(line.trim())) break;
    if (/^(Sent from my (iPhone|iPad|Android|mobile))/i.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

const OPT_OUT_HIGH = /\b(unsubscribe|remove me|take me off|opt(?:ed)?[- ]?out|stop (emailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) me|please remove|remove (my|this) (email|address)|no more emails)\b/i;
const NOT_INTERESTED = /\b(not interested|no thanks|no thank you|not a (good )?fit|not right now|we'?re (all )?set|we'?re good|not looking|pass on this|no need|not relevant|no interest)\b/i;
const POSITIVE = /\b(interested|sounds (good|great|interesting)|let'?s (chat|talk|connect|do it)|tell me more|send (me )?(more )?(info|details|over)|happy to (chat|talk|connect)|set up a (time|call)|what'?s the (price|cost)|how much|love to|keen|yes[,.! ]|sure[,.! ]|open to it|would like to learn)\b/i;
const REFERRAL = /\b(reach out to|contact (my|our)|the right person (is|would be)|you should (talk|speak) (to|with)|(i'?ve |i have )?(cc'?d|copied|looped in)|forwarding (this|to)|best person)\b/i;

export function detectIntent(text: string): { intent: Intent; optOutConfidence?: "high" | "low" } {
  const t = text.trim();
  if (OPT_OUT_HIGH.test(t)) return { intent: "opt_out", optOutConfidence: "high" };
  if (/^(no|stop|nope|remove)[.! ]*$/i.test(t)) return { intent: "opt_out", optOutConfidence: "high" };
  if (NOT_INTERESTED.test(t)) return { intent: "not_interested", optOutConfidence: "low" };
  if (REFERRAL.test(t)) return { intent: "referral" };
  if (POSITIVE.test(t) && !/\bnot\b/i.test(t.slice(0, 40))) return { intent: "positive" };
  if (t.includes("?")) return { intent: "question" };
  return { intent: "neutral" };
}

export function classifyInbound(m: InboundMessage, opts: { warmupPattern?: RegExp; now?: Date } = {}): Classification {
  const clean = stripQuoted(m.body);
  if (opts.warmupPattern && (opts.warmupPattern.test(m.subject) || opts.warmupPattern.test(m.body))) return { kind: "warmup", cleanBody: clean };
  if (h(m.headers, "X-Warmup") || h(m.headers, "X-Cold-Warmup")) return { kind: "warmup", cleanBody: clean };
  if (isBounce(m)) return { kind: "bounce", bounce: parseBounce(m), cleanBody: clean };
  if (isAutoReply(m)) return { kind: "auto_reply", returnDate: extractReturnDate(m.body, opts.now), cleanBody: clean };
  const { intent, optOutConfidence } = detectIntent(clean || m.body);
  return { kind: "human", intent, optOutConfidence, cleanBody: clean };
}
