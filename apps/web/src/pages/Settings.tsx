import type React from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Lock, Play, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { checkOverride, type PolicyDef } from "@cold/core";
import { del, patch, post, put, useAction, useGet } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { Badge, Button, Callout, Card, ConfirmButton, CopyButton, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, RuleTag, Select, TableCard, Tabs, Textarea, Toggle } from "../components/ui";
import { ProviderLogo } from "../components/badges";

type Tab = "general" | "integrations" | "policies" | "team" | "audit" | "system";

export default function SettingsPage() {
  const { tab = "general" } = useParams();
  const navigate = useNavigate();
  const settings = useGet<any>("/settings");
  const role = settings.data?.role ?? "viewer";
  return (
    <div>
      <PageHeader title="Settings" description="Workspace, integrations, guardrail policies and team." />
      <Tabs<Tab>
        value={tab as Tab}
        onChange={(t) => navigate(`/settings/${t}`)}
        tabs={[
          { value: "general", label: "General" },
          { value: "integrations", label: "Integrations" },
          { value: "policies", label: "Guardrails" },
          { value: "team", label: "Team" },
          { value: "audit", label: "Audit log" },
          { value: "system", label: "System" },
        ]}
      />
      {tab === "general" && <General />}
      {tab === "integrations" && <Integrations role={role} />}
      {tab === "policies" && <Policies role={role} />}
      {tab === "team" && <Team role={role} />}
      {tab === "audit" && <Audit />}
      {tab === "system" && <System />}
    </div>
  );
}

// ───────────── General ─────────────
function General() {
  const q = useGet<any>("/settings");
  const [f, setF] = useState<any>(null);
  const [newDomain, setNewDomain] = useState("");
  useEffect(() => {
    if (q.data && !f)
      setF({
        name: q.data.workspace.name,
        timezone: q.data.workspace.timezone,
        postalAddress: q.data.workspace.settings.postalAddress ?? "",
        dmarcRua: q.data.workspace.settings.dmarcRua ?? "",
        warmupPattern: q.data.workspace.settings.warmupPattern ?? "",
      });
  }, [q.data, f]);
  const save = useAction(() => put("/settings", f), { invalidate: ["/settings", "/campaigns"], success: "Settings saved" });
  const addProt = useAction(() => post("/protected-domains", { domain: newDomain }), { invalidate: ["/settings"], success: "Domain protected", onSuccess: () => setNewDomain("") });
  const rmProt = useAction((id: string) => del(`/protected-domains/${id}`), { invalidate: ["/settings"], success: "Removed" });
  const saveCtrl = useAction((m: any) => put(`/control-messages/${m.id}`, { subject: m.subject, body: m.body }), { success: "Control message saved" });
  if (q.isLoading || !f) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Workspace" footer={<div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div>}>
          <div className="space-y-4">
            <Field label="Company name">
              <Input value={f.name} onChange={set("name")} />
            </Field>
            <Field label="Default timezone" hint="New mailboxes send in this timezone. Each prospect still gets emails in their own business hours.">
              <Input value={f.timezone} onChange={set("timezone")} />
            </Field>
            <Field label="Postal address" hint="Required by CAN-SPAM for US campaigns. Appended as one plain line under the signature.">
              <Input value={f.postalAddress} onChange={set("postalAddress")} placeholder="Acme Inc, 100 Main St, Austin, TX 78701" />
            </Field>
            <Field label="DMARC report address (rua)" hint="Optional. Included in generated DMARC records.">
              <Input value={f.dmarcRua} onChange={set("dmarcRua")} placeholder="dmarc@acme.com" />
            </Field>
            <Field label="Warmup email filter (regex)" hint="Optional. Inbound mail matching this is treated as warmup traffic and kept out of the inbox and stats.">
              <Input value={f.warmupPattern} onChange={set("warmupPattern")} placeholder="e.g. \bWUP-[A-Z0-9]{6}\b" className="mono" />
            </Field>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2">Protected primary domains <RuleTag n={1} /></span>} subtitle="Cold never sends cold email from these domains or any subdomain of them.">
          <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
            {q.data.protectedDomains.map((p: any) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <Lock className="size-4 text-emerald-600" />
                <span className="flex-1 text-sm font-medium">{p.domain}</span>
                <span className="text-xs text-ink-500">and *.{p.domain}</span>
                {q.data.protectedDomains.length > 1 && (
                  <button className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-red-600" onClick={() => rmProt.mutate(p.id)} title="Remove">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="anotherbrand.com" />
            <Button icon={<Plus className="size-4" />} disabled={!newDomain} loading={addProt.isPending} onClick={() => addProt.mutate()}>
              Protect
            </Button>
          </div>
        </Card>
      </div>

      <Card title={<span className="flex items-center gap-2">Control copy <RuleTag n={13} /></span>} subtitle="Neutral, non-commercial messages sent to seed inboxes during a diagnosis to separate copy problems from infrastructure problems.">
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.controlMessages.map((m: any) => (
            <ControlMessage key={m.id} m={m} onSave={(x) => saveCtrl.mutate(x)} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function ControlMessage({ m, onSave }: { m: any; onSave: (m: any) => void }) {
  const [v, setV] = useState(m);
  return (
    <div className="space-y-2 rounded-xl border border-ink-200 p-3">
      <Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
      <Textarea value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} className="min-h-28" />
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onSave(v)} disabled={v.subject === m.subject && v.body === m.body}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ───────────── Integrations ─────────────
function Integrations({ role }: { role: string }) {
  const q = useGet<any>("/integrations");
  const [keys, setKeys] = useState({ validationKey: "", cloudflareToken: "", slackWebhookUrl: "", spamhausDqsKey: "" });
  const [tenantModal, setTenantModal] = useState<any | null>(null);
  const save = useAction((body: any) => put("/integrations", body), { invalidate: ["/integrations", "/overview", "/checklist"], success: "Saved", onSuccess: () => setKeys({ validationKey: "", cloudflareToken: "", slackWebhookUrl: "", spamhausDqsKey: "" }) });
  const delTenant = useAction((id: string) => del(`/tenants/${id}`), { invalidate: ["/integrations"], success: "Tenant removed" });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <div className="space-y-6">
      <Card
        title={<span className="flex items-center gap-2">Mail tenants <RuleTag n={2} /></span>}
        subtitle="Google Workspace or Microsoft 365 only. Cold sends through their native APIs, never through third-party SMTP relays."
        actions={
          <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setTenantModal({ provider: "microsoft", vendor: "hypertide", transport: "api", name: "", config: {}, secret: "" })}>
            Add tenant
          </Button>
        }
        padded={false}
      >
        {d.tenants.length === 0 ? (
          <EmptyState title="No tenants connected">Connect the Microsoft 365 or Google Workspace tenant your sending mailboxes live in. Hypertide-provisioned tenants work the same way.</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Provider</th>
                <th>Vendor</th>
                <th>Connection</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.tenants.map((t: any) => (
                <tr key={t.id}>
                  <td className="font-medium">{t.name}</td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <ProviderLogo provider={t.provider} /> {t.provider === "google" ? "Google Workspace" : "Microsoft 365"}
                    </span>
                  </td>
                  <td className="capitalize">{t.vendor}</td>
                  <td>{t.transport === "simulated" ? <Badge tone="violet">Simulated</Badge> : t.hasSecret ? <Badge tone="green">Credentials saved</Badge> : <Badge tone="amber">Missing secret</Badge>}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setTenantModal({ ...t, secret: "" })}>
                      Edit
                    </Button>
                    {role === "owner" && (
                      <ConfirmButton size="sm" variant="ghost" title={`Remove ${t.name}?`} body="Domains attached to it will need a new tenant before they can send." confirmVariant="danger" confirmLabel="Remove" onConfirm={() => delTenant.mutate(t.id)}>
                        Remove
                      </ConfirmButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2">Email validation <RuleTag n={8} /></span>} subtitle="Every address is validated before it can be emailed. Free checks (syntax, MX, gateways, suppression) run first, so you only pay for addresses that could actually be sent.">
          <div className="space-y-4">
            <Field label="Provider">
              <Select value={d.validationProvider} onChange={(e) => save.mutate({ validationProvider: e.target.value })}>
                <option value="none">Not connected</option>
                <option value="millionverifier">MillionVerifier (lowest cost per check)</option>
                <option value="zerobounce">ZeroBounce</option>
              </Select>
            </Field>
            <SecretField label="API key" saved={d.validationKey} value={keys.validationKey} onChange={(v) => setKeys({ ...keys, validationKey: v })} onSave={() => save.mutate({ validationKey: keys.validationKey })} onClear={() => save.mutate({ validationKey: null })} />
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2">DNS <RuleTag n={5} /></span>} subtitle="With a Cloudflare API token (Zone → Zone: Read and Zone → DNS: Edit, all zones), Cold imports your domains and writes SPF, DKIM, DMARC and MX records for you.">
          <SecretField label="Cloudflare API token" saved={d.cloudflare} value={keys.cloudflareToken} onChange={(v) => setKeys({ ...keys, cloudflareToken: v })} onSave={() => save.mutate({ cloudflareToken: keys.cloudflareToken })} onClear={() => save.mutate({ cloudflareToken: null })} />
        </Card>
        <Card title="Slack alerts" subtitle="Critical alerts, rotations and positive replies posted to a channel via an incoming webhook.">
          <SecretField label="Webhook URL" saved={d.slack} value={keys.slackWebhookUrl} onChange={(v) => setKeys({ ...keys, slackWebhookUrl: v })} onSave={() => save.mutate({ slackWebhookUrl: keys.slackWebhookUrl })} onClear={() => save.mutate({ slackWebhookUrl: null })} />
        </Card>
        <Card title="Blocklist monitoring" subtitle="Daily Spamhaus DBL checks of your sending domains through a Spamhaus DQS key (free for low volume).">
          <SecretField label="Spamhaus DQS key" saved={d.spamhaus} value={keys.spamhausDqsKey} onChange={(v) => setKeys({ ...keys, spamhausDqsKey: v })} onSave={() => save.mutate({ spamhausDqsKey: keys.spamhausDqsKey })} onClear={() => save.mutate({ spamhausDqsKey: null })} />
        </Card>
      </div>

      <WarmupCard />

      <Card title="Simulation mode" subtitle="Simulates DNS, MX lookups and validation for this workspace. Use it to try Cold before connecting real tenants.">
        <Toggle checked={d.simulation} disabled={role !== "owner"} onChange={(v) => save.mutate({ simulation: v })} label={d.simulation ? "On: nothing is really validated or sent by simulated tenants" : "Off"} />
      </Card>

      {tenantModal && <TenantModal initial={tenantModal} onClose={() => setTenantModal(null)} />}
    </div>
  );
}

function WarmupCard() {
  const q = useGet<any>("/warmup", { refetchInterval: 60_000 });
  const save = useAction((engine: string) => put("/settings", { warmupEngine: engine }), { invalidate: ["/warmup"], success: "Warmup setting saved" });
  const w = q.data;
  return (
    <Card
      title={<span className="flex items-center gap-2">Warmup <RuleTag n={6} /></span>}
      subtitle="Built in: your inboxes warm each other, so there's no warmup subscription (Instantly, Lemwarm…) to pay for."
    >
      {!w ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { v: "cold", t: "Built-in warmup (recommended)", d: "Inboxes exchange natural emails with inboxes in your other tenants, rescue each other from spam and reply. Placement feeds the Ready gate and early warnings." },
              { v: "external", t: "Another warmup tool", d: "You run warmup elsewhere. Cold only tracks warmup age and blocks sending until 14 days." },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => w.engine !== o.v && save.mutate(o.v)}
                className={clsx("rounded-xl border p-3 text-left transition-colors", w.engine === o.v ? "border-brand-400 bg-brand-50 ring-2 ring-brand-100" : "border-ink-200 hover:bg-ink-50")}
              >
                <p className="text-sm font-medium text-ink-900">{o.t}</p>
                <p className="mt-1 text-xs text-ink-500">{o.d}</p>
              </button>
            ))}
          </div>
          {w.engine === "cold" && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <MiniStat label="Inboxes in pool" value={w.pool.inboxes} />
                <MiniStat label="Tenants" value={w.pool.tenants} />
                <MiniStat label="Warmup emails · 7d" value={w.last7d.sent} />
                <MiniStat label="Reached inbox" value={w.last7d.inboxRate == null ? "–" : `${Math.round(w.last7d.inboxRate * 100)}%`} />
                <MiniStat label="Replies · 7d" value={w.last7d.replies} />
              </div>
              {w.pool.issues.length > 0 && (
                <Callout tone={w.pool.canRun ? "gray" : "amber"} title={w.pool.canRun ? "Ways to strengthen warmup" : "Warmup can't run yet"}>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {w.pool.issues.map((i: string) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </Callout>
              )}
              <p className="text-xs text-ink-500">
                Trade-off: a paid network spreads warmup across thousands of other companies' inboxes. A private pool is free, but its signal comes only from your own tenants, so keep both Google and Microsoft inboxes in it. Volumes and reply rate are under Guardrails → Warmup.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-200 px-3 py-2">
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SecretField({ label, saved, value, onChange, onSave, onClear }: { label: string; saved: boolean; value: string; onChange: (v: string) => void; onSave: () => void; onClear: () => void }) {
  return (
    <Field label={label} hint={saved ? "Saved and encrypted. Enter a new value to replace it." : "Stored encrypted (AES-256-GCM)."}>
      <div className="flex gap-2">
        <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? "••••••••••••" : ""} autoComplete="off" />
        <Button onClick={onSave} disabled={!value}>
          Save
        </Button>
        {saved && (
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    </Field>
  );
}

function TenantModal({ initial, onClose }: { initial: any; onClose: () => void }) {
  const [t, setT] = useState<any>(initial);
  const editing = !!initial.id;
  const saveT = useAction(
    () =>
      editing
        ? put(`/tenants/${t.id}`, { name: t.name, vendor: t.vendor, config: t.config, ...(t.secret ? { secret: t.secret } : {}) })
        : post("/tenants", { name: t.name, provider: t.provider, vendor: t.vendor, transport: t.transport, config: t.config, secret: t.secret || null }),
    { invalidate: ["/integrations", "/domains"], success: editing ? "Tenant updated" : "Tenant added", onSuccess: onClose },
  );
  const cfg = (k: string) => (e: { target: { value: string } }) => setT({ ...t, config: { ...t.config, [k]: e.target.value } });
  const ms = t.provider === "microsoft";
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${initial.name}` : "Add a mail tenant"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saveT.isPending} disabled={!t.name} onClick={() => saveT.mutate()}>
            {editing ? "Save" : "Add tenant"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!editing && (
          <div className="grid grid-cols-2 gap-3">
            {(["microsoft", "google"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setT({ ...t, provider: p })}
                className={clsx("rounded-xl border p-3 text-left transition-colors", t.provider === p ? "border-brand-400 bg-brand-50 ring-2 ring-brand-100" : "border-ink-200 hover:bg-ink-50")}
              >
                <div className="flex items-center gap-2 font-medium">
                  <ProviderLogo provider={p} className="size-4" /> {p === "microsoft" ? "Microsoft 365" : "Google Workspace"}
                </div>
                <p className="mt-1 text-xs text-ink-500">{p === "microsoft" ? "Up to 50 inboxes × 3/day per domain. ~5–6× cheaper." : "3 inboxes × 15/day per domain. Easier to manage."}</p>
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder={ms ? "Hypertide tenant 1" : "Workspace – sending"} />
          </Field>
          <Field label="Vendor">
            <Select value={t.vendor} onChange={(e) => setT({ ...t, vendor: e.target.value })}>
              <option value="hypertide">Hypertide</option>
              <option value="direct">Direct</option>
              <option value="other">Other reseller</option>
            </Select>
          </Field>
        </div>
        {!editing && (
          <Field label="Connection">
            <Select value={t.transport} onChange={(e) => setT({ ...t, transport: e.target.value })}>
              <option value="api">Real API</option>
              <option value="simulated">Simulated (testing)</option>
            </Select>
          </Field>
        )}
        {t.transport === "api" &&
          (ms ? (
            <>
              <Callout tone="gray" title="Microsoft Entra app registration">
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Entra admin center → App registrations → New registration.</li>
                  <li>API permissions → Microsoft Graph → Application: Mail.Send and Mail.ReadWrite → Grant admin consent.</li>
                  <li>Certificates & secrets → New client secret. Copy the value.</li>
                  <li>Recommended: limit the app to the sending mailboxes with an application access policy.</li>
                </ol>
              </Callout>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Directory (tenant) ID">
                  <Input value={t.config.tenantId ?? ""} onChange={cfg("tenantId")} className="mono" />
                </Field>
                <Field label="Application (client) ID">
                  <Input value={t.config.clientId ?? ""} onChange={cfg("clientId")} className="mono" />
                </Field>
              </div>
              <Field label="Client secret" hint={editing ? "Leave blank to keep the saved secret." : undefined}>
                <Input type="password" value={t.secret} onChange={(e) => setT({ ...t, secret: e.target.value })} autoComplete="off" />
              </Field>
            </>
          ) : (
            <>
              <Callout tone="gray" title="Google service account with domain-wide delegation">
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Google Cloud console → enable the Gmail API → create a service account → create a JSON key.</li>
                  <li>
                    Admin console → Security → API controls → Domain-wide delegation → add the service account's client ID with scope <span className="mono">https://www.googleapis.com/auth/gmail.modify</span>{" "}
                    <CopyButton text="https://www.googleapis.com/auth/gmail.modify" />
                  </li>
                </ol>
              </Callout>
              <Field label="Service account JSON key" hint={editing ? "Leave blank to keep the saved key." : "Paste the whole file contents."}>
                <Textarea value={t.secret} onChange={(e) => setT({ ...t, secret: e.target.value })} className="mono min-h-32 text-xs" />
              </Field>
            </>
          ))}
      </div>
    </Modal>
  );
}

// ───────────── Policies ─────────────
const OVERRIDE_LABEL: Record<string, { label: string; tone: "gray" | "amber" | "blue" | "red" }> = {
  hard: { label: "Locked", tone: "red" },
  hard_floor: { label: "Can only go up", tone: "amber" },
  soft: { label: "Owner to loosen", tone: "amber" },
  free: { label: "Adjustable", tone: "gray" },
};

function displayValue(def: PolicyDef, v: any) {
  if (def.type === "percent") return `${Math.round(Number(v) * 1000) / 10}%`;
  if (def.type === "boolean") return v ? "On" : "Off";
  if (def.type === "list") return (v as string[]).join(", ");
  return `${v}${def.unit ? ` ${def.unit}` : ""}`;
}

function getPath(obj: any, path: string) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function Policies({ role }: { role: string }) {
  const q = useGet<any>("/policies");
  const [edit, setEdit] = useState<PolicyDef | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const defs: PolicyDef[] = q.data.defs;
  const groups = [...new Set(defs.map((d) => d.group))];
  return (
    <div className="space-y-6">
      <Callout tone="blue" title="Guardrails encode the playbook">
        Locked rules can't change. Playbook limits can be tightened by any operator; loosening them needs the Owner role and a written reason, and marks the workspace off-playbook.
      </Callout>
      {q.data.offPlaybook.length > 0 && <Callout tone="amber" title={`Off-playbook: ${q.data.offPlaybook.length} limit(s) loosened`}>{q.data.offPlaybook.join(", ")}</Callout>}
      {groups.map((g) => (
        <Card key={g} title={g} padded={false}>
          <table className="tbl">
            <tbody>
              {defs
                .filter((d) => d.group === g)
                .map((d) => {
                  const value = getPath(q.data.effective, d.key);
                  const overridden = d.key in q.data.overrides;
                  const ov = OVERRIDE_LABEL[d.override];
                  return (
                    <tr key={d.key}>
                      <td className="w-[45%]">
                        <p className="font-medium text-ink-800">{d.label}</p>
                        <p className="text-xs text-ink-500">{d.description}</p>
                      </td>
                      <td className="font-semibold whitespace-nowrap tabular-nums">
                        {displayValue(d, value)}
                        {overridden && <span className="ml-2 text-xs font-normal text-ink-400">(default {displayValue(d, d.default)})</span>}
                      </td>
                      <td className="whitespace-nowrap">{d.source === "playbook" && d.rule ? <RuleTag n={d.rule} /> : <Badge tone="gray">{d.source === "proposed" ? "Cold default" : d.source}</Badge>}</td>
                      <td className="whitespace-nowrap">
                        <Badge tone={ov.tone}>{ov.label}</Badge>
                      </td>
                      <td className="text-right">
                        {d.override !== "hard" && role !== "viewer" && role !== "sdr" && (
                          <Button size="sm" variant="ghost" onClick={() => setEdit(d)}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Card>
      ))}
      {edit && <PolicyModal def={edit} current={getPath(q.data.effective, edit.key)} overridden={edit.key in q.data.overrides} role={role} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PolicyModal({ def, current, overridden, role, onClose }: { def: PolicyDef; current: any; overridden: boolean; role: string; onClose: () => void }) {
  const [value, setValue] = useState<any>(def.type === "percent" ? Math.round(current * 1000) / 10 : current);
  const [reason, setReason] = useState("");
  const actual = def.type === "percent" ? Number(value) / 100 : def.type === "number" ? Number(value) : value;
  const check = checkOverride(def.key, actual, role as any);
  const save = useAction(() => put(`/policies/${encodeURIComponent(def.key)}`, { value: actual, reason: reason || undefined }), { invalidate: ["/policies", "/overview"], success: "Guardrail updated", onSuccess: onClose });
  const reset = useAction(() => put(`/policies/${encodeURIComponent(def.key)}`, { reset: true }), { invalidate: ["/policies"], success: "Reset to default", onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={def.label}
      description={def.description}
      footer={
        <>
          {overridden && (
            <Button variant="ghost" onClick={() => reset.mutate()} loading={reset.isPending}>
              Reset to default
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!check.ok || (check.requiresReason && reason.trim().length < 3)} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {(def.type === "number" || def.type === "percent") && (
          <Field label={`Value${def.type === "percent" ? " (%)" : def.unit ? ` (${def.unit})` : ""}`} hint={`Default ${displayValue(def, def.default)}`}>
            <Input type="number" value={value} step="any" onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
        {def.type === "boolean" && <Toggle checked={!!value} onChange={setValue} label={value ? "On" : "Off"} />}
        {def.type === "enum" && (
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            {def.options?.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        )}
        {def.type === "list" && (
          <div className="grid grid-cols-2 gap-2">
            {def.options?.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm capitalize">
                <input type="checkbox" checked={(value as string[]).includes(o)} onChange={(e) => setValue(e.target.checked ? [...value, o] : (value as string[]).filter((x) => x !== o))} />
                {o}
              </label>
            ))}
          </div>
        )}
        {!check.ok && <Callout tone="red">{check.error}</Callout>}
        {check.ok && check.loosens && <Callout tone="amber" title="This loosens a playbook limit">It's allowed for Owners, recorded in the audit log, and flags the workspace as off-playbook.</Callout>}
        {check.requiresReason && (
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ───────────── Team ─────────────
function Team({ role }: { role: string }) {
  const q = useGet<any[]>("/team");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: "", name: "", role: "sdr" });
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const add = useAction(() => post<any>("/team", f), {
    invalidate: ["/team"],
    onSuccess: (r) => {
      setOpen(false);
      if (r.tempPassword) setTemp({ email: r.user.email, password: r.tempPassword });
    },
    success: "Member added",
  });
  const setRole = useAction((x: { id: string; role: string }) => put(`/team/${x.id}`, { role: x.role }), { invalidate: ["/team"], success: "Role updated" });
  const remove = useAction((id: string) => del(`/team/${id}`), { invalidate: ["/team"], success: "Removed" });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="space-y-6">
      {temp && (
        <Callout tone="green" title={`Temporary password for ${temp.email}`} action={<CopyButton text={temp.password} />}>
          <span className="mono">{temp.password}</span>. Share it securely. It's shown only once; they should change it after signing in.
        </Callout>
      )}
      <Card
        title="Team"
        subtitle="Owners manage billing and guardrails, Operators run infrastructure and rotations, SDRs work lists, copy and the inbox, Viewers read."
        padded={false}
        actions={role === "owner" && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Add member</Button>}
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.map((m) => (
              <tr key={m.id}>
                <td className="font-medium">{m.name}</td>
                <td className="text-ink-600">{m.email}</td>
                <td>
                  {role === "owner" ? (
                    <Select value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value })} className="w-32 py-1">
                      {["owner", "operator", "sdr", "viewer"].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="capitalize">{m.role}</span>
                  )}
                </td>
                <td className="text-ink-500">{ago(m.since)}</td>
                <td className="text-right">
                  {role === "owner" && (
                    <ConfirmButton size="sm" variant="ghost" title={`Remove ${m.email}?`} confirmVariant="danger" confirmLabel="Remove" onConfirm={() => remove.mutate(m.id)}>
                      Remove
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a team member" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!f.email} onClick={() => add.mutate()}>Add</Button></>}>
        <div className="space-y-4">
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="operator">Operator</option>
              <option value="sdr">SDR</option>
              <option value="viewer">Viewer</option>
              <option value="owner">Owner</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

// ───────────── Audit ─────────────
function Audit() {
  const q = useGet<any[]>("/audit?limit=300");
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <TableCard>
      <table className="tbl">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {q.data!.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap text-ink-500">{dateTime(e.createdAt)}</td>
              <td className="whitespace-nowrap">{e.actorLabel}</td>
              <td>
                <span className="mono text-xs">{e.action}</span>
              </td>
              <td className="max-w-xl text-xs text-ink-600">
                {e.reason && <p className="font-medium text-ink-800">“{e.reason}”</p>}
                <p className="truncate">{Object.entries(e.detail ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

// ───────────── System ─────────────
function System() {
  const q = useGet<any[]>("/system/jobs", { refetchInterval: 10_000 });
  const run = useAction((name: string) => post(`/system/jobs/${name}/run`), { invalidate: ["/system", "/domains", "/health", "/threads", "/sends"], success: "Job finished" });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card title="Background jobs" subtitle="Cold runs these on a schedule in a single instance. You can trigger one now." padded={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Job</th>
            <th>Every</th>
            <th>Last run</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data!.map((j) => (
            <tr key={j.name}>
              <td>
                <p className="font-medium">{j.label}</p>
                <p className="mono text-xs text-ink-400">{j.name}</p>
              </td>
              <td className="text-ink-600">{j.everyMs >= 3_600_000 ? `${j.everyMs / 3_600_000}h` : j.everyMs >= 60_000 ? `${j.everyMs / 60_000}m` : `${j.everyMs / 1000}s`}</td>
              <td className="text-ink-500">{ago(j.lastRunAt)}</td>
              <td>{j.running ? <Badge tone="blue">Running</Badge> : j.lastStatus === "error" ? <Badge tone="red" title={j.lastError}>Error</Badge> : j.lastStatus ? <Badge tone="green">OK · {j.lastDurationMs}ms</Badge> : <Badge>Not run</Badge>}</td>
              <td className="text-right">
                <Button size="sm" icon={<Play className="size-3.5" />} loading={run.isPending && run.variables === j.name} onClick={() => run.mutate(j.name)}>
                  Run now
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export { patch };
