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
 * Example prices only. They are placeholders so the planner renders something useful;
 * replace them with your own vendor quotes in the UI.
 */
export const EXAMPLE_PRICES: Record<Provider, PriceInputs> = {
  google: {
    mailboxMonthly: 7,
    reserveMailboxMonthly: 0,
    domainMonthlyFee: 0,
    domainYearly: 11,
    warmupPerMailboxMonthly: 0,
    validationPerEmail: 0.002,
    platformMonthly: 35,
  },
  microsoft: {
    mailboxMonthly: 0.25,
    reserveMailboxMonthly: 0,
    domainMonthlyFee: 0,
    domainYearly: 11,
    warmupPerMailboxMonthly: 0,
    validationPerEmail: 0.002,
    platformMonthly: 35,
  },
};

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
  return { google, microsoft, infraCostRatio: ratio };
}
