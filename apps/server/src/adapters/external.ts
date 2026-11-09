/** Small external integrations: Cloudflare DNS (free tier), RDAP availability, Slack, Spamhaus DQS. */
import type { DnsRecord } from "@cold/core";
import { fetchJson, mapLimit } from "../lib/http";
import { resolveTxt } from "./dns";
import { Resolver } from "node:dns/promises";

// ───────────── Cloudflare DNS ─────────────

const CF = "https://api.cloudflare.com/client/v4";

async function cf(token: string, method: string, path: string, body?: object) {
  const res = await fetchJson(`${CF}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.data?.success) throw new Error(res.data?.errors?.[0]?.message ?? `Cloudflare ${method} ${path} → ${res.status}`);
  return res.data.result;
}

export interface PushResult {
  applied: string[];
  skipped: string[];
  warnings: string[];
}

/** Upsert the expected records into the domain's Cloudflare zone. Never deletes records. */
export async function pushCloudflare(token: string, domain: string, records: DnsRecord[]): Promise<PushResult> {
  const zones = await cf(token, "GET", `/zones?name=${encodeURIComponent(domain)}`);
  const zone = zones?.[0];
  if (!zone) throw new Error(`No Cloudflare zone for ${domain}. Add the domain to Cloudflare and point its nameservers there first.`);
  const existing: any[] = await cf(token, "GET", `/zones/${zone.id}/dns_records?per_page=500`);
  const fqdn = (host: string) => (host === "@" ? domain : `${host}.${domain}`);
  const out: PushResult = { applied: [], skipped: [], warnings: [] };
  for (const r of records) {
    if (r.needsProviderValue) {
      out.skipped.push(`${r.type} ${r.host}: paste the value from your provider first`);
      continue;
    }
    const name = fqdn(r.host);
    const same = existing.filter((e) => e.type === r.type && e.name === name);
    let target: any = null;
    if (r.purpose === "spf") target = same.find((e) => /^"?v=spf1/i.test(e.content));
    else if (r.purpose === "dmarc") target = same.find((e) => /^"?v=DMARC1/i.test(e.content));
    else if (r.type === "CNAME" || r.purpose === "dkim") target = same[0];
    else if (r.type === "MX") {
      if (same.some((e) => e.content.toLowerCase() === r.value.toLowerCase())) {
        out.skipped.push(`MX ${r.value} already present`);
        continue;
      }
      if (same.length) out.warnings.push(`Other MX records exist on ${domain} (${same.map((e) => e.content).join(", ")}). Remove them so mail routes to your provider.`);
    }
    const payload = { type: r.type, name, content: r.value, ttl: 1, ...(r.type === "MX" ? { priority: r.priority ?? 0 } : {}), ...(r.type === "CNAME" ? { proxied: false } : {}) };
    if (target) {
      if (target.content.replace(/^"|"$/g, "") === r.value) {
        out.skipped.push(`${r.type} ${r.host} already correct`);
        continue;
      }
      await cf(token, "PUT", `/zones/${zone.id}/dns_records/${target.id}`, payload);
    } else await cf(token, "POST", `/zones/${zone.id}/dns_records`, payload);
    out.applied.push(`${r.type} ${r.host}`);
  }
  return out;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

/** All zones the token can see (needs Zone:Read). */
export async function listCloudflareZones(token: string): Promise<CloudflareZone[]> {
  const out: CloudflareZone[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await fetchJson(`${CF}/zones?per_page=50&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.data?.success) throw new Error(res.data?.errors?.[0]?.message ?? `Cloudflare zones → ${res.status}`);
    for (const z of res.data.result ?? []) out.push({ id: z.id, name: z.name, status: z.status });
    if (page >= (res.data.result_info?.total_pages ?? 1)) break;
  }
  return out;
}

export async function testCloudflare(token: string): Promise<string> {
  const r = await cf(token, "GET", "/user/tokens/verify");
  return `Token ${r.status}`;
}

// ───────────── RDAP availability (free) ─────────────

export type Availability = "available" | "taken" | "unknown";

export async function checkAvailability(names: string[]): Promise<Record<string, Availability>> {
  const out: Record<string, Availability> = {};
  await mapLimit(names, 6, async (name) => {
    const tld = name.split(".").pop();
    const url = tld === "com" || tld === "net" ? `https://rdap.verisign.com/${tld}/v1/domain/${name}` : `https://rdap.org/domain/${name}`;
    try {
      const res = await fetchJson(url, { timeoutMs: 6000, headers: { Accept: "application/rdap+json" } });
      out[name] = res.status === 404 ? "available" : res.status === 200 ? "taken" : "unknown";
    } catch {
      out[name] = "unknown";
    }
  });
  return out;
}

// ───────────── Slack ─────────────

export async function notifySlack(webhookUrl: string, text: string): Promise<void> {
  try {
    await fetchJson(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), timeoutMs: 8000 });
  } catch {
    /* notifications are best-effort */
  }
}

// ───────────── Domain blocklists (Spamhaus DBL via DQS key) ─────────────

export async function checkBlocklist(domain: string, dqsKey: string | null): Promise<{ checked: boolean; listed: boolean; detail: string }> {
  if (!dqsKey) return { checked: false, listed: false, detail: "Add a Spamhaus DQS key in Settings → Integrations to enable blocklist checks." };
  const r = new Resolver({ timeout: 4000, tries: 1 });
  try {
    const addrs = await r.resolve4(`${domain}.${dqsKey}.dbl.dq.spamhaus.net`);
    const listed = addrs.some((a) => a.startsWith("127.0.1."));
    return { checked: true, listed, detail: listed ? `Listed on Spamhaus DBL (${addrs.join(", ")})` : "Not listed" };
  } catch (e: any) {
    if (e?.code === "ENOTFOUND") return { checked: true, listed: false, detail: "Not listed on Spamhaus DBL" };
    return { checked: false, listed: false, detail: `Lookup failed: ${e?.code ?? e?.message}` };
  }
}

export { resolveTxt };
