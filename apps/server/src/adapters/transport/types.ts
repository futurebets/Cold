import type { Folder } from "@cold/core";

export interface TenantCtx {
  id: string;
  provider: "google" | "microsoft";
  transport: "api" | "simulated";
  config: Record<string, string>;
  /** Decrypted secret material (Microsoft client secret, or Google service-account JSON). */
  secret: string | null;
}

export interface MailboxCtx {
  id: string;
  address: string;
  displayName: string;
  domainName: string;
  tenant: TenantCtx;
}

export interface SimMeta {
  kind: "first_touch" | "follow_up" | "seed" | "header_test" | "manual";
  arm?: "control" | "campaign" | null;
  profile?: SimProfile | null;
}

export interface SimProfile {
  replyRate: number;
  bounceRate: number;
  placement: "good" | "bad_copy" | "burned";
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  providerThreadId?: string | null;
  sim?: SimMeta;
}

export interface SentResult {
  providerMessageId: string;
  providerThreadId: string | null;
  rfcMessageId: string;
}

export interface InboundItem {
  providerMessageId: string;
  providerThreadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  contentType?: string;
  receivedAt: Date;
  folder: "inbox" | "spam" | "other";
}

export interface Transport {
  send(mailbox: MailboxCtx, msg: OutgoingMessage): Promise<SentResult>;
  fetchInbound(mailbox: MailboxCtx, cursor: string | null): Promise<{ items: InboundItem[]; cursor: string }>;
  /** Seed placement: where did a message with this Message-ID land in the seed inbox? */
  locate(seed: MailboxCtx, rfcMessageId: string): Promise<Folder>;
  /** Seed header test: raw headers of a received message. */
  rawHeaders(seed: MailboxCtx, rfcMessageId: string): Promise<string | null>;
  test(mailbox: MailboxCtx): Promise<{ ok: boolean; detail: string }>;
}

export function headerMap(list: { name: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    if (!(h.name in out)) out[h.name] = h.value;
  }
  return out;
}

export function headerGet(headers: Record<string, string>, name: string): string | null {
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : null;
}

export function parseAddress(v: string | null | undefined): { address: string; name?: string } {
  if (!v) return { address: "" };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || undefined, address: m[2].trim().toLowerCase() };
  return { address: v.trim().toLowerCase() };
}
