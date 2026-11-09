/**
 * Google Workspace transport via the Gmail API with a service account and domain-wide delegation.
 * Admin console → Security → API controls → Domain-wide delegation: authorize the service
 * account's client ID for https://www.googleapis.com/auth/gmail.modify.
 */
import { createSign } from "node:crypto";
import type { Folder } from "@cold/core";
import { buildMime, htmlToText } from "../../lib/mime";
import { fetchJson, ProviderError } from "../../lib/http";
import type { InboundItem, MailboxCtx, OutgoingMessage, SentResult, Transport } from "./types";
import { headerGet, headerMap, parseAddress } from "./types";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const tokens = new Map<string, { token: string; exp: number }>();

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

async function token(m: MailboxCtx): Promise<string> {
  const cached = tokens.get(m.address);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!m.tenant.secret) throw new ProviderError("Google tenant is missing the service-account key", 401);
  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(m.tenant.secret);
  } catch {
    throw new ProviderError("Service-account key is not valid JSON", 401);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600, sub: m.address }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (res.status !== 200) throw new ProviderError(`Google token error: ${res.data?.error_description ?? res.data?.error ?? res.status}`, 401);
  tokens.set(m.address, { token: res.data.access_token, exp: Date.now() + res.data.expires_in * 1000 });
  return res.data.access_token;
}

async function gmail<T = any>(m: MailboxCtx, method: string, path: string, body?: object): Promise<{ status: number; data: T }> {
  const t = await token(m);
  const res = await fetchJson<T>(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function gmailOk<T = any>(m: MailboxCtx, method: string, path: string, body?: object): Promise<T> {
  const res = await gmail<T>(m, method, path, body);
  if (res.status >= 400) throw new ProviderError((res.data as any)?.error?.message ?? `Gmail ${method} ${path} → ${res.status}`, res.status);
  return res.data;
}

interface Part {
  mimeType: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

function findBody(p: Part, type: string): string | null {
  if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) {
    const r = findBody(c, type);
    if (r) return r;
  }
  return null;
}

/** DSN reports keep the useful bits in message/delivery-status parts. */
function allText(p: Part): string {
  const own = p.body?.data && /^(text|message)\//.test(p.mimeType) ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
  return [own, ...(p.parts ?? []).map(allText)].filter(Boolean).join("\n");
}

async function toItem(m: MailboxCtx, id: string): Promise<InboundItem | null> {
  const msg: any = await gmailOk(m, "GET", `/messages/${id}?format=full`);
  const labels: string[] = msg.labelIds ?? [];
  if (labels.includes("SENT") || labels.includes("DRAFT")) return null;
  const headers = headerMap(msg.payload?.headers);
  const from = parseAddress(headerGet(headers, "From"));
  if (from.address === m.address.toLowerCase()) return null;
  const contentType = headerGet(headers, "Content-Type") ?? msg.payload?.mimeType;
  const text = /multipart\/report/i.test(contentType ?? "")
    ? allText(msg.payload)
    : findBody(msg.payload, "text/plain") ?? htmlToText(findBody(msg.payload, "text/html") ?? msg.snippet ?? "");
  return {
    providerMessageId: msg.id,
    providerThreadId: msg.threadId ?? null,
    rfcMessageId: headerGet(headers, "Message-ID"),
    inReplyTo: headerGet(headers, "In-Reply-To"),
    references: headerGet(headers, "References"),
    from: from.address,
    fromName: from.name,
    to: parseAddress(headerGet(headers, "To")).address || m.address,
    subject: headerGet(headers, "Subject") ?? "",
    body: text,
    headers,
    contentType: contentType ?? undefined,
    receivedAt: new Date(Number(msg.internalDate ?? Date.now())),
    folder: labels.includes("SPAM") ? "spam" : labels.includes("INBOX") ? "inbox" : "other",
  };
}

async function findByRfcId(m: MailboxCtx, rfcMessageId: string): Promise<string | null> {
  const q = encodeURIComponent(`rfc822msgid:${rfcMessageId.replace(/[<>]/g, "")}`);
  const res: any = await gmailOk(m, "GET", `/messages?q=${q}&includeSpamTrash=true&maxResults=1`);
  return res.messages?.[0]?.id ?? null;
}

export const gmailTransport: Transport = {
  async send(m: MailboxCtx, msg: OutgoingMessage): Promise<SentResult> {
    const raw = buildMime({
      from: { address: m.address, name: m.displayName },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      messageId: msg.messageId,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
    });
    const sent: any = await gmailOk(m, "POST", "/messages/send", { raw: b64url(raw), ...(msg.providerThreadId ? { threadId: msg.providerThreadId } : {}) });
    let rfc = msg.messageId;
    try {
      const meta: any = await gmailOk(m, "GET", `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
      rfc = headerGet(headerMap(meta.payload?.headers), "Message-ID") ?? rfc;
    } catch {
      /* keep ours */
    }
    return { providerMessageId: sent.id, providerThreadId: sent.threadId ?? null, rfcMessageId: rfc };
  },

  async fetchInbound(m: MailboxCtx, cursor: string | null) {
    const ids = new Set<string>();
    let nextCursor = cursor;
    const bootstrap = async () => {
      const profile: any = await gmailOk(m, "GET", "/profile");
      nextCursor = String(profile.historyId);
      const list: any = await gmailOk(m, "GET", `/messages?q=${encodeURIComponent("newer_than:2d -in:sent")}&maxResults=100&includeSpamTrash=true`);
      for (const x of list.messages ?? []) ids.add(x.id);
    };
    if (!cursor) await bootstrap();
    else {
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await gmail<any>(m, "GET", `/history?startHistoryId=${cursor}&historyTypes=messageAdded&maxResults=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
        if (res.status === 404) {
          await bootstrap();
          break;
        }
        if (res.status >= 400) throw new ProviderError(res.data?.error?.message ?? "Gmail history error", res.status);
        for (const h of res.data.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
        nextCursor = String(res.data.historyId ?? nextCursor);
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
    }
    const items: InboundItem[] = [];
    for (const id of ids) {
      const it = await toItem(m, id).catch(() => null);
      if (it) items.push(it);
    }
    return { items, cursor: nextCursor ?? "" };
  },

  async locate(seed: MailboxCtx, rfcMessageId: string): Promise<Folder> {
    const id = await findByRfcId(seed, rfcMessageId);
    if (!id) return "missing";
    const msg: any = await gmailOk(seed, "GET", `/messages/${id}?format=minimal`);
    const labels: string[] = msg.labelIds ?? [];
    if (labels.includes("SPAM")) return "spam";
    if (labels.includes("CATEGORY_PROMOTIONS")) return "promotions";
    return "inbox";
  },

  async rawHeaders(seed: MailboxCtx, rfcMessageId: string) {
    const id = await findByRfcId(seed, rfcMessageId);
    if (!id) return null;
    const msg: any = await gmailOk(seed, "GET", `/messages/${id}?format=metadata`);
    return (msg.payload?.headers ?? []).map((h: { name: string; value: string }) => `${h.name}: ${h.value}`).join("\n");
  },

  async test(m: MailboxCtx) {
    try {
      const p: any = await gmailOk(m, "GET", "/profile");
      return { ok: true, detail: `Connected as ${p.emailAddress}` };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  },
};
