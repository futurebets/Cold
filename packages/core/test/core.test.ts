import { describe, expect, it } from "vitest";
import {
  analyzeHeaders,
  bucketFor,
  checkOverride,
  checkTransition,
  classifyInbound,
  classifyMx,
  cleanCompanyName,
  compareProviders,
  costPerDailySend,
  countSpfLookups,
  decide,
  DEFAULT_POLICIES,
  domainDailyCap,
  evaluateDns,
  evaluateHealth,
  expectedRecords,
  extractReturnDate,
  inWindow,
  isProtected,
  lintCopy,
  migrationFor,
  ownBaseline,
  planCapacity,
  planRotation,
  planSlots,
  preflight,
  pricesFromPreset,
  renderTemplate,
  reserveCoverage,
  resolvePolicies,
  resolveTimezone,
  seededRandom,
  suggestDomainNames,
  summarizePlacement,
  warmupStatus,
  DEFAULT_SCHEDULE,
  bounceComposition,
  type PreflightContext,
} from "../src";

const DAY = 86_400_000;

describe("policies (SPEC §14)", () => {
  it("uses playbook defaults", () => {
    expect(DEFAULT_POLICIES.caps.google.perDomainDaily).toBe(45);
    expect(DEFAULT_POLICIES.caps.microsoft.perDomainDaily).toBe(150);
    expect(DEFAULT_POLICIES.warmup.minDays).toBe(14);
    expect(DEFAULT_POLICIES.health.minSample).toBe(1000);
  });
  it("refuses hard gates and lowering the warmup floor", () => {
    expect(checkOverride("tracking.opens", true, "owner").ok).toBe(false);
    expect(checkOverride("warmup.minDays", 10, "owner").ok).toBe(false);
    expect(checkOverride("warmup.minDays", 21, "operator").ok).toBe(true);
  });
  it("lets operators tighten caps but only owners loosen them, with a reason", () => {
    expect(checkOverride("caps.google.perMailboxDaily", 10, "operator")).toMatchObject({ ok: true, loosens: false });
    expect(checkOverride("caps.google.perMailboxDaily", 25, "operator").ok).toBe(false);
    expect(checkOverride("caps.google.perMailboxDaily", 25, "owner")).toMatchObject({ ok: true, loosens: true, requiresReason: true });
    expect(checkOverride("caps.google.perMailboxDaily", 25, "sdr").ok).toBe(false);
  });
  it("ignores invalid stored overrides", () => {
    expect(resolvePolicies({ "warmup.minDays": 3 }).warmup.minDays).toBe(14);
    expect(resolvePolicies({ "warmup.minDays": 21 }).warmup.minDays).toBe(21);
  });
});

describe("capacity (rule 3, 4, 7)", () => {
  it("computes domain caps", () => {
    expect(domainDailyCap("google", 3)).toBe(45);
    expect(domainDailyCap("microsoft", 50)).toBe(150);
    expect(domainDailyCap("microsoft", 20)).toBe(60);
  });
  it("matches the spec worked example for 1,000/day", () => {
    const { google, microsoft } = compareProviders({ targetDaily: 1000 });
    expect([google.activeDomains, google.activeMailboxes, google.totalDomains, google.totalMailboxes]).toEqual([23, 69, 46, 138]);
    expect([microsoft.activeDomains, microsoft.activeMailboxes, microsoft.totalDomains, microsoft.totalMailboxes]).toEqual([7, 350, 14, 700]);
    expect(google.daysToFirstVerdictPerDomain).toBe(25);
    expect(microsoft.daysToFirstVerdictPerDomain).toBe(9);
  });
  it("separates per-inbox from per-email savings (Nov 2026 presets)", () => {
    const at = (g: string, m: string) => compareProviders({ targetDaily: 1000, prices: { google: pricesFromPreset(g), microsoft: pricesFromPreset(m) } });
    // Bulk "Azure" reseller vs Google direct: 7× cheaper per inbox, but only 1.4× per daily send (3/day vs 15/day).
    const bulk = at("google-direct-annual", "ms-bulk-reseller");
    expect(bulk.perInboxRatio).toBeCloseTo(7);
    expect(bulk.perSendRatio).toBeCloseTo(1.4);
    expect(bulk.infraCostRatio).toBeGreaterThan(2); // Recovery Pool reserves + fewer domains widen the gap
    // Buying Microsoft licenses directly is more expensive per email than Google.
    expect(at("google-direct-annual", "ms-exchange-p1").infraCostRatio).toBeLessThan(1);
    expect(at("google-direct-annual", "ms-business-basic").infraCostRatio).toBeLessThan(0.5);
    // Per-inbox Outlook resellers lose to per-inbox Google resellers.
    expect(at("google-reseller", "ms-per-inbox-reseller").infraCostRatio).toBeLessThan(1);
    expect(planCapacity({ targetDaily: 0, provider: "google" }).activeDomains).toBe(0);
    expect(costPerDailySend("google", 7)).toBeCloseTo(0.4667, 3);
    expect(costPerDailySend("microsoft", 1)).toBeCloseTo(0.3333, 3);
  });
});

describe("domains (rule 1, 6)", () => {
  it("protects primary domain and subdomains", () => {
    expect(isProtected("acme.com", ["acme.com"])).toBe(true);
    expect(isProtected("outreach.acme.com", ["acme.com"])).toBe(true);
    expect(isProtected("getacme.com", ["acme.com"])).toBe(false);
  });
  it("suggests brand lookalikes, .com first, never the primary", () => {
    const s = suggestDomainNames("acme.com");
    expect(s.map((x) => x.name)).not.toContain("acme.com");
    expect(s[0].name.endsWith(".com")).toBe(true);
    expect(s.some((x) => x.name === "getacme.com")).toBe(true);
  });
  it("gates warming/ready/active", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const domain = { name: "getacme.com", provider: "google" as const, state: "auth_verified" as const, pool: "reserve" as const, authVerifiedAt: now, headerTestPassedAt: null };
    const r1 = checkTransition("warming", { domain, mailboxes: [{ state: "provisioning", connection: "connected", warmupStartedAt: null }], protectedDomains: ["acme.com"], now });
    expect(r1.blockers.map((b) => b.code)).toContain("HEADER_TEST_MISSING");

    const warming = { ...domain, state: "warming" as const, headerTestPassedAt: now };
    const mb = { state: "warming" as const, connection: "connected" as const, warmupStartedAt: new Date(now.getTime() - 9 * DAY) };
    const r2 = checkTransition("ready", { domain: warming, mailboxes: [mb], protectedDomains: [], now });
    expect(r2.ok).toBe(false);
    expect(r2.blockers[0].code).toBe("WARMUP_INCOMPLETE");

    const r3 = checkTransition("ready", { domain: warming, mailboxes: [{ ...mb, warmupStartedAt: new Date(now.getTime() - 15 * DAY) }], protectedDomains: [], now });
    expect(r3.ok).toBe(true);

    const r4 = checkTransition("active", { domain: { ...warming, state: "warming" }, mailboxes: [{ ...mb, warmupStartedAt: new Date(now.getTime() - 40 * DAY) }], protectedDomains: [], now });
    expect(r4.blockers.map((b) => b.code)).toContain("INVALID_TRANSITION");
  });
  it("reports warmup levels", () => {
    const now = new Date();
    expect(warmupStatus({ warmupStartedAt: null }).level).toBe("not_started");
    expect(warmupStatus({ warmupStartedAt: new Date(now.getTime() - 20 * DAY) }, DEFAULT_POLICIES, now).level).toBe("ready_min");
    expect(warmupStatus({ warmupStartedAt: new Date(now.getTime() - 31 * DAY) }, DEFAULT_POLICIES, now).level).toBe("ready_recommended");
    expect(warmupStatus({ warmupStartedAt: new Date(now.getTime() - 20 * DAY), warmupPausedDays: 8 }, DEFAULT_POLICIES, now).ready).toBe(false);
  });
});

describe("DNS + header test (rule 5)", () => {
  it("generates provider records", () => {
    const g = expectedRecords("getacme.com", "google");
    expect(g.find((r) => r.purpose === "spf")?.value).toContain("_spf.google.com");
    const m = expectedRecords("getacme.com", "microsoft", { dmarcRua: "dmarc@acme.com" });
    expect(m.find((r) => r.purpose === "mx")?.value).toBe("getacme-com.mail.protection.outlook.com");
    expect(m.find((r) => r.purpose === "dmarc")?.value).toBe("v=DMARC1; p=none; rua=mailto:dmarc@acme.com");
  });
  it("evaluates lookups", () => {
    const key = "v=DKIM1; k=rsa; p=" + "A".repeat(300);
    const ok = evaluateDns("google", {
      rootTxt: ["v=spf1 include:_spf.google.com ~all"],
      dmarcTxt: ["v=DMARC1; p=none"],
      mx: [{ exchange: "smtp.google.com", priority: 1 }],
      dkim: [{ selector: "google", txt: [key] }],
      spfLookups: 4,
    });
    expect(ok.pass).toBe(true);
    const bad = evaluateDns("google", {
      rootTxt: ["v=spf1 include:_spf.google.com ~all", "v=spf1 include:sendgrid.net ~all"],
      dmarcTxt: [],
      mx: [],
      dkim: [],
    });
    expect(bad.pass).toBe(false);
    expect(bad.items.filter((i) => !i.pass).map((i) => i.id)).toEqual(["mx", "spf", "dkim", "dmarc"]);
  });
  it("counts SPF lookups recursively", async () => {
    const zone: Record<string, string[]> = {
      "_spf.google.com": ["v=spf1 include:_netblocks.google.com include:_netblocks2.google.com ~all"],
      "_netblocks.google.com": ["v=spf1 ip4:1.2.3.0/24 ~all"],
      "_netblocks2.google.com": ["v=spf1 ip6:2001::/32 ~all"],
    };
    const n = await countSpfLookups("v=spf1 include:_spf.google.com mx ~all", async (name) => zone[name] ?? []);
    expect(n).toBe(4);
  });
  it("parses Gmail headers", () => {
    const raw = `Delivered-To: me@gmail.com
Authentication-Results: mx.google.com;
       dkim=pass header.i=@getacme.com header.s=google header.b=abc123;
       spf=pass (google.com: domain of jane@getacme.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jane@getacme.com;
       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=getacme.com
From: Jane <jane@getacme.com>
Subject: test`;
    const a = analyzeHeaders(raw, "getacme.com");
    expect(a).toMatchObject({ pass: true, spf: "pass", dkim: "pass", dmarc: "pass", dkimAligned: true });
  });
  it("parses Outlook headers and catches unaligned DKIM", () => {
    const raw = `Authentication-Results: spf=pass (sender IP is 40.1.1.1)
 smtp.mailfrom=getacme.com; dkim=pass (signature was verified)
 header.d=getacme.onmicrosoft.com;dmarc=fail action=none
 header.from=getacme.com;compauth=fail reason=001
From: Jane <jane@getacme.com>`;
    const a = analyzeHeaders(raw, "getacme.com");
    expect(a.pass).toBe(false);
    expect(a.dkimAligned).toBe(false);
    expect(a.dmarc).toBe("fail");
    expect(a.issues.join(" ")).toMatch(/Enable DKIM signing/);
  });
});

describe("lists (rule 8)", () => {
  it("classifies MX: provider and SEG", () => {
    expect(classifyMx(["aspmx.l.google.com"])).toMatchObject({ provider: "google", seg: null });
    expect(classifyMx(["acme-com.mail.protection.outlook.com"])).toMatchObject({ provider: "microsoft" });
    expect(classifyMx(["mx0a-0012.pphosted.com"]).seg).toBe("proofpoint");
    expect(classifyMx(["us-smtp-inbound-1.mimecast.com"]).seg).toBe("mimecast");
    expect(classifyMx(["d123.a.ess.barracudanetworks.com"]).seg).toBe("barracuda");
    expect(classifyMx([]).provider).toBe("none");
  });
  it("buckets prospects", () => {
    const base = { syntaxValid: true, seg: null, blockedSegs: ["proofpoint"], provider: "google" as const };
    expect(bucketFor({ ...base, validation: "valid" })).toBe("ready");
    expect(bucketFor({ ...base, validation: "catch_all" })).toBe("catch_all");
    expect(bucketFor({ ...base, seg: "proofpoint", validation: null })).toBe("seg_blocked");
    expect(bucketFor({ ...base, provider: "none", validation: null })).toBe("invalid");
    expect(bucketFor({ ...base, suppressed: true, validation: "valid" })).toBe("suppressed");
    expect(bucketFor({ ...base, validation: "unknown", unknownWithCatchAll: true })).toBe("catch_all");
  });
});

describe("copy linter (rule 9)", () => {
  const good = {
    subject: "quick question",
    body: "Hi {{firstName|there}},\n\nNoticed {{company|your team}} is hiring SDRs. We help teams like yours book meetings without adding headcount.\n\nNot relevant? Just reply 'no' and I won't follow up.\n\nInterested?",
    signature: "Jane\nAcme",
    isFirstTouch: true,
    jurisdiction: "us" as const,
    postalAddressConfigured: true,
  };
  it("passes clean copy", () => {
    const r = lintCopy(good);
    expect(r.blocks).toBe(0);
    expect(r.findings.filter((f) => f.severity === "warn").map((f) => f.rule)).toEqual([]);
  });
  it("blocks links, html, images, fake Re:", () => {
    const r = lintCopy({ ...good, subject: "Re: our call", body: good.body + "\nSee https://acme.com and <b>this</b> ![x](y.png) or visit acme.io" });
    const rules = r.findings.filter((f) => f.severity === "block").map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["no_links", "no_html", "no_images", "deceptive_subject"]));
  });
  it("warns on corporate language, hard CTA, long signature", () => {
    const r = lintCopy({
      ...good,
      body: "I hope this email finds you well. We leverage best-in-class synergy. Can we book a call for 15 minutes next week. Not relevant? reply 'no'.",
      signature: "Jane Doe\nVP Sales\nAcme Inc\n+1 555 0100\nLinkedIn",
    });
    const rules = r.findings.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["corporate_language", "hard_cta", "soft_cta", "long_signature"]));
  });
  it("blocks missing opt-out under a jurisdiction and unknown merge fields", () => {
    const r = lintCopy({ ...good, body: "Hi {{nickname}},\n\nQuick one. Interested?" });
    expect(r.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["opt_out_missing", "merge_unknown"]));
  });
  it("renders merge fields and spintax deterministically", () => {
    const rand = seededRandom("send-1");
    const r = renderTemplate("{Hi|Hey} {{firstName|there}}, {{company}}", { firstName: "", company: null }, rand);
    expect(r.text).toMatch(/^(Hi|Hey) there, $/);
    expect(r.missing).toEqual(["company"]);
    expect(renderTemplate("{a|b}", {}, seededRandom("x")).text).toBe(renderTemplate("{a|b}", {}, seededRandom("x")).text);
  });
  it("cleans company names", () => {
    expect(cleanCompanyName("Booking.com, Inc.")).toBe("Booking");
    expect(cleanCompanyName("Acme Widgets LLC")).toBe("Acme Widgets");
  });
});

describe("scheduling (rule 11)", () => {
  it("resolves timezones", () => {
    expect(resolveTimezone({ state: "CA" }, "America/New_York")).toBe("America/Los_Angeles");
    expect(resolveTimezone({ country: "United Kingdom" }, "America/New_York")).toBe("Europe/London");
    expect(resolveTimezone({ timezone: "Asia/Tokyo" }, "UTC")).toBe("Asia/Tokyo");
  });
  it("respects windows and weekdays", () => {
    // Monday 2026-11-09 15:00 UTC = 10:00 New York
    expect(inWindow(new Date("2026-11-09T15:00:00Z"), "America/New_York", DEFAULT_SCHEDULE)).toBe(true);
    expect(inWindow(new Date("2026-11-09T03:00:00Z"), "America/New_York", DEFAULT_SCHEDULE)).toBe(false);
    // Saturday
    expect(inWindow(new Date("2026-11-14T15:00:00Z"), "America/New_York", DEFAULT_SCHEDULE)).toBe(false);
    expect(inWindow(new Date("2026-11-14T15:00:00Z"), "America/New_York", { ...DEFAULT_SCHEDULE, saturday: true })).toBe(true);
  });
  it("staggers starts and spaces sends", () => {
    const a = planSlots({ date: "2026-11-10", mailboxTz: "America/New_York", startHour: 8, endHour: 17, count: 15, rand: seededRandom("mb-a") });
    const b = planSlots({ date: "2026-11-10", mailboxTz: "America/New_York", startHour: 8, endHour: 17, count: 15, rand: seededRandom("mb-b") });
    expect(a.length).toBe(15);
    expect(a[0].getTime()).not.toBe(b[0].getTime());
    for (let i = 1; i < a.length; i++) expect(a[i].getTime() - a[i - 1].getTime()).toBeGreaterThanOrEqual(7 * 60_000 - 60_000);
    const open = new Date("2026-11-10T13:00:00Z").getTime();
    expect(a[0].getTime()).toBeGreaterThanOrEqual(open);
    expect(a[0].getTime()).toBeLessThanOrEqual(open + 91 * 60_000);
  });
});

describe("health (rule 12)", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const mk = (n: number, replies: number, bounces: number, ageHours = 72) =>
    Array.from({ length: n }, (_, i) => ({
      sentAt: new Date(now.getTime() - (ageHours + i / 100) * 3_600_000),
      humanReply: i < replies,
      hardBounce: i >= n - bounces,
    }));
  it("needs 1,000 mature sends", () => {
    expect(evaluateHealth({ sends: mk(999, 0, 100), now }).verdict).toBe("insufficient_data");
    expect(evaluateHealth({ sends: mk(1500, 0, 0, 10), now }).verdict).toBe("insufficient_data");
  });
  it("flags red only when both thresholds breach", () => {
    expect(evaluateHealth({ sends: mk(1000, 5, 40), now }).verdict).toBe("red");
    expect(evaluateHealth({ sends: mk(1000, 5, 10), now }).verdict).toBe("amber");
    expect(evaluateHealth({ sends: mk(1000, 30, 10), now }).verdict).toBe("green");
  });
  it("compares with baseline", () => {
    const e = evaluateHealth({ sends: mk(1000, 15, 10), now, baseline: { replyRate: 0.04, bounceRate: 0.01, source: "own" } });
    expect(e.verdict).toBe("amber");
  });
  it("builds a baseline from non-overlapping green windows", () => {
    const w = (d0: number, d1: number, rr: number) => ({ verdict: "green" as const, replyRate: rr, bounceRate: 0.01, firstSendAt: new Date(d0), lastSendAt: new Date(d1) });
    const b = ownBaseline([w(100, 200, 0.03), w(150, 250, 0.9), w(10, 90, 0.02), w(0, 5, 0.04)]);
    // picks (150-250), (10-90), (0-5): overlapping (100-200) is skipped
    expect(b?.replyRate).toBe(0.04);
  });
});

describe("diagnosis (rule 13)", () => {
  it("follows the decision table", () => {
    expect(decide({ authOk: true, control: true, campaign: false }).verdict).toBe("COPY");
    expect(decide({ authOk: true, control: false, campaign: false })).toMatchObject({ verdict: "INFRA", allowsRotation: true });
    expect(decide({ authOk: true, control: true, campaign: true, bounces: bounceComposition(["user_unknown", "user_unknown", "other"]) }).verdict).toBe("LIST");
    expect(decide({ authOk: true, control: true, campaign: true }).verdict).toBe("OFFER");
    expect(decide({ authOk: false, control: false, campaign: false }).verdict).toBe("AUTH");
    expect(decide({ authOk: true, blocklisted: true, control: null, campaign: null }).allowsRotation).toBe(true);
    expect(decide({ authOk: true, control: false, campaign: true }).action).toBe("retest");
  });
  it("summarizes placement", () => {
    expect(summarizePlacement(["inbox", "inbox", "promotions", "inbox", "spam"]).pass).toBe(true);
    expect(summarizePlacement(["inbox", "spam", "missing", "inbox"]).pass).toBe(false);
  });
});

describe("rotation (rule 14) and reserve (rule 7)", () => {
  const now = new Date();
  const cand = (over: Partial<Parameters<typeof planRotation>[1][number]>) => ({
    id: "r1", name: "tryacme.com", provider: "google" as const, state: "ready" as const, pool: "reserve" as const,
    authVerifiedAt: now, warmupDays: 30, warmupHealthy: true, capacity: 45, ...over,
  });
  it("rotates immediately when a warmed replacement exists", () => {
    const p = planRotation({ name: "getacme.com", provider: "google", capacity: 45 }, [cand({}), cand({ id: "r2", warmupDays: 40, name: "useacme.com" })], 450);
    expect(p.mode).toBe("immediate");
    expect(p.replacement?.name).toBe("useacme.com");
    expect(p.capacityAfter).toBe(450);
  });
  it("falls back to layover when nothing is ready", () => {
    const p = planRotation({ name: "getacme.com", provider: "google", capacity: 45 }, [cand({ state: "warming", warmupDays: 8, readyInDays: 6 })], 450);
    expect(p.mode).toBe("layover");
    expect(p.nextUp?.name).toBe("tryacme.com");
    expect(p.layoverDays).toBe(15);
  });
  it("decides migrations", () => {
    expect(migrationFor({ status: "replied", hasReply: true, hasNextStep: true, standaloneAvailable: true })).toBe("keep_thread");
    expect(migrationFor({ status: "active", hasReply: false, hasNextStep: true, standaloneAvailable: true })).toBe("move_standalone");
    expect(migrationFor({ status: "active", hasReply: false, hasNextStep: true, standaloneAvailable: false })).toBe("end_sequence");
  });
  it("computes coverage", () => {
    const c = reserveCoverage([
      { provider: "google", pool: "active", state: "active", capacity: 90 },
      { provider: "google", pool: "reserve", state: "ready", capacity: 45 },
      { provider: "google", pool: "reserve", state: "warming", capacity: 45 },
    ]);
    expect(c[0]).toMatchObject({ ratio: 0.5, status: "warn", warmingReserveCapacity: 45 });
  });
});

describe("inbound classification", () => {
  it("parses Gmail bounces", () => {
    const c = classifyInbound({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      body: "Address not found\n\nYour message wasn't delivered to bob@prospect.com because the address couldn't be found.\n\nThe response was:\n550 5.1.1 The email account that you tried to reach does not exist.",
    });
    expect(c.kind).toBe("bounce");
    expect(c.bounce).toMatchObject({ type: "hard", status: "5.1.1", category: "user_unknown", recipient: "bob@prospect.com" });
  });
  it("parses Exchange spam blocks", () => {
    const c = classifyInbound({
      from: "Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@getacme.com>",
      subject: "Undeliverable: quick question",
      body: "Delivery has failed to these recipients or groups:\nbob@prospect.com\nRemote Server returned '550 5.7.1 Service unavailable; client host blocked using Spamhaus'",
    });
    expect(c.bounce?.category).toBe("policy_or_spam_block");
  });
  it("detects auto-replies and return dates", () => {
    const c = classifyInbound({ from: "a@b.com", subject: "Automatic reply: quick question", body: "I am out of the office and will return on November 17." }, { now: new Date("2026-11-09T00:00:00Z") });
    expect(c.kind).toBe("auto_reply");
    expect(c.returnDate).toBe("2026-11-17");
    expect(extractReturnDate("Back on 3/2", new Date("2026-11-09T00:00:00Z"))).toBe("2027-03-02");
  });
  it("detects intents and opt-outs, ignoring quoted text", () => {
    expect(classifyInbound({ from: "a@b.com", subject: "Re: x", body: "please remove me from your list\n\nOn Mon, Jane wrote:\n> Interested?" })).toMatchObject({ intent: "opt_out", optOutConfidence: "high" });
    expect(classifyInbound({ from: "a@b.com", subject: "Re: x", body: "no" }).intent).toBe("opt_out");
    expect(classifyInbound({ from: "a@b.com", subject: "Re: x", body: "Sounds interesting, tell me more." }).intent).toBe("positive");
    expect(classifyInbound({ from: "a@b.com", subject: "Re: x", body: "Not interested, thanks." })).toMatchObject({ intent: "not_interested", optOutConfidence: "low" });
    expect(classifyInbound({ from: "a@b.com", subject: "Re: x", body: "You should talk to Sam, the right person is sam@b.com" }).intent).toBe("referral");
  });
});

describe("pre-flight guard (§5 invariants)", () => {
  const now = new Date();
  const ok: PreflightContext = {
    kind: "first_touch",
    now,
    protectedDomains: ["acme.com"],
    domain: { name: "getacme.com", provider: "google", state: "active", authVerifiedAt: now },
    mailbox: { state: "active", connection: "connected", warmupDays: 20, address: "jane@getacme.com" },
    caps: { mailboxSent: 3, mailboxCap: 15, domainSent: 10, domainCap: 45 },
    prospect: { validationStatus: "valid", validatedAt: now, bucket: "ready", seg: null, suppressed: false },
    campaign: { status: "active", isCatchAll: false },
    message: { body: "Hi there. Interested?", lintBlocks: 0, missingMerge: [] },
    inWindow: true,
  };
  it("passes a clean send", () => expect(preflight(ok)).toEqual({ ok: true, reasons: [] }));
  it("blocks each invariant", () => {
    const cases: [Partial<PreflightContext>, string][] = [
      [{ domain: { ...ok.domain, name: "mail.acme.com" } }, "PROTECTED_DOMAIN"],
      [{ caps: { ...ok.caps, mailboxSent: 15 } }, "CAP_MAILBOX"],
      [{ caps: { ...ok.caps, domainSent: 45 } }, "CAP_DOMAIN"],
      [{ domain: { ...ok.domain, authVerifiedAt: new Date(now.getTime() - 30 * 3_600_000) } }, "AUTH_STALE"],
      [{ mailbox: { ...ok.mailbox, warmupDays: 10 } }, "WARMUP_INCOMPLETE"],
      [{ prospect: { ...ok.prospect!, bucket: "catch_all" } }, "BUCKET_NOT_SENDABLE"],
      [{ prospect: { ...ok.prospect!, suppressed: true } }, "SUPPRESSED"],
      [{ prospect: { ...ok.prospect!, seg: "mimecast" } }, "SEG_BLOCKED"],
      [{ prospect: { ...ok.prospect!, validatedAt: new Date(now.getTime() - 40 * DAY) } }, "VALIDATION_EXPIRED"],
      [{ message: { body: "see https://x.com", lintBlocks: 0, missingMerge: [] } }, "TRACKING_CONTENT"],
      [{ domain: { ...ok.domain, state: "layover" } }, "DOMAIN_NOT_SENDING"],
    ];
    for (const [over, reason] of cases) expect(preflight({ ...ok, ...over }).reasons).toContain(reason);
  });
  it("allows follow-ups during layover", () => {
    expect(preflight({ ...ok, kind: "follow_up", domain: { ...ok.domain, state: "layover" } }).ok).toBe(true);
  });
});

describe("placeholders", () => {
  it("blocks unfilled [placeholders]", () => {
    const r = lintCopy({ subject: "hi", body: "We help [who] do [what]. Interested?", isFirstTouch: true });
    expect(r.findings.filter((f) => f.rule === "placeholder").length).toBe(2);
  });
});
