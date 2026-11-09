/**
 * Microsoft 365 transport via Microsoft Graph (app-only, client credentials).
 * Entra app permissions: Mail.Send, Mail.ReadWrite (application), admin-consented,
 * ideally scoped to the sending mailboxes with an application access policy.
 */
import type { Folder } from "@cold/core";
import { buildMime } from "../../lib/mime";
import { fetchJson, ProviderError } from "../../lib/http";
import type { InboundItem, MailboxCtx, OutgoingMessage, SentResult, Transport } from "./types";
import { headerGet, headerMap, parseAddress } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const tokens = new Map<string, { token: string; exp: number }>();
const folderCache = new Map<string, { inbox: string; junk: string; sent: string; drafts: string }>();

async function token(m: MailboxCtx): Promise<string> {
  const { tenantId, clientId } = m.tenant.config;
  if (!tenantId || !clientId || !m.tenant.secret) throw new ProviderError("Microsoft tenant is missing tenantId, clientId or client secret", 401);
  const key = `${tenantId}:${clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetchJson(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: m.tenant.secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (res.status !== 200) throw new ProviderError(`Microsoft token error: ${res.data?.error_description ?? res.status}`, res.status === 400 ? 401 : res.status);
  tokens.set(key, { token: res.data.access_token, exp: Date.now() + res.data.expires_in * 1000 });
  return res.data.access_token;
}

async function graph<T = any>(m: MailboxCtx, method: string, path: string, body?: string | object, extraHeaders: Record<string, string> = {}): Promise<T> {
  const t = await token(m);
  const url = path.startsWith("http") ? path : GRAPH + path;
  const res = await fetchJson<T>(url, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(typeof body === "object" ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (res.status >= 400) {
    const msg = (res.data as any)?.error?.message ?? `Graph ${method} ${path} → ${res.status}`;
    throw new ProviderError(msg, res.status);
  }
  return res.data;
}

const u = (m: MailboxCtx) => `/users/${encodeURIComponent(m.address)}`;

async function folders(m: MailboxCtx) {
  const hit = folderCache.get(m.address);
  if (hit) return hit;
  const get = async (name: string) => (await graph<{ id: string }>(m, "GET", `${u(m)}/mailFolders/${name}?$select=id`)).id;
  const f = { inbox: await get("inbox"), junk: await get("junkemail"), sent: await get("sentitems"), drafts: await get("drafts") };
  folderCache.set(m.address, f);
  return f;
}

export const graphTransport: Transport = {
  async send(m: MailboxCtx, msg: OutgoingMessage): Promise<SentResult> {
    const mime = buildMime({
      from: { address: m.address, name: m.displayName },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      messageId: msg.messageId,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
    });
    // Create a draft from MIME (keeps our headers and returns ids), then send it.
    const draft = await graph<{ id: string; internetMessageId?: string; conversationId?: string }>(
      m,
      "POST",
      `${u(m)}/messages`,
      Buffer.from(mime, "utf8").toString("base64"),
      { "Content-Type": "text/plain" },
    );
    await graph(m, "POST", `${u(m)}/messages/${encodeURIComponent(draft.id)}/send`);
    return { providerMessageId: draft.id, providerThreadId: draft.conversationId ?? null, rfcMessageId: draft.internetMessageId ?? msg.messageId };
  },

  async fetchInbound(m: MailboxCtx, cursor: string | null) {
    const f = await folders(m);
    const since = cursor ?? new Date(Date.now() - 2 * 86_400_000).toISOString();
    const select = "id,internetMessageId,conversationId,subject,from,toRecipients,receivedDateTime,body,internetMessageHeaders,parentFolderId";
    let url: string | null = `${u(m)}/messages?$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime asc&$top=50&$select=${select}`;
    const items: InboundItem[] = [];
    let latest = since;
    for (let page = 0; url && page < 6; page++) {
      const data: any = await graph(m, "GET", url, undefined, { Prefer: 'outlook.body-content-type="text"' });
      for (const it of data.value ?? []) {
        if (it.receivedDateTime > latest) latest = it.receivedDateTime;
        if (it.parentFolderId === f.sent || it.parentFolderId === f.drafts) continue;
        const from = it.from?.emailAddress?.address?.toLowerCase() ?? "";
        if (from === m.address.toLowerCase()) continue;
        const headers = headerMap(it.internetMessageHeaders);
        items.push({
          providerMessageId: it.id,
          providerThreadId: it.conversationId ?? null,
          rfcMessageId: it.internetMessageId ?? null,
          inReplyTo: headerGet(headers, "In-Reply-To"),
          references: headerGet(headers, "References"),
          from,
          fromName: it.from?.emailAddress?.name,
          to: it.toRecipients?.[0]?.emailAddress?.address ?? m.address,
          subject: it.subject ?? "",
          body: it.body?.content ?? "",
          headers,
          contentType: headerGet(headers, "Content-Type") ?? undefined,
          receivedAt: new Date(it.receivedDateTime),
          folder: it.parentFolderId === f.junk ? "spam" : it.parentFolderId === f.inbox ? "inbox" : "other",
        });
      }
      url = data["@odata.nextLink"] ?? null;
    }
    return { items, cursor: latest };
  },

  async locate(seed: MailboxCtx, rfcMessageId: string): Promise<Folder> {
    const f = await folders(seed);
    const q = `${u(seed)}/messages?$filter=${encodeURIComponent(`internetMessageId eq '${rfcMessageId.replace(/'/g, "''")}'`)}&$select=id,parentFolderId`;
    const data: any = await graph(seed, "GET", q);
    const hit = data.value?.[0];
    if (!hit) return "missing";
    if (hit.parentFolderId === f.junk) return "spam";
    return "inbox";
  },

  async rawHeaders(seed: MailboxCtx, rfcMessageId: string) {
    const q = `${u(seed)}/messages?$filter=${encodeURIComponent(`internetMessageId eq '${rfcMessageId.replace(/'/g, "''")}'`)}&$select=id,internetMessageHeaders`;
    const data: any = await graph(seed, "GET", q);
    const hit = data.value?.[0];
    if (!hit) return null;
    return (hit.internetMessageHeaders ?? []).map((h: { name: string; value: string }) => `${h.name}: ${h.value}`).join("\n");
  },

  async rescue(m: MailboxCtx, providerMessageId: string) {
    const moved = await graph<{ id: string }>(m, "POST", `${u(m)}/messages/${encodeURIComponent(providerMessageId)}/move`, { destinationId: "inbox" });
    await graph(m, "PATCH", `${u(m)}/messages/${encodeURIComponent(moved.id ?? providerMessageId)}`, { isRead: true, importance: "high" });
  },

  async markRead(m: MailboxCtx, providerMessageId: string) {
    await graph(m, "PATCH", `${u(m)}/messages/${encodeURIComponent(providerMessageId)}`, { isRead: true });
  },

  async test(m: MailboxCtx) {
    try {
      const me: any = await graph(m, "GET", `${u(m)}?$select=id,mail,userPrincipalName`);
      await folders(m);
      return { ok: true, detail: `Connected as ${me.mail ?? me.userPrincipalName}` };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  },
};

export { parseAddress };
