/** Minimal RFC 5322 plain-text message builder (text/plain only: playbook rule 9, invariant I-7). */
import { randomUUID } from "node:crypto";

export interface MimeInput {
  from: { address: string; name?: string };
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  date?: Date;
}

function needsEncoding(s: string) {
  return /[^\x20-\x7e]/.test(s);
}

export function encodeWord(s: string): string {
  return needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s;
}

function formatAddress(a: { address: string; name?: string }) {
  if (!a.name) return a.address;
  const name = needsEncoding(a.name) ? encodeWord(a.name) : `"${a.name.replace(/["\\]/g, "")}"`;
  return `${name} <${a.address}>`;
}

const hex = (b: number) => "=" + b.toString(16).toUpperCase().padStart(2, "0");

/** Quoted-printable encode (RFC 2045), keeping lines ≤ 76 chars. */
export function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text.replace(/\r?\n/g, "\n"), "utf8");
  const lines: string[] = [];
  let line = "";
  const push = (chunk: string) => {
    if (line.length + chunk.length > 75) {
      lines.push(line + "=");
      line = "";
    }
    line += chunk;
  };
  const endLine = () => {
    if (line.endsWith(" ") || line.endsWith("\t")) line = line.slice(0, -1) + hex(line.charCodeAt(line.length - 1));
    lines.push(line);
    line = "";
  };
  for (const b of bytes) {
    if (b === 0x0a) {
      endLine();
      continue;
    }
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) push(String.fromCharCode(b));
    else push(hex(b));
  }
  endLine();
  return lines.join("\r\n");
}

export function buildMime(m: MimeInput): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + quotedPrintable(m.text);
}

export function newMessageId(domain: string): string {
  return `<${randomUUID().replace(/-/g, "")}@${domain}>`;
}

/** Decode a quoted-printable body. */
export function decodeQuotedPrintable(s: string): string {
  const src = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const pair = src.slice(i + 1, i + 3);
    if (src[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else bytes.push(...Buffer.from(src[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
