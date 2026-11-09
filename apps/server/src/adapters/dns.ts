/**
 * DNS lookups (free, in-house): sending-domain auth checks (AUTH-3) and recipient MX
 * classification (LST-6/7). Uses public resolvers so results match what receivers see.
 */
import { Resolver } from "node:dns/promises";
import type { DnsLookup, Provider } from "@cold/core";
import { countSpfLookups, hashString, spfRecords } from "@cold/core";

const resolvers = [["1.1.1.1", "1.0.0.1"], ["8.8.8.8", "8.8.4.4"]].map((servers) => {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(servers);
  return r;
});

async function withFallback<T>(fn: (r: Resolver) => Promise<T>, empty: T): Promise<T> {
  for (const r of resolvers) {
    try {
      return await fn(r);
    } catch (e: any) {
      if (e?.code === "ENOTFOUND" || e?.code === "ENODATA" || e?.code === "NXDOMAIN") return empty;
    }
  }
  return empty;
}

export async function resolveTxt(name: string): Promise<string[]> {
  const recs = await withFallback((r) => r.resolveTxt(name), [] as string[][]);
  return recs.map((chunks) => chunks.join(""));
}

export async function resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]> {
  const recs = await withFallback((r) => r.resolveMx(domain), [] as { exchange: string; priority: number }[]);
  return recs.sort((a, b) => a.priority - b.priority);
}

export async function resolveCname(name: string): Promise<string | null> {
  const recs = await withFallback((r) => r.resolveCname(name), [] as string[]);
  return recs[0] ?? null;
}

/** Gather everything evaluateDns() needs for one sending domain. */
export async function lookupDomainAuth(domain: string, provider: Provider): Promise<DnsLookup> {
  const [rootTxt, dmarcTxt, mx] = await Promise.all([resolveTxt(domain), resolveTxt(`_dmarc.${domain}`), resolveMx(domain)]);
  const dkim: DnsLookup["dkim"] = [];
  if (provider === "google") {
    dkim.push({ selector: "google", txt: await resolveTxt(`google._domainkey.${domain}`) });
  } else {
    for (const selector of ["selector1", "selector2"]) {
      const cname = await resolveCname(`${selector}._domainkey.${domain}`);
      const txt = cname ? await resolveTxt(cname) : [];
      dkim.push({ selector, cname, keyFound: txt.some((t) => /p=[A-Za-z0-9+/=]{50,}/.test(t)) });
    }
  }
  const spf = spfRecords(rootTxt)[0];
  const spfLookups = spf ? await countSpfLookups(spf, resolveTxt) : undefined;
  return { rootTxt, dmarcTxt, mx, dkim, spfLookups };
}

/** Perfect records for simulated tenants (demo mode). */
export function simulatedDomainAuth(domain: string, provider: Provider): DnsLookup {
  return provider === "google"
    ? {
        rootTxt: ["v=spf1 include:_spf.google.com ~all"],
        dmarcTxt: ["v=DMARC1; p=none"],
        mx: [{ exchange: "smtp.google.com", priority: 1 }],
        dkim: [{ selector: "google", txt: ["v=DKIM1; k=rsa; p=" + "A".repeat(392)] }],
        spfLookups: 4,
      }
    : {
        rootTxt: ["v=spf1 include:spf.protection.outlook.com -all"],
        dmarcTxt: ["v=DMARC1; p=none"],
        mx: [{ exchange: `${domain.replace(/\./g, "-")}.mail.protection.outlook.com`, priority: 0 }],
        dkim: [
          { selector: "selector1", cname: `selector1-${domain.replace(/\./g, "-")}._domainkey.sim.onmicrosoft.com`, keyFound: true },
          { selector: "selector2", cname: `selector2-${domain.replace(/\./g, "-")}._domainkey.sim.onmicrosoft.com`, keyFound: true },
        ],
        spfLookups: 2,
      };
}

/** Plausible MX hosts for demo prospects (60% Google, 28% Microsoft, rest other/SEG). */
export function simulatedMx(domain: string): string[] {
  const h = hashString(domain) % 100;
  if (h < 60) return ["aspmx.l.google.com"];
  if (h < 88) return [`${domain.replace(/\./g, "-")}.mail.protection.outlook.com`];
  if (h < 92) return [`mx0a-00${h}.pphosted.com`];
  if (h < 95) return ["us-smtp-inbound-1.mimecast.com"];
  if (h < 97) return [`d${h}.a.ess.barracudanetworks.com`];
  return [`mx.${domain}`];
}
