/** Volume caps (SPEC §6.3, playbook rule 4) and the capacity planner (§8.1, rules 3, 4, 7). */
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";
import type { Provider } from "./types";

export function mailboxDailyCap(provider: Provider, policies: Policies = DEFAULT_POLICIES, override?: number | null): number {
  const base = provider === "google" ? policies.caps.google.perMailboxDaily : policies.caps.microsoft.perMailboxDaily;
  return override != null ? override : base;
}

export function maxMailboxesPerDomain(provider: Provider, policies: Policies = DEFAULT_POLICIES): number {
  return provider === "google" ? policies.caps.google.mailboxesPerDomain : policies.caps.microsoft.mailboxesPerDomainMax;
}

/** Domain cap = min(domain policy cap, mailboxes × mailbox cap). */
export function domainDailyCap(
  provider: Provider,
  sendingMailboxes: number,
  policies: Policies = DEFAULT_POLICIES,
  override?: number | null,
): number {
  const policyCap = provider === "google" ? policies.caps.google.perDomainDaily : policies.caps.microsoft.perDomainDaily;
  const domainCap = override != null ? override : policyCap;
  return Math.min(domainCap, sendingMailboxes * mailboxDailyCap(provider, policies));
}

export interface PriceInputs {
  /** Monthly price of one active mailbox. */
  mailboxMonthly: number;
  /** Monthly price of one reserve mailbox (0 when warming in Hypertide's Recovery Pool). */
  reserveMailboxMonthly: number;
  /** Monthly tenant/workspace fee per domain, if your vendor charges one. */
  domainMonthlyFee: number;
  /** Domain registration per year. */
  domainYearly: number;
  /** Warmup tool per mailbox per month (0 if included). */
  warmupPerMailboxMonthly: number;
  /** Email validation cost per address. */
  validationPerEmail: number;
  /** Cold itself on Azure (Container Apps + Postgres). */
  platformMonthly: number;
}

/**
 * Mailbox price presets, researched November 2026. List prices change and resellers
 * negotiate, so the planner shows the source and lets you overwrite every number.
 *
 * Why the cheap Microsoft option is a reseller, not Microsoft itself: the playbook caps a
 * Microsoft inbox at 3 sends/day vs 15 for Google, so a Microsoft inbox must cost less than
 * one fifth of a Google inbox to be cheaper per email. Direct Microsoft licenses don't.
 */
export interface PricePreset {
  id: string;
  provider: Provider;
  label: string;
  /** Price per active inbox per month (USD). */
  mailboxMonthly: number;
  /** Price per reserve inbox per month while it warms (0 when the vendor parks reserves for free). */
  reserveMailboxMonthly: number;
  /** Inboxes per domain this offer is built around (Microsoft only). */
  mailboxesPerDomain?: number;
  note: string;
  sources: { label: string; url: string }[];
  /** How solid the number is: confirmed on the vendor's own page, or reported by third parties. */
  confidence: "vendor" | "reported";
  checked: string;
}

export const PRICE_PRESETS: PricePreset[] = [
  {
    id: "google-direct-annual",
    provider: "google",
    label: "Google Workspace Business Starter (annual)",
    mailboxMonthly: 7,
    reserveMailboxMonthly: 7,
    note: "Bought from Google on a 1-year plan. Reserve inboxes must be paid while they warm.",
    sources: [
      { label: "Google Workspace pricing 2026 (dupple)", url: "https://dupple.com/learn/google-workspace-pricing" },
      { label: "Google Workspace pricing 2026 (dragapp)", url: "https://www.dragapp.com/blog/google-workspace-pricing/" },
    ],
    confidence: "reported",
    checked: "2026-11-09",
  },
  {
    id: "google-direct-flexible",
    provider: "google",
    label: "Google Workspace Business Starter (monthly)",
    mailboxMonthly: 8.4,
    reserveMailboxMonthly: 8.4,
    note: "Flexible month-to-month plan, so you can drop burned inboxes without a 1-year commitment.",
    sources: [{ label: "Google Workspace pricing 2026 (dupple)", url: "https://dupple.com/learn/google-workspace-pricing" }],
    confidence: "reported",
    checked: "2026-11-09",
  },
  {
    id: "google-reseller",
    provider: "google",
    label: "Cold-email reseller, Google inboxes",
    mailboxMonthly: 3,
    reserveMailboxMonthly: 3,
    note: "Typical $2.50–$3.50 per inbox (InboxKit, Zapmail, Hypertide). Check whether the vendor charges for reserve inboxes.",
    sources: [
      { label: "InboxKit infrastructure comparison", url: "https://www.inboxkit.com/learn/cold-email-infrastructure-comparison-2026" },
      { label: "Cold email infrastructure cost 2026 (maildeck)", url: "https://maildeck.co/blog/cold-email-infrastructure-cost-2026/" },
      { label: "Hypertide Google infrastructure", url: "https://www.hypertide.io/google" },
    ],
    confidence: "reported",
    checked: "2026-11-09",
  },
  {
    id: "ms-business-basic",
    provider: "microsoft",
    label: "Microsoft 365 Business Basic (direct)",
    mailboxMonthly: 7,
    reserveMailboxMonthly: 7,
    mailboxesPerDomain: 50,
    note: "Microsoft's list price from July 1, 2026 ($6 before). At 3 sends per inbox per day this is the most expensive way to send cold email.",
    sources: [{ label: "Microsoft 365 pricing updates (Microsoft)", url: "https://www.microsoft.com/en-us/licensing/news/2026-m365-packaging-pricing-updates" }],
    confidence: "vendor",
    checked: "2026-11-09",
  },
  {
    id: "ms-exchange-p1",
    provider: "microsoft",
    label: "Exchange Online Plan 1 (direct)",
    mailboxMonthly: 4,
    reserveMailboxMonthly: 4,
    mailboxesPerDomain: 50,
    note: "Email-only license, annual commitment. Still ~3x Google per email sent because of the 3/day cap.",
    sources: [{ label: "Exchange Online plans compared (o365hq)", url: "https://o365hq.com/md/blog/exchange-online-plan-1-vs-plan-2-vs-kiosk-vs-business-basic-mailbox-licensing" }],
    confidence: "reported",
    checked: "2026-11-09",
  },
  {
    id: "ms-bulk-reseller",
    provider: "microsoft",
    label: "Bulk “Azure” inboxes via reseller (e.g. Hypertide)",
    mailboxMonthly: 1,
    reserveMailboxMonthly: 0,
    mailboxesPerDomain: 25,
    note: "Reported $25/month per Entra domain with 25 inboxes ($1/inbox); older reports say $50 per 100 inboxes ($0.50). Reserve domains rest in the Recovery Pool without paid inboxes. Confirm current pricing and licensing with the vendor.",
    sources: [
      { label: "Hypertide review (outreach2day)", url: "https://outreach2day.com/reviews/hypertide" },
      { label: "Hypertide review (aerosend)", url: "https://www.aerosend.io/review/hypertide/" },
      { label: "Zapmail alternatives (salesforge)", url: "https://www.salesforge.ai/blog/zapmail-alternatives" },
    ],
    confidence: "reported",
    checked: "2026-11-09",
  },
  {
    id: "ms-per-inbox-reseller",
    provider: "microsoft",
    label: "Per-inbox Outlook reseller",
    mailboxMonthly: 3,
    reserveMailboxMonthly: 3,
    mailboxesPerDomain: 50,
    note: "Typical $2.25–$4.50 per Microsoft inbox (InboxKit, Zapmail and others). At this price Google is cheaper per email.",
    sources: [
      { label: "InboxKit infrastructure comparison", url: "https://www.inboxkit.com/learn/cold-email-infrastructure-comparison-2026" },
      { label: "Cold email infrastructure providers (saleshandy)", url: "https://www.saleshandy.com/blog/cold-email-infrastructure-providers/" },
    ],
    confidence: "reported",
    checked: "2026-11-09",
  },
];

export const DEFAULT_PRESET: Record<Provider, string> = { google: "google-direct-annual", microsoft: "ms-bulk-reseller" };

const COMMON_PRICES = {
  domainMonthlyFee: 0,
  domainYearly: 11,
  warmupPerMailboxMonthly: 0,
  validationPerEmail: 0.002,
  /** Cold on Cloudflare: Workers Paid ($5) + one always-on basic container (~$7). Database extra. */
  platformMonthly: 12,
};

export function pricesFromPreset(id: string): Partial<PriceInputs> {
  const p = PRICE_PRESETS.find((x) => x.id === id);
  return p ? { mailboxMonthly: p.mailboxMonthly, reserveMailboxMonthly: p.reserveMailboxMonthly } : {};
}

/** Starting prices for the planner. Every number is editable in the UI. */
export const EXAMPLE_PRICES: Record<Provider, PriceInputs> = {
  google: { ...COMMON_PRICES, mailboxMonthly: 7, reserveMailboxMonthly: 7 },
  microsoft: { ...COMMON_PRICES, mailboxMonthly: 1, reserveMailboxMonthly: 0 },
};

/** Monthly mailbox cost of one daily send slot: the number that decides Google vs Microsoft. */
export function costPerDailySend(provider: Provider, mailboxMonthly: number, policies: Policies = DEFAULT_POLICIES): number {
  return mailboxMonthly / mailboxDailyCap(provider, policies);
}

export interface PlanInput {
  targetDaily: number;
  provider: Provider;
  includeSaturday?: boolean;
  reserveRatio?: number;
  /** Microsoft only: 1–50 (default 50). Google uses the policy (3). */
  mailboxesPerDomain?: number;
  prices?: Partial<PriceInputs>;
  /** Steps per sequence, used to estimate how many new prospects need validating per month. */
  stepsPerSequence?: number;
  policies?: Policies;
}

export interface PlanResult {
  provider: Provider;
  perMailboxDaily: number;
  mailboxesPerDomain: number;
  perDomainDaily: number;
  activeDomains: number;
  reserveDomains: number;
  activeMailboxes: number;
  reserveMailboxes: number;
  totalDomains: number;
  totalMailboxes: number;
  dailyCapacity: number;
  sendingDaysPerMonth: number;
  monthlySends: number;
  newProspectsPerMonth: number;
  cost: {
    mailboxes: number;
    reserve: number;
    domains: number;
    warmup: number;
    validation: number;
    platform: number;
    total: number;
    perThousandSends: number;
  };
  leadTimeDaysMin: number;
  leadTimeDaysRecommended: number;
  daysToFirstVerdictPerDomain: number;
}

export function planCapacity(input: PlanInput): PlanResult {
  const policies = input.policies ?? DEFAULT_POLICIES;
  const provider = input.provider;
  const perMailboxDaily = mailboxDailyCap(provider, policies);
  const maxBoxes = maxMailboxesPerDomain(provider, policies);
  const mailboxesPerDomain =
    provider === "google"
      ? maxBoxes
      : Math.max(1, Math.min(maxBoxes, Math.round(input.mailboxesPerDomain ?? maxBoxes)));
  const perDomainDaily = domainDailyCap(provider, mailboxesPerDomain, policies);
  const target = Math.max(0, input.targetDaily);
  const reserveRatio = input.reserveRatio ?? policies.reserve.ratio;

  const activeDomains = target === 0 ? 0 : Math.ceil(target / perDomainDaily);
  const reserveDomains = Math.ceil(activeDomains * reserveRatio);
  const activeMailboxes = activeDomains * mailboxesPerDomain;
  const reserveMailboxes = reserveDomains * mailboxesPerDomain;
  const sendingDaysPerMonth = input.includeSaturday ? 26 : 21.7;
  const monthlySends = Math.round(target * sendingDaysPerMonth);
  const steps = Math.max(1, input.stepsPerSequence ?? 3);
  const newProspectsPerMonth = Math.round(monthlySends / steps);

  const p: PriceInputs = { ...EXAMPLE_PRICES[provider], ...input.prices };
  const totalDomains = activeDomains + reserveDomains;
  const totalMailboxes = activeMailboxes + reserveMailboxes;
  const cost = {
    mailboxes: activeMailboxes * p.mailboxMonthly,
    reserve: reserveMailboxes * p.reserveMailboxMonthly,
    domains: totalDomains * (p.domainYearly / 12 + p.domainMonthlyFee),
    warmup: totalMailboxes * p.warmupPerMailboxMonthly,
    validation: newProspectsPerMonth * p.validationPerEmail,
    platform: p.platformMonthly,
    total: 0,
    perThousandSends: 0,
  };
  cost.total = cost.mailboxes + cost.reserve + cost.domains + cost.warmup + cost.validation + cost.platform;
  cost.perThousandSends = monthlySends > 0 ? (cost.total / monthlySends) * 1000 : 0;

  return {
    provider,
    perMailboxDaily,
    mailboxesPerDomain,
    perDomainDaily,
    activeDomains,
    reserveDomains,
    activeMailboxes,
    reserveMailboxes,
    totalDomains,
    totalMailboxes,
    dailyCapacity: activeDomains * perDomainDaily,
    sendingDaysPerMonth,
    monthlySends,
    newProspectsPerMonth,
    cost,
    leadTimeDaysMin: policies.warmup.minDays,
    leadTimeDaysRecommended: policies.warmup.targetDays,
    daysToFirstVerdictPerDomain: perDomainDaily > 0 ? Math.ceil(policies.health.minSample / perDomainDaily) + 2 : 0,
  };
}

/** Side-by-side comparison (playbook rule 3). Ratio > 1 means Microsoft is cheaper per send. */
export function compareProviders(input: Omit<PlanInput, "provider" | "prices"> & { prices?: Partial<Record<Provider, Partial<PriceInputs>>> }) {
  const google = planCapacity({ ...input, provider: "google", prices: input.prices?.google });
  const microsoft = planCapacity({ ...input, provider: "microsoft", prices: input.prices?.microsoft });
  const infra = (r: PlanResult) => r.cost.mailboxes + r.cost.reserve + r.cost.domains + r.cost.warmup;
  const ratio = infra(microsoft) > 0 ? infra(google) / infra(microsoft) : null;
  const gp = { ...EXAMPLE_PRICES.google, ...input.prices?.google };
  const mp = { ...EXAMPLE_PRICES.microsoft, ...input.prices?.microsoft };
  const policies = input.policies ?? DEFAULT_POLICIES;
  return {
    google,
    microsoft,
    /** Google infrastructure cost ÷ Microsoft infrastructure cost for the same volume (> 1: Microsoft cheaper). */
    infraCostRatio: ratio,
    /** Google inbox price ÷ Microsoft inbox price: the "5–6× cheaper" figure people quote. */
    perInboxRatio: mp.mailboxMonthly > 0 ? gp.mailboxMonthly / mp.mailboxMonthly : null,
    /** Same, per daily send slot (accounts for 15/day vs 3/day per inbox). */
    perSendRatio:
      mp.mailboxMonthly > 0 ? costPerDailySend("google", gp.mailboxMonthly, policies) / costPerDailySend("microsoft", mp.mailboxMonthly, policies) : null,
  };
}
