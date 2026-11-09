import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import { CheckCircle2, Sparkles, XCircle } from "lucide-react";
import { DEFAULT_POLICIES, domainDailyCap, maxMailboxesPerDomain } from "@cold/core";
import { post, useAction, useGet } from "../../lib/api";
import { num, plural } from "../../lib/format";
import { Badge, Button, Callout, Field, Input, Modal, RuleTag, Select, Spinner, Textarea } from "../ui";
import { ProviderLogo } from "../badges";
import type { Integrations, PoliciesResponse } from "./types";

type Provider = "google" | "microsoft";
type Step = 1 | 2 | 3 | 4;

interface Suggestion {
  name: string;
  score: number;
  pattern: string;
  availability: "available" | "taken" | "unknown";
}

interface AddResult {
  created: { id: string; name: string }[];
  errors: { name: string; error: string }[];
}

export function parseNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((s) =>
          s
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .replace(/\/.*$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

export function parsePersonas(text: string): { firstName: string; lastName?: string; localPart?: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [first, ...rest] = l.split(/\s+/);
      const last = rest.join(" ");
      const clean = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
      return { firstName: first, lastName: last || undefined, localPart: last ? `${clean(first)}.${clean(last)}` : clean(first) };
    });
}

export function AddDomainsWizard({ open, onClose, defaultPool = "active" }: { open: boolean; onClose: () => void; defaultPool?: "active" | "reserve" }) {
  const integrations = useGet<Integrations>(open ? "/integrations" : null);
  const policiesQ = useGet<PoliciesResponse>(open ? "/policies" : null);
  const policies = policiesQ.data?.effective ?? DEFAULT_POLICIES;

  const [step, setStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider>("microsoft");
  const [tenantId, setTenantId] = useState<string>("");
  const [vendor, setVendor] = useState<"hypertide" | "direct" | "other">("hypertide");
  const [pool, setPool] = useState<"active" | "reserve">(defaultPool);
  const [namesText, setNamesText] = useState("");
  const [personasText, setPersonasText] = useState("");
  const [brand, setBrand] = useState("");
  const [suggestKey, setSuggestKey] = useState<string | null>(null);
  const [result, setResult] = useState<AddResult | null>(null);

  const suggestions = useGet<Suggestion[]>(suggestKey);
  const [zonesKey, setZonesKey] = useState<string | null>(null);
  const zones = useGet<{ id: string; name: string; status: string; inCold: boolean; protected: boolean }[]>(zonesKey, { retry: false });
  const importable = (zones.data ?? []).filter((z) => !z.inCold && !z.protected);
  const tenants = (integrations.data?.tenants ?? []).filter((t) => t.provider === provider);
  useEffect(() => {
    if (!tenantId && tenants.length > 0) setTenantId(tenants[0].id);
    // Only when the provider or the tenant list changes, so "Attach later" stays selectable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, integrations.data]);
  const names = parseNames(namesText);
  const personas = parsePersonas(personasText);
  const maxBoxes = maxMailboxesPerDomain(provider, policies);
  const perDomain = domainDailyCap(provider, Math.min(personas.length, maxBoxes), policies);
  const dupLocal = useMemo(() => {
    const seen = new Set<string>();
    const d = new Set<string>();
    for (const p of personas) {
      const k = p.localPart ?? p.firstName.toLowerCase();
      if (seen.has(k)) d.add(k);
      seen.add(k);
    }
    return [...d];
  }, [personas]);

  const reset = () => {
    setStep(1);
    setNamesText("");
    setPersonasText("");
    setResult(null);
    setSuggestKey(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = useAction(
    () =>
      post<AddResult>("/domains", {
        names,
        provider,
        tenantId: tenantId || null,
        pool,
        vendor,
        mailboxes: personas.length ? personas : undefined,
      }),
    {
      invalidate: ["/domains", "/reserve", "/mailboxes"],
      success: (r) => (r.created.length ? `Added ${plural(r.created.length, "domain")}` : null),
      onSuccess: (r) => {
        setResult(r);
        setStep(4);
      },
    },
  );

  const toggleName = (n: string) => {
    if (names.includes(n)) setNamesText(names.filter((x) => x !== n).join("\n"));
    else setNamesText([...names, n].join("\n"));
  };

  const canNext = step === 1 ? true : step === 2 ? names.length > 0 : personas.length <= maxBoxes && dupLocal.length === 0;

  const footer =
    step === 4 ? (
      <>
        <div className="flex-1" />
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </>
    ) : (
      <>
        {step > 1 && <Button onClick={() => setStep((step - 1) as Step)}>Back</Button>}
        <div className="flex-1" />
        {step < 3 ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep((step + 1) as Step)}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" disabled={!canNext || names.length === 0} loading={submit.isPending} onClick={() => submit.mutate()}>
            Add {plural(names.length, "domain")}
          </Button>
        )}
      </>
    );

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Add sending domains"
      description={step < 4 ? `Step ${step} of 3 · ${["Provider & set", "Domain names", "Mailboxes"][step - 1]}` : "Result"}
      footer={<div className="flex w-full items-center gap-2">{footer}</div>}
    >
      {step < 4 && (
        <div className="mb-5 flex gap-1.5">
          {[1, 2, 3].map((s) => (
            <div key={s} className={clsx("h-1 flex-1 rounded-full", s <= step ? "bg-brand-500" : "bg-ink-100")} />
          ))}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="label mb-0">Mailbox provider</span>
              <RuleTag n={2} />
              <RuleTag n={3} />
              <RuleTag n={4} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["microsoft", "google"] as Provider[]).map((p) => {
                const boxes = maxMailboxesPerDomain(p, policies);
                const perBox = p === "google" ? policies.caps.google.perMailboxDaily : policies.caps.microsoft.perMailboxDaily;
                const cap = domainDailyCap(p, boxes, policies);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setProvider(p);
                      setTenantId("");
                      setVendor(p === "microsoft" ? "hypertide" : "direct");
                    }}
                    className={clsx(
                      "rounded-xl border p-4 text-left transition-colors",
                      provider === p ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:border-ink-300 hover:bg-ink-50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <ProviderLogo provider={p} className="size-4" />
                      <span className="font-medium text-ink-900">{p === "google" ? "Google Workspace" : "Microsoft 365"}</span>
                    </div>
                    <p className="mt-2 text-sm text-ink-600">
                      {p === "google" ? `${boxes}` : `Up to ${boxes}`} inboxes × {perBox}/day = <span className="font-semibold text-ink-900">{cap}/day</span> per domain
                    </p>
                    <p className="mt-1 text-xs text-ink-500">{p === "google" ? "Easier to manage." : "About 5–6× cheaper per send."}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tenant" hint={tenants.length ? "Mailboxes on these domains send through this tenant." : undefined}>
              {integrations.isLoading ? (
                <Spinner />
              ) : (
                <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                  <option value="">Attach later</option>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.transport === "simulated" && !/simulated/i.test(t.name) ? " (simulated)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Bought through">
              <Select value={vendor} onChange={(e) => setVendor(e.target.value as typeof vendor)}>
                <option value="hypertide">Hypertide</option>
                <option value="direct">Directly from {provider === "google" ? "Google" : "Microsoft"}</option>
                <option value="other">Another reseller</option>
              </Select>
            </Field>
          </div>
          {!integrations.isLoading && tenants.length === 0 && (
            <Callout tone="amber" title={`No ${provider === "google" ? "Google Workspace" : "Microsoft 365"} tenant connected yet`}>
              You can add domains now and attach a tenant later. Mailboxes can't connect or send until you do.{" "}
              <Link to="/settings/integrations" className="font-medium text-brand-700 underline">
                Connect a tenant
              </Link>
            </Callout>
          )}

          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="label mb-0">Which set?</span>
              <RuleTag n={7} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { v: "active" as const, title: "Active set", body: "Starts sending automatically once warmup reaches the minimum." },
                { v: "reserve" as const, title: "Reserve set", body: "Warms quietly and stands by to replace a burned domain without a sending gap." },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setPool(o.v)}
                  className={clsx("rounded-xl border p-4 text-left transition-colors", pool === o.v ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:bg-ink-50")}
                >
                  <p className="font-medium text-ink-900">{o.title}</p>
                  <p className="mt-1 text-sm text-ink-500">{o.body}</p>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-500">Keep one set sending and one warming. Aim for reserve capacity equal to active capacity.</p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <Callout tone="blue" title="Use separate domains that resemble your brand" action={<RuleTag n={1} />}>
            Buy them at your registrar first (prefer .com), then list them here. Cold refuses your primary domain and its subdomains.
          </Callout>
          <div className="rounded-xl border border-ink-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink-800">Already on Cloudflare?</p>
                <p className="text-xs text-ink-500">Pick domains from your Cloudflare account. Cold writes their DNS records for you later.</p>
              </div>
              <Button onClick={() => setZonesKey(`/cloudflare/zones?t=${Date.now()}`)} loading={zones.isFetching}>
                Load my Cloudflare domains
              </Button>
            </div>
            {zones.error && (
              <p className="mt-3 text-sm text-red-600">
                {(zones.error as Error).message}{" "}
                <Link to="/settings/integrations" className="underline">
                  Open integrations
                </Link>
              </p>
            )}
            {zones.data && (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {zones.data.map((z) => {
                    const picked = names.includes(z.name);
                    const disabled = z.inCold || z.protected;
                    return (
                      <button
                        key={z.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleName(z.name)}
                        title={z.protected ? "Protected primary domain: never used for cold email" : z.inCold ? "Already in Cold" : z.status}
                        className={clsx(
                          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition-colors",
                          picked ? "border-brand-400 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                          disabled && "cursor-not-allowed opacity-50 hover:bg-white",
                        )}
                      >
                        <span className="mono text-[13px]">{z.name}</span>
                        {z.protected && <Badge tone="green">protected</Badge>}
                        {z.inCold && <Badge>added</Badge>}
                      </button>
                    );
                  })}
                </div>
                {importable.length > 0 && (
                  <button type="button" className="mt-3 text-xs font-medium text-brand-600 hover:text-brand-700" onClick={() => setNamesText([...new Set([...names, ...importable.map((z) => z.name)])].join("\n"))}>
                    Select all {importable.length} importable
                  </button>
                )}
                {zones.data.length === 0 && <p className="mt-3 text-sm text-ink-500">No zones found for this token.</p>}
              </>
            )}
          </div>
          <Field label="Domains" hint={`${plural(names.length, "domain")}. One per line, or separated by commas.`}>
            <Textarea value={namesText} onChange={(e) => setNamesText(e.target.value)} placeholder={"getacme.com\ntryacme.com"} className="mono min-h-32 text-[13px]" autoFocus />
          </Field>
          <div className="rounded-xl border border-ink-200 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Need ideas?" hint="Lookalikes of your primary domain, checked for availability (free RDAP lookup)." className="min-w-0 flex-1">
                <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Brand word (optional)" />
              </Field>
              <Button icon={<Sparkles className="size-4" />} onClick={() => setSuggestKey(`/domain-suggestions?brand=${encodeURIComponent(brand)}&check=true`)} loading={suggestions.isFetching}>
                Suggest names
              </Button>
            </div>
            {suggestions.error && <p className="mt-3 text-sm text-red-600">{(suggestions.error as Error).message}</p>}
            {suggestions.data && (
              <div className="mt-4 flex flex-wrap gap-2">
                {suggestions.data.map((s) => {
                  const picked = names.includes(s.name);
                  return (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => toggleName(s.name)}
                      title={s.pattern}
                      className={clsx(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition-colors",
                        picked ? "border-brand-400 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                        s.availability === "taken" && !picked && "opacity-60",
                      )}
                    >
                      <span className="mono text-[13px]">{s.name}</span>
                      {s.availability === "available" && <span className="size-1.5 rounded-full bg-emerald-500" title="Available" />}
                      {s.availability === "taken" && <span className="size-1.5 rounded-full bg-red-400" title="Registered" />}
                    </button>
                  );
                })}
              </div>
            )}
            {suggestions.data && (
              <p className="mt-3 text-xs text-ink-500">
                <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500" /> available <span className="mr-1 ml-3 inline-block size-1.5 rounded-full bg-red-400" /> registered. No dot means availability is unknown. Click a name to add it.
              </p>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <Field
            label={
              <span className="flex items-center gap-2">
                Mailboxes on each domain <RuleTag n={4} />
              </span>
            }
            hint={`One person per line: "First Last". Up to ${maxBoxes} per ${provider === "google" ? "Google" : "Microsoft"} domain. Use real, accountable people at your company. You can also add mailboxes later.`}
            error={personas.length > maxBoxes ? `That's ${personas.length}. ${provider === "google" ? "Google" : "Microsoft"} domains hold at most ${maxBoxes}.` : dupLocal.length ? `Duplicate address: ${dupLocal.join(", ")}` : undefined}
          >
            <Textarea value={personasText} onChange={(e) => setPersonasText(e.target.value)} placeholder={"Jane Doe\nSam Lee\nAlex Kim"} className="min-h-36" autoFocus />
          </Field>
          {personas.length > 0 && (
            <div className="rounded-xl bg-ink-50 p-4 text-sm">
              <p className="text-ink-600">
                Each domain gets addresses like <span className="mono text-ink-800">{personas[0].localPart}@{names[0] ?? "yourdomain.com"}</span>.
              </p>
              <p className="mt-2 text-ink-600">
                Capacity: <span className="font-semibold text-ink-900">{num(perDomain)}/day</span> per domain ×{" "}
                {plural(names.length, "domain")} = <span className="font-semibold text-ink-900">{num(perDomain * names.length)} emails/day</span> once warm.
              </p>
            </div>
          )}
          <Callout tone="gray" title="What happens next">
            Each domain starts in <b>Needs DNS</b>. Cold shows the exact SPF, DKIM and DMARC records, verifies them, asks for a header test, then tracks warmup.{" "}
            {pool === "active" ? "It starts sending on its own after the warmup minimum." : "It stays in reserve until a rotation needs it."}
          </Callout>
        </div>
      )}

      {step === 4 && result && (
        <div className="space-y-4">
          {result.created.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-ink-800">Added</p>
              <ul className="space-y-1.5">
                {result.created.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    <Link to={`/domains/${d.id}`} className="mono text-brand-700 hover:underline">
                      {d.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.errors.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-ink-800">Not added</p>
              <ul className="space-y-2">
                {result.errors.map((e) => (
                  <li key={e.name} className="flex items-start gap-2 text-sm">
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
                    <span>
                      <span className="mono text-ink-800">{e.name}</span>
                      <span className="text-ink-500"> · {e.error}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.created.length > 0 && (
            <Callout tone="blue" title="Next: authenticate">
              Open each domain to publish its DNS records and run the header test. <Badge tone="blue">Rule 5</Badge>
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}
