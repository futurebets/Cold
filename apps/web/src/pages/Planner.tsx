import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, Save, RotateCcw, ExternalLink } from "lucide-react";
import type { PlanResult, PriceInputs, PricePreset, Provider } from "@cold/core";
import { compareProviders, costPerDailySend, DEFAULT_POLICIES, EXAMPLE_PRICES, planCapacity, pricesFromPreset, PRICE_PRESETS } from "@cold/core";
import { put, useAction, useGet } from "../lib/api";
import { money, num } from "../lib/format";
import { Badge, Button, Callout, Card, Field, Input, LinkButton, PageHeader, RuleTag, Select, TableCard, Toggle } from "../components/ui";
import { ProviderLogo } from "../components/badges";
import type { PoliciesResponse, SettingsResponse } from "../components/infra/types";

const PRICE_FIELDS: { key: keyof PriceInputs; label: string; step: number; hint?: string }[] = [
  { key: "mailboxMonthly", label: "Active mailbox / month", step: 0.05 },
  { key: "reserveMailboxMonthly", label: "Reserve mailbox / month", step: 0.05, hint: "0 with Hypertide's Recovery Pool" },
  { key: "domainMonthlyFee", label: "Tenant fee per domain / month", step: 0.5 },
  { key: "domainYearly", label: "Domain registration / year", step: 0.5 },
  { key: "warmupPerMailboxMonthly", label: "Warmup per mailbox / month", step: 0.1 },
  { key: "validationPerEmail", label: "Validation per address", step: 0.0005 },
  { key: "platformMonthly", label: "Cold hosting / month", step: 1, hint: "Cloudflare Workers Paid + one container. Add your database." },
];

type Prices = Record<Provider, PriceInputs>;

/** The preset whose inbox prices match, or "custom". */
function matchPreset(p: Provider, prices: PriceInputs): string {
  return PRICE_PRESETS.find((x) => x.provider === p && x.mailboxMonthly === prices.mailboxMonthly && x.reserveMailboxMonthly === prices.reserveMailboxMonthly)?.id ?? "custom";
}

function mergePrices(saved?: Record<string, Record<string, number>>): Prices {
  return {
    google: { ...EXAMPLE_PRICES.google, ...(saved?.google ?? {}) },
    microsoft: { ...EXAMPLE_PRICES.microsoft, ...(saved?.microsoft ?? {}) },
  };
}

export default function PlannerPage() {
  const settings = useGet<SettingsResponse>("/settings");
  const policiesQ = useGet<PoliciesResponse>("/policies");
  const policies = policiesQ.data?.effective ?? DEFAULT_POLICIES;

  const [targetDaily, setTargetDaily] = useState(1000);
  const [includeSaturday, setIncludeSaturday] = useState(false);
  const [reserveRatio, setReserveRatio] = useState(policies.reserve.ratio);
  const [msBoxes, setMsBoxes] = useState(policies.caps.microsoft.mailboxesPerDomainMax);
  const [steps, setSteps] = useState(3);
  const [prices, setPrices] = useState<Prices>(mergePrices());
  const [pricesLoaded, setPricesLoaded] = useState(false);

  useEffect(() => {
    if (settings.data && !pricesLoaded) {
      setPrices(mergePrices(settings.data.workspace.settings.prices));
      setPricesLoaded(true);
    }
  }, [settings.data, pricesLoaded]);
  useEffect(() => {
    if (policiesQ.data) {
      setReserveRatio(policiesQ.data.effective.reserve.ratio);
      const max = policiesQ.data.effective.caps.microsoft.mailboxesPerDomainMax;
      const preset = PRICE_PRESETS.find((x) => x.id === matchPreset("microsoft", prices.microsoft));
      setMsBoxes(Math.min(max, preset?.mailboxesPerDomain ?? max));
    }
  }, [policiesQ.data]);

  const plan = useMemo(
    () => compareProviders({ targetDaily, includeSaturday, reserveRatio, mailboxesPerDomain: msBoxes, stepsPerSequence: steps, prices, policies }),
    [targetDaily, includeSaturday, reserveRatio, msBoxes, steps, prices, policies],
  );
  const savePrices = useAction(() => put("/settings", { prices }), { invalidate: ["/settings"], success: "Prices saved for your workspace" });

  const infra = (r: PlanResult) => r.cost.mailboxes + r.cost.reserve + r.cost.domains + r.cost.warmup;
  const cheaper: Provider = plan.microsoft.cost.total <= plan.google.cost.total ? "microsoft" : "google";
  const ratio = plan.infraCostRatio;
  const chartData = [
    { name: "Google", Mailboxes: plan.google.cost.mailboxes, Reserve: plan.google.cost.reserve, Domains: plan.google.cost.domains, Warmup: plan.google.cost.warmup, Validation: plan.google.cost.validation, Platform: plan.google.cost.platform },
    { name: "Microsoft", Mailboxes: plan.microsoft.cost.mailboxes, Reserve: plan.microsoft.cost.reserve, Domains: plan.microsoft.cost.domains, Warmup: plan.microsoft.cost.warmup, Validation: plan.microsoft.cost.validation, Platform: plan.microsoft.cost.platform },
  ];

  const setPrice = (p: Provider, key: keyof PriceInputs, v: string) => setPrices({ ...prices, [p]: { ...prices[p], [key]: Number(v) || 0 } });
  const applyPreset = (p: Provider, id: string) => {
    const preset = PRICE_PRESETS.find((x) => x.id === id);
    if (!preset) return;
    setPrices({ ...prices, [p]: { ...prices[p], ...pricesFromPreset(id) } });
    if (p === "microsoft" && preset.mailboxesPerDomain) setMsBoxes(Math.min(policies.caps.microsoft.mailboxesPerDomainMax, preset.mailboxesPerDomain));
  };
  const selected: Record<Provider, string> = { google: matchPreset("google", prices.google), microsoft: matchPreset("microsoft", prices.microsoft) };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Capacity planner"
        rules={[3, 4, 7]}
        description="How many domains and inboxes you need for a daily volume, on Google vs Microsoft, including the warmed reserve set and what it costs."
        actions={<LinkButton to="/domains" variant="primary" icon={<ArrowRight className="size-4" />}>Add these domains</LinkButton>}
      />

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Your volume">
            <div className="space-y-5">
              <Field label="Cold emails per sending day">
                <div className="flex items-center gap-3">
                  <input type="range" min={0} max={10000} step={50} value={targetDaily} onChange={(e) => setTargetDaily(Number(e.target.value))} className="flex-1 accent-brand-600" />
                  <Input type="number" min={0} value={targetDaily} onChange={(e) => setTargetDaily(Math.max(0, Number(e.target.value) || 0))} className="w-24 text-right tabular-nums" />
                </div>
              </Field>
              <Toggle checked={includeSaturday} onChange={setIncludeSaturday} label="Also send on Saturdays" />
              <Field label="Reserve ratio" hint="Warmed reserve per unit of active capacity. 1.0 = two full sets (rule 7).">
                <Input type="number" min={0} max={3} step={0.25} value={reserveRatio} onChange={(e) => setReserveRatio(Math.max(0, Number(e.target.value) || 0))} />
              </Field>
              <Field label="Microsoft mailboxes per domain" hint={`1–${policies.caps.microsoft.mailboxesPerDomainMax}. Google is fixed at ${policies.caps.google.mailboxesPerDomain}.`}>
                <Input type="number" min={1} max={policies.caps.microsoft.mailboxesPerDomainMax} value={msBoxes} onChange={(e) => setMsBoxes(Math.min(policies.caps.microsoft.mailboxesPerDomainMax, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
              <Field label="Steps per sequence" hint="Used to estimate new prospects to validate each month.">
                <Input type="number" min={1} max={10} value={steps} onChange={(e) => setSteps(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
            </div>
          </Card>

          <Card title="Where you buy inboxes" subtitle="Researched November 2026. Pick the closest offer, then adjust the numbers below to your quote.">
            <div className="space-y-5">
              {(["google", "microsoft"] as Provider[]).map((p) => {
                const preset = PRICE_PRESETS.find((x) => x.id === selected[p]);
                return (
                  <div key={p}>
                    <Field label={<span className="flex items-center gap-1.5"><ProviderLogo provider={p} className="size-3.5" /> {p === "google" ? "Google" : "Microsoft"}</span>}>
                      <Select value={selected[p]} onChange={(e) => applyPreset(p, e.target.value)}>
                        {PRICE_PRESETS.filter((x) => x.provider === p).map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label} · ${x.mailboxMonthly}/inbox
                          </option>
                        ))}
                        {selected[p] === "custom" && <option value="custom">Custom prices</option>}
                      </Select>
                    </Field>
                    {preset && <PresetNote preset={preset} />}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card
            title="Prices"
            subtitle="Edit any number to match your quotes."
            actions={
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setPrices(mergePrices())}>
                Reset
              </Button>
            }
            footer={
              <Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={savePrices.isPending} onClick={() => savePrices.mutate()}>
                Save prices
              </Button>
            }
          >
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_76px_76px] items-center gap-2 text-xs font-medium text-ink-500">
                <span />
                <span className="flex items-center justify-center gap-1">
                  <ProviderLogo provider="google" className="size-3" /> Google
                </span>
                <span className="flex items-center justify-center gap-1">
                  <ProviderLogo provider="microsoft" className="size-3" /> Microsoft
                </span>
              </div>
              {PRICE_FIELDS.map((f) => (
                <div key={f.key} className="grid grid-cols-[1fr_76px_76px] items-center gap-2">
                  <span className="text-xs text-ink-600" title={f.hint}>
                    {f.label}
                  </span>
                  {(["google", "microsoft"] as Provider[]).map((p) => (
                    <input
                      key={p}
                      type="number"
                      min={0}
                      step={f.step}
                      value={prices[p][f.key]}
                      onChange={(e) => setPrice(p, f.key, e.target.value)}
                      className="input px-2 py-1.5 text-right text-xs tabular-nums"
                    />
                  ))}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {targetDaily > 0 && ratio != null && plan.perInboxRatio != null && plan.perSendRatio != null && (
            <Callout tone={ratio >= 1 ? "blue" : "amber"} title={ratio >= 1 ? `Microsoft is ${ratio.toFixed(1)}× cheaper overall at these prices` : `Google is ${(1 / ratio).toFixed(1)}× cheaper overall at these prices`} action={<RuleTag n={3} />}>
              <p>
                <Ratio x={plan.perInboxRatio} /> per inbox, but a Microsoft inbox sends {policies.caps.microsoft.perMailboxDaily}/day vs {policies.caps.google.perMailboxDaily}/day for Google, so per email it's <Ratio x={plan.perSendRatio} />. Reserve inboxes and domain count
                make up the rest: Microsoft needs {num(plan.microsoft.totalDomains)} domains here, Google {num(plan.google.totalDomains)}.
              </p>
              <p className="mt-1.5">Microsoft only wins on cost through bulk “Azure” resellers. Licenses bought from Microsoft cost more per email than Google.</p>
            </Callout>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {(["microsoft", "google"] as Provider[]).map((p) => (
              <ProviderPlan key={p} r={plan[p]} best={cheaper === p && targetDaily > 0} infraCost={infra(plan[p])} />
            ))}
          </div>

          <AllOptions targetDaily={targetDaily} includeSaturday={includeSaturday} reserveRatio={reserveRatio} policies={policies} base={prices} />

          <Card title="Monthly cost breakdown" subtitle="Infrastructure plus validation and hosting.">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid horizontal={false} stroke="#eef0f4" />
                  <XAxis type="number" tickFormatter={(v: number) => money(v)} tick={{ fontSize: 12, fill: "#667085" }} />
                  <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 12, fill: "#343b4c" }} />
                  <Tooltip formatter={(v) => money(Number(v), 2)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Mailboxes" stackId="a" fill="#2652e0" />
                  <Bar dataKey="Reserve" stackId="a" fill="#93b4fd" />
                  <Bar dataKey="Domains" stackId="a" fill="#7c3aed" />
                  <Bar dataKey="Warmup" stackId="a" fill="#c4b5fd" />
                  <Bar dataKey="Validation" stackId="a" fill="#10b981" />
                  <Bar dataKey="Platform" stackId="a" fill="#8d96a8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Timeline" subtitle="Infrastructure can't send on day one.">
            <ol className="relative space-y-4 border-l border-ink-200 pl-5 text-sm">
              <li>
                <span className="absolute -left-1.5 mt-1 size-3 rounded-full bg-brand-500" />
                <p className="font-medium text-ink-800">Day 0: buy domains, publish DNS, pass header tests, start warmup</p>
                <p className="text-ink-500">Both sets warm in parallel. <RuleTag n={5} /></p>
              </li>
              <li>
                <span className="absolute -left-1.5 mt-1 size-3 rounded-full bg-violet-500" />
                <p className="font-medium text-ink-800">Day {policies.warmup.minDays}: earliest first send</p>
                <p className="text-ink-500">
                  {policies.warmup.targetDays} days is better. The active set starts automatically. <RuleTag n={6} />
                </p>
              </li>
              <li>
                <span className="absolute -left-1.5 mt-1 size-3 rounded-full bg-emerald-500" />
                <p className="font-medium text-ink-800">First health verdict per domain</p>
                <p className="text-ink-500">
                  Microsoft after ~{plan.microsoft.daysToFirstVerdictPerDomain} sending days, Google after ~{plan.google.daysToFirstVerdictPerDomain} ({num(policies.health.minSample)} mature sends per domain). <RuleTag n={12} />
                </p>
              </li>
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-ink-500">{label}</span>
      <span className={clsx("text-sm tabular-nums", strong ? "font-semibold text-ink-900" : "text-ink-800")}>{value}</span>
    </div>
  );
}

function ProviderPlan({ r, best, infraCost }: { r: PlanResult; best: boolean; infraCost: number }) {
  return (
    <section className={clsx("rounded-xl border bg-white p-5 shadow-xs", best ? "border-emerald-300 ring-2 ring-emerald-100" : "border-ink-200")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ProviderLogo provider={r.provider} className="size-4" />
          <h3 className="font-semibold text-ink-900">{r.provider === "google" ? "Google Workspace" : "Microsoft 365"}</h3>
        </div>
        {best && <Badge tone="green">Lowest cost</Badge>}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {r.mailboxesPerDomain} inboxes × {r.perMailboxDaily}/day = {r.perDomainDaily}/day per domain
      </p>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight text-ink-900 tabular-nums">{money(r.cost.total)}</span>
        <span className="text-sm text-ink-500">/ month</span>
      </div>
      <p className="text-sm text-ink-500">
        {money(r.cost.perThousandSends, 2)} per 1,000 emails · infrastructure {money(infraCost)}
      </p>
      <div className="mt-4 divide-y divide-ink-100 border-t border-ink-100">
        <Row label="Active domains / mailboxes" value={`${num(r.activeDomains)} / ${num(r.activeMailboxes)}`} />
        <Row label="Reserve domains / mailboxes" value={`${num(r.reserveDomains)} / ${num(r.reserveMailboxes)}`} />
        <Row label="Total to buy" value={`${num(r.totalDomains)} domains · ${num(r.totalMailboxes)} inboxes`} strong />
        <Row label="Daily capacity" value={`${num(r.dailyCapacity)}/day`} />
        <Row label="Emails per month" value={num(r.monthlySends)} />
        <Row label="New prospects to validate / month" value={num(r.newProspectsPerMonth)} />
        <Row label="Days to first verdict (one domain)" value={`~${r.daysToFirstVerdictPerDomain}`} />
      </div>
    </section>
  );
}

function Ratio({ x }: { x: number }) {
  return <strong className="font-semibold text-ink-900">{x >= 1 ? `Microsoft ${x.toFixed(1)}× cheaper` : `Google ${(1 / x).toFixed(1)}× cheaper`}</strong>;
}

function PresetNote({ preset }: { preset: PricePreset }) {
  return (
    <div className="mt-2 space-y-1.5 text-xs text-ink-500">
      <div className="flex flex-wrap items-center gap-1.5">
        {preset.confidence === "vendor" ? <Badge tone="green">Vendor list price</Badge> : <Badge tone="amber">Reported, confirm with vendor</Badge>}
        <span>
          Reserve inbox ${preset.reserveMailboxMonthly}/mo{preset.mailboxesPerDomain && preset.provider === "microsoft" ? ` · ${preset.mailboxesPerDomain} inboxes/domain` : ""}
        </span>
      </div>
      <p>{preset.note}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {preset.sources.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-600 hover:text-brand-700">
            {s.label} <ExternalLink className="size-3" />
          </a>
        ))}
      </div>
    </div>
  );
}

/** Every researched option at the current volume, cheapest first. */
function AllOptions({ targetDaily, includeSaturday, reserveRatio, policies, base }: { targetDaily: number; includeSaturday: boolean; reserveRatio: number; policies: typeof DEFAULT_POLICIES; base: Prices }) {
  const rows = PRICE_PRESETS.map((p) => {
    const r = planCapacity({
      targetDaily,
      provider: p.provider,
      includeSaturday,
      reserveRatio,
      mailboxesPerDomain: p.mailboxesPerDomain,
      prices: { ...base[p.provider], ...pricesFromPreset(p.id) },
      policies,
    });
    const infra = r.cost.mailboxes + r.cost.reserve + r.cost.domains + r.cost.warmup;
    return { p, r, infra, perEmail: r.monthlySends ? (infra / r.monthlySends) * 1000 : 0, perSend: costPerDailySend(p.provider, p.mailboxMonthly, policies) };
  }).sort((a, b) => a.infra - b.infra);
  if (targetDaily <= 0) return null;
  return (
    <Card title={`Every option at ${num(targetDaily)} emails/day`} subtitle="Mailboxes (active + reserve), domains and warmup. Cheapest first." padded={false}>
      <TableCard className="rounded-none border-0 shadow-none">
        <table className="tbl">
          <thead>
            <tr>
              <th>Option</th>
              <th className="text-right">Inbox</th>
              <th className="text-right">Daily send</th>
              <th className="text-right">Inboxes · dom.</th>
              <th className="text-right">Per month</th>
              <th className="text-right">Per 1k emails</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, r, infra, perEmail, perSend }, i) => (
              <tr key={p.id} className={i === 0 ? "bg-emerald-50/50" : undefined}>
                <td className="min-w-44">
                  <div className="flex items-start gap-2">
                    <ProviderLogo provider={p.provider} className="mt-0.5 size-3.5 shrink-0" />
                    <div>
                      <p className="font-medium text-ink-800">{p.label}</p>
                      <p className={p.confidence === "vendor" ? "text-[11px] text-emerald-700" : "text-[11px] text-amber-700"}>{p.confidence === "vendor" ? "vendor list price" : "reported, confirm with vendor"}</p>
                    </div>
                  </div>
                </td>
                <td className="text-right tabular-nums">{money(p.mailboxMonthly, 2)}</td>
                <td className="text-right tabular-nums">{money(perSend, 2)}</td>
                <td className="text-right whitespace-nowrap tabular-nums">
                  {num(r.totalMailboxes)} · {num(r.totalDomains)}
                </td>
                <td className="text-right font-semibold tabular-nums">{money(infra)}</td>
                <td className="text-right tabular-nums">{money(perEmail, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      <p className="border-t border-ink-100 px-5 py-3 text-xs text-ink-500">
        “Per daily send” is the inbox price divided by its daily cap ({policies.caps.google.perMailboxDaily} for Google, {policies.caps.microsoft.perMailboxDaily} for Microsoft): the number that decides which provider is cheaper per email. Anything you pay per inbox, such as a warmup tool, scales with inbox count, and Microsoft needs ~5× more inboxes for the same volume.
      </p>
    </Card>
  );
}

