/**
 * Header test analysis (SPEC AUTH-4, playbook rule 5: "send yourself a test email and inspect the headers").
 */

export interface Header {
  name: string;
  value: string;
}

/** Parse a raw RFC 5322 header block (unfolds continuation lines). Stops at the first blank line. */
export function parseHeaderBlock(raw: string): Header[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: Header[] = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0) break;
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1].value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    out.push({ name, value: line.slice(idx + 1).trim() });
  }
  return out;
}

export function headerValues(headers: Header[], name: string): string[] {
  const n = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
}

export interface AuthMethodResult {
  method: "spf" | "dkim" | "dmarc" | "compauth";
  result: string;
  props: Record<string, string>;
}

/** Parse one Authentication-Results value into method results. */
export function parseAuthenticationResults(value: string): AuthMethodResult[] {
  // Drop RFC 5322 comments (non-nested) so semicolons inside them don't split segments.
  const cleaned = value.replace(/\([^()]*\)/g, " ");
  const out: AuthMethodResult[] = [];
  for (const segment of cleaned.split(";")) {
    // A segment can carry multiple results separated by whitespace (e.g. Outlook "dmarc=pass action=none header.from=x").
    const m = segment.trim().match(/^(spf|dkim|dmarc|compauth)\s*=\s*([a-z]+)(.*)$/i);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const pm of m[3].matchAll(/([a-z][a-z0-9_.-]*)\s*=\s*("?)([^\s";]+)\2/gi)) {
      props[pm[1].toLowerCase()] = pm[3];
    }
    out.push({ method: m[1].toLowerCase() as AuthMethodResult["method"], result: m[2].toLowerCase(), props });
  }
  return out;
}

const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "com.mx", "co.jp", "co.in", "com.sg", "com.hk",
]);

/** Approximate organizational domain (good enough for relaxed alignment checks). */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

export function aligned(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return organizationalDomain(a) === organizationalDomain(b);
}

function domainOf(addrOrDomain: string | undefined): string | undefined {
  if (!addrOrDomain) return undefined;
  const s = addrOrDomain.replace(/^@/, "").replace(/[<>]/g, "").trim();
  return (s.includes("@") ? s.split("@").pop() : s)?.toLowerCase();
}

export interface HeaderTestAnalysis {
  pass: boolean;
  from?: string;
  fromDomain?: string;
  spf: string;
  dkim: string;
  dkimDomain?: string;
  dkimAligned: boolean;
  dmarc: string;
  receiver?: string;
  issues: string[];
  results: AuthMethodResult[];
}

/**
 * Analyze pasted or fetched headers for a domain. Uses the first Authentication-Results
 * header (added by the final receiving server) per RFC 8601.
 */
export function analyzeHeaders(raw: string, sendingDomain: string): HeaderTestAnalysis {
  const headers = parseHeaderBlock(raw);
  const issues: string[] = [];
  const fromValue = headerValues(headers, "From")[0];
  const fromAddr = fromValue?.match(/[^\s<>"]+@[^\s<>"]+/)?.[0];
  const fromDomain = domainOf(fromAddr);
  const ar = headerValues(headers, "Authentication-Results");
  const arFallback = headerValues(headers, "ARC-Authentication-Results");
  const source = ar[0] ?? arFallback[0]?.replace(/^i=\d+;\s*/, "");
  const results = source ? parseAuthenticationResults(source) : [];
  const receiver = source?.split(";")[0]?.trim().split(/\s/)[0];

  if (!source) issues.push("No Authentication-Results header found. Paste the full original headers of the received message.");
  if (fromDomain && !aligned(fromDomain, sendingDomain)) issues.push(`From domain ${fromDomain} does not match ${sendingDomain}.`);

  const spf = results.find((r) => r.method === "spf");
  const dmarc = results.find((r) => r.method === "dmarc");
  const dkims = results.filter((r) => r.method === "dkim");
  const dkimPass = dkims.find((r) => r.result === "pass" && aligned(domainOf(r.props["header.d"] ?? r.props["header.i"]), sendingDomain));
  const anyDkim = dkimPass ?? dkims.find((r) => r.result === "pass") ?? dkims[0];
  const dkimDomain = domainOf(anyDkim?.props["header.d"] ?? anyDkim?.props["header.i"]);

  const spfResult = spf?.result ?? "missing";
  const dkimResult = anyDkim?.result ?? "missing";
  const dmarcResult = dmarc?.result ?? "missing";
  const dkimAligned = !!dkimPass;

  if (source) {
    if (spfResult !== "pass") issues.push(`SPF is "${spfResult}". It must be "pass".`);
    if (dkimResult !== "pass") issues.push(`DKIM is "${dkimResult}". It must be "pass".`);
    else if (!dkimAligned) issues.push(`DKIM passed but was signed by ${dkimDomain ?? "another domain"}, not ${sendingDomain}. Enable DKIM signing for this domain in your provider.`);
    if (dmarcResult !== "pass") issues.push(`DMARC is "${dmarcResult}". It must be "pass".`);
  }

  return {
    pass: !!source && spfResult === "pass" && dkimResult === "pass" && dkimAligned && dmarcResult === "pass" && (!fromDomain || aligned(fromDomain, sendingDomain)),
    from: fromAddr,
    fromDomain,
    spf: spfResult,
    dkim: dkimResult,
    dkimDomain,
    dkimAligned,
    dmarc: dmarcResult,
    receiver,
    issues,
    results,
  };
}
