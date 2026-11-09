/** Expected DNS records and verification logic (SPEC §6.4, playbook rule 5). */
import type { Provider } from "./types";

export interface DnsRecord {
  type: "MX" | "TXT" | "CNAME";
  /** Relative host ("@", "_dmarc", "google._domainkey") */
  host: string;
  value: string;
  priority?: number;
  purpose: "mx" | "spf" | "dkim" | "dmarc";
  note?: string;
  /** Value comes from the provider tenant and must be pasted in by the operator. */
  needsProviderValue?: boolean;
}

export interface ExpectedRecordOptions {
  dmarcPolicy?: "none" | "quarantine" | "reject";
  dmarcRua?: string | null;
  /** Google: the TXT value generated in Admin console → Apps → Gmail → Authenticate email. */
  googleDkimValue?: string | null;
  /** Microsoft: CNAME targets shown in Defender/Exchange admin for selector1/selector2. */
  msDkimSelector1?: string | null;
  msDkimSelector2?: string | null;
  /** Microsoft: MX host from the tenant (defaults to <domain-with-dashes>.mail.protection.outlook.com). */
  msMxHost?: string | null;
}

export const SPF_INCLUDE: Record<Provider, string> = {
  google: "_spf.google.com",
  microsoft: "spf.protection.outlook.com",
};

export function defaultMicrosoftMx(domain: string): string {
  return `${domain.toLowerCase().replace(/\./g, "-")}.mail.protection.outlook.com`;
}

export function expectedRecords(domain: string, provider: Provider, opts: ExpectedRecordOptions = {}): DnsRecord[] {
  const dmarc = `v=DMARC1; p=${opts.dmarcPolicy ?? "none"}${opts.dmarcRua ? `; rua=mailto:${opts.dmarcRua}` : ""}`;
  if (provider === "google") {
    return [
      { type: "MX", host: "@", value: "smtp.google.com", priority: 1, purpose: "mx" },
      { type: "TXT", host: "@", value: "v=spf1 include:_spf.google.com ~all", purpose: "spf", note: "Keep exactly one SPF record on the domain." },
      {
        type: "TXT",
        host: "google._domainkey",
        value: opts.googleDkimValue || "v=DKIM1; k=rsa; p=<generate a 2048-bit key in Google Admin>",
        purpose: "dkim",
        needsProviderValue: !opts.googleDkimValue,
        note: "Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate new record (2048-bit), then click Start authentication.",
      },
      { type: "TXT", host: "_dmarc", value: dmarc, purpose: "dmarc" },
    ];
  }
  return [
    { type: "MX", host: "@", value: opts.msMxHost || defaultMicrosoftMx(domain), priority: 0, purpose: "mx", needsProviderValue: !opts.msMxHost, note: "Use the MX value shown for this domain in the Microsoft 365 admin center." },
    { type: "TXT", host: "@", value: "v=spf1 include:spf.protection.outlook.com -all", purpose: "spf", note: "Keep exactly one SPF record on the domain." },
    {
      type: "CNAME",
      host: "selector1._domainkey",
      value: opts.msDkimSelector1 || "<selector1 target from Microsoft Defender → Email authentication → DKIM>",
      purpose: "dkim",
      needsProviderValue: !opts.msDkimSelector1,
    },
    {
      type: "CNAME",
      host: "selector2._domainkey",
      value: opts.msDkimSelector2 || "<selector2 target from Microsoft Defender → Email authentication → DKIM>",
      purpose: "dkim",
      needsProviderValue: !opts.msDkimSelector2,
      note: "After both CNAMEs resolve, enable DKIM signing for the domain in Defender (or Set-DkimSigningConfig -Enabled $true).",
    },
    { type: "TXT", host: "_dmarc", value: dmarc, purpose: "dmarc" },
  ];
}

/** Raw lookups the server performs; passed in so this module stays IO-free. */
export interface DnsLookup {
  rootTxt: string[];
  dmarcTxt: string[];
  mx: { exchange: string; priority: number }[];
  /** Google: TXT at google._domainkey. Microsoft: CNAME targets + whether they resolve to a key. */
  dkim: { selector: string; txt?: string[]; cname?: string | null; keyFound?: boolean }[];
  /** Total DNS-querying SPF mechanisms after recursion (computed by countSpfLookups). */
  spfLookups?: number;
  /** Microsoft: tenant reports DKIM signing enabled (from admin, optional). */
  msDkimSigningEnabled?: boolean | null;
}

export interface DnsCheckItem {
  id: "mx" | "spf" | "spf_lookups" | "dkim" | "dmarc";
  label: string;
  pass: boolean;
  detail: string;
  found?: string[];
}

export interface DnsCheckResult {
  pass: boolean;
  items: DnsCheckItem[];
}

export function spfRecords(txts: string[]): string[] {
  return txts.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
}

export function parseDmarc(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const [k, ...rest] = part.split("=");
    if (!k || rest.length === 0) continue;
    tags[k.trim().toLowerCase()] = rest.join("=").trim();
  }
  return tags;
}

export function isGoogleMx(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "smtp.google.com" || /(^|\.)aspmx\.l\.google\.com$/.test(h) || h.endsWith(".googlemail.com") || h.endsWith("aspmx.l.google.com");
}

export function isMicrosoftMx(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h.endsWith(".mail.protection.outlook.com") || h.endsWith(".mx.microsoft");
}

export function evaluateDns(provider: Provider, lookup: DnsLookup): DnsCheckResult {
  const items: DnsCheckItem[] = [];

  // MX
  const mxHosts = lookup.mx.map((m) => m.exchange);
  const mxOk = mxHosts.length > 0 && mxHosts.some((h) => (provider === "google" ? isGoogleMx(h) : isMicrosoftMx(h)));
  items.push({
    id: "mx",
    label: "MX points at " + (provider === "google" ? "Google" : "Microsoft"),
    pass: mxOk,
    detail: mxHosts.length === 0 ? "No MX record found." : mxOk ? "MX record is correct." : `MX points elsewhere: ${mxHosts.join(", ")}`,
    found: mxHosts,
  });

  // SPF
  const spf = spfRecords(lookup.rootTxt);
  const include = SPF_INCLUDE[provider];
  let spfDetail = "";
  let spfOk = false;
  if (spf.length === 0) spfDetail = "No SPF record (TXT starting with v=spf1) at the root.";
  else if (spf.length > 1) spfDetail = `Found ${spf.length} SPF records. There must be exactly one; merge them.`;
  else if (!new RegExp(`include:${include.replace(/\./g, "\\.")}(\\s|$)`, "i").test(spf[0])) spfDetail = `SPF does not include ${include}.`;
  else if (!/\s[~\-?+]?all\s*$/i.test(spf[0]) && !/redirect=/i.test(spf[0])) spfDetail = "SPF record should end with ~all or -all.";
  else {
    spfOk = true;
    spfDetail = "SPF record is valid.";
  }
  items.push({ id: "spf", label: "SPF", pass: spfOk, detail: spfDetail, found: spf });

  if (lookup.spfLookups !== undefined) {
    const ok = lookup.spfLookups <= 10;
    items.push({
      id: "spf_lookups",
      label: "SPF DNS lookups ≤ 10",
      pass: ok,
      detail: `${lookup.spfLookups} DNS lookups${ok ? "" : ", over the limit of 10, so receivers return permerror"}.`,
    });
  }

  // DKIM
  let dkimOk = false;
  let dkimDetail = "";
  if (provider === "google") {
    const g = lookup.dkim.find((d) => d.selector === "google");
    const rec = (g?.txt ?? []).join("");
    if (!rec) dkimDetail = "No TXT record at google._domainkey.";
    else if (!/v=DKIM1/i.test(rec) || !/p=[A-Za-z0-9+/=]{100,}/.test(rec.replace(/\s/g, ""))) dkimDetail = "google._domainkey exists but does not contain a valid public key.";
    else {
      dkimOk = true;
      dkimDetail = "DKIM key published.";
    }
  } else {
    const s1 = lookup.dkim.find((d) => d.selector === "selector1");
    const s2 = lookup.dkim.find((d) => d.selector === "selector2");
    if (!s1?.cname || !s2?.cname) dkimDetail = "selector1._domainkey and selector2._domainkey CNAMEs are required.";
    else if (s1.keyFound === false && s2.keyFound === false) dkimDetail = "CNAMEs exist but no DKIM key is published yet. Enable DKIM signing in Microsoft Defender.";
    else if (lookup.msDkimSigningEnabled === false) dkimDetail = "CNAMEs resolve but DKIM signing is disabled in the tenant.";
    else {
      dkimOk = true;
      dkimDetail = "DKIM CNAMEs resolve.";
    }
  }
  items.push({ id: "dkim", label: "DKIM", pass: dkimOk, detail: dkimDetail });

  // DMARC
  const dmarc = lookup.dmarcTxt.filter((t) => /^v=DMARC1/i.test(t.trim()));
  let dmarcOk = false;
  let dmarcDetail = "";
  if (dmarc.length === 0) dmarcDetail = "No DMARC record at _dmarc.";
  else if (dmarc.length > 1) dmarcDetail = "More than one DMARC record. Keep exactly one.";
  else {
    const tags = parseDmarc(dmarc[0]);
    if (!["none", "quarantine", "reject"].includes((tags.p ?? "").toLowerCase())) dmarcDetail = "DMARC record is missing a valid p= policy.";
    else {
      dmarcOk = true;
      dmarcDetail = `DMARC record is valid (p=${tags.p}).`;
    }
  }
  items.push({ id: "dmarc", label: "DMARC", pass: dmarcOk, detail: dmarcDetail, found: dmarc });

  return { pass: items.every((i) => i.pass), items };
}

/**
 * Count DNS-querying SPF mechanisms recursively (RFC 7208 §4.6.4 limit of 10).
 * `resolveTxt` returns the TXT strings for a name (joined chunks), or [] when missing.
 */
export async function countSpfLookups(
  record: string,
  resolveTxt: (name: string) => Promise<string[]>,
  depth = 0,
): Promise<number> {
  if (depth > 10) return 99;
  let count = 0;
  for (const term of record.trim().split(/\s+/).slice(1)) {
    const t = term.replace(/^[+\-~?]/, "").toLowerCase();
    if (t.startsWith("include:") || t.startsWith("redirect=")) {
      count += 1;
      const target = t.split(/[:=]/)[1];
      const txts = await resolveTxt(target).catch(() => []);
      const child = spfRecords(txts)[0];
      if (child) count += await countSpfLookups(child, resolveTxt, depth + 1);
    } else if (t === "a" || t.startsWith("a:") || t.startsWith("a/") || t === "mx" || t.startsWith("mx:") || t.startsWith("mx/") || t.startsWith("ptr") || t.startsWith("exists:")) {
      count += 1;
    }
  }
  return count;
}
