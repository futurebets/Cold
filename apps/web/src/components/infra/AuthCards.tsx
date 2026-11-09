import { useState } from "react";
import clsx from "clsx";
import { Cloud, Pencil, RefreshCw, Send } from "lucide-react";
import type { DnsRecord, HeaderTestAnalysis } from "@cold/core";
import { patch, post, useAction } from "../../lib/api";
import { ago, dateTime } from "../../lib/format";
import { Badge, Button, Callout, Card, Check, CopyButton, Field, Input, Modal, RuleTag, Textarea } from "../ui";
import type { DomainDetail } from "./types";

type DnsKey = "googleDkimValue" | "msDkimSelector1" | "msDkimSelector2" | "msMxHost";

function keyFor(r: DnsRecord, provider: string): DnsKey | null {
  if (r.host === "google._domainkey") return "googleDkimValue";
  if (r.host === "selector1._domainkey") return "msDkimSelector1";
  if (r.host === "selector2._domainkey") return "msDkimSelector2";
  if (r.purpose === "mx" && provider === "microsoft") return "msMxHost";
  return null;
}

const KEY_LABEL: Record<DnsKey, string> = {
  googleDkimValue: "DKIM TXT value from Google Admin",
  msDkimSelector1: "selector1 CNAME target from Microsoft",
  msDkimSelector2: "selector2 CNAME target from Microsoft",
  msMxHost: "MX host from the Microsoft 365 admin center",
};

export function DnsCard({ detail, cloudflare }: { detail: DomainDetail; cloudflare: boolean }) {
  const d = detail.domain;
  const inv = ["/domains", "/reserve"];
  const [editing, setEditing] = useState<{ key: DnsKey; value: string } | null>(null);
  const [pushResult, setPushResult] = useState<{ applied: string[]; skipped: string[]; warnings: string[] } | null>(null);
  const check = useAction(() => post<{ pass: boolean }>(`/domains/${d.id}/check-dns`), {
    invalidate: inv,
    success: (r) => (r.pass ? "SPF, DKIM and DMARC all pass" : "Some records still need work"),
  });
  const push = useAction(() => post<{ applied: string[]; skipped: string[]; warnings: string[] }>(`/domains/${d.id}/push-dns`), {
    invalidate: inv,
    success: (r) => `Cloudflare: ${r.applied.length} record(s) written`,
    onSuccess: setPushResult,
  });
  const save = useAction((v: { key: DnsKey; value: string }) => patch(`/domains/${d.id}`, { dnsValues: { [v.key]: v.value.trim() } }), {
    invalidate: inv,
    success: "Saved. The record value is updated below.",
    onSuccess: () => setEditing(null),
  });
  const items = d.lastDnsResult?.items ?? [];

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          DNS records <RuleTag n={5} />
        </span>
      }
      subtitle={d.lastDnsCheckAt ? `Last checked ${ago(d.lastDnsCheckAt)} · re-checked automatically, sending stops if a check fails` : "Publish these records at your DNS host, then check."}
      actions={
        <>
          {cloudflare && (
            <Button size="sm" icon={<Cloud className="size-4" />} loading={push.isPending} onClick={() => push.mutate()}>
              Write to Cloudflare
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-4" />} loading={check.isPending} onClick={() => check.mutate()}>
            Check DNS now
          </Button>
        </>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Type</th>
              <th>Host</th>
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.expected.map((r) => {
              const key = keyFor(r, d.provider);
              const verified = items.find((i) => i.id === r.purpose)?.pass ?? false;
              const placeholder = r.needsProviderValue && !verified;
              return (
                <tr key={`${r.type}-${r.host}-${r.purpose}`}>
                  <td className="align-top">
                    <Badge tone="gray">{r.type}</Badge>
                    <p className="mt-1 text-xs text-ink-400 uppercase">{r.purpose}</p>
                  </td>
                  <td className="align-top">
                    <div className="flex items-center gap-1">
                      <span className="mono text-[13px]">{r.host}</span>
                      <CopyButton text={r.host} />
                    </div>
                  </td>
                  <td className="max-w-[420px] align-top">
                    {r.needsProviderValue && verified && r.value.startsWith("<") ? (
                      <p className="text-[12.5px] text-emerald-700">Published and verified in DNS</p>
                    ) : (
                      <p className={clsx("mono text-[12.5px] break-all", placeholder ? "text-amber-700" : "text-ink-800")}>
                        {r.priority !== undefined && <span className="text-ink-400">{r.priority} </span>}
                        {r.value}
                      </p>
                    )}
                    {r.note && !verified && <p className="mt-1 text-xs text-ink-500">{r.note}</p>}
                  </td>
                  <td className="align-top whitespace-nowrap">
                    {verified && <Badge tone="green">Verified</Badge>}
                    {!placeholder && !r.value.startsWith("<") && <CopyButton text={r.value} />}
                    {key && (
                      <button
                        className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-brand-600 hover:bg-brand-50"
                        onClick={() => setEditing({ key, value: d.dnsValues[key] ?? "" })}
                      >
                        <Pencil className="size-3" />
                        {placeholder ? "Paste value" : "Edit"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border-t border-ink-100 p-5">
        {items.length === 0 ? (
          <p className="text-sm text-ink-500">Not checked yet. Publish the records above, then click "Check DNS now". Changes can take a few minutes to propagate.</p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {items.map((i) => (
              <Check key={i.id} ok={i.pass}>
                <span className="font-medium">{i.label}</span>
                <span className="block text-xs text-ink-500">{i.detail}</span>
              </Check>
            ))}
          </div>
        )}
        {pushResult && (
          <Callout tone={pushResult.warnings.length ? "amber" : "green"} title="Cloudflare">
            {pushResult.applied.length > 0 && <p>Written: {pushResult.applied.join(", ")}</p>}
            {pushResult.skipped.length > 0 && <p>Skipped: {pushResult.skipped.join("; ")}</p>}
            {pushResult.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </Callout>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? KEY_LABEL[editing.key] : ""}
        description="Copy it exactly from your provider's admin console."
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" disabled={!editing?.value.trim()} loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <Field label="Value">
            <Textarea value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} className="mono min-h-28 text-[12.5px]" autoFocus />
          </Field>
        )}
      </Modal>
    </Card>
  );
}

function ResultChip({ label, value }: { label: string; value: string }) {
  const ok = value === "pass";
  return (
    <div className={clsx("rounded-lg border px-3 py-2", ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50")}>
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className={clsx("mono text-sm font-semibold", ok ? "text-emerald-700" : "text-red-700")}>{value}</p>
    </div>
  );
}

export function HeaderTestCard({ detail }: { detail: DomainDetail }) {
  const d = detail.domain;
  const [raw, setRaw] = useState("");
  const [analysis, setAnalysis] = useState<HeaderTestAnalysis | null>(null);
  const analyze = useAction(() => post<HeaderTestAnalysis>(`/domains/${d.id}/header-test`, { raw }), {
    invalidate: ["/domains"],
    success: (r) => (r.pass ? "Header test passed" : "Header test failed. See the issues below."),
    onSuccess: setAnalysis,
  });
  const auto = useAction(() => post<{ queued: number }>(`/domains/${d.id}/header-test/auto`), {
    invalidate: ["/domains"],
    success: (r) => `Sent ${r.queued} test email(s) to your seed inboxes. Results appear here within a few minutes.`,
  });
  const sender = detail.mailboxes.find((m) => m.state !== "decommissioned")?.address;
  const passed = !!d.headerTestPassedAt;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Header test <RuleTag n={5} />
        </span>
      }
      subtitle={passed ? `Passed ${ago(d.headerTestPassedAt)}` : "Send yourself a test email and inspect the headers."}
      actions={
        <Button size="sm" icon={<Send className="size-4" />} loading={auto.isPending} onClick={() => auto.mutate()} disabled={detail.mailboxes.length === 0}>
          Automatic test via seed inbox
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-600">
          <li>
            From {sender ? <span className="mono text-ink-800">{sender}</span> : "one of this domain's mailboxes"}, send a short email to a personal Gmail or Outlook address.
          </li>
          <li>
            Open it. In Gmail use <b>⋮ → Show original</b>. In Outlook use <b>… → View → View message source</b>.
          </li>
          <li>Copy everything and paste it here. Cold checks that SPF, DKIM (signed by this domain) and DMARC all pass.</li>
        </ol>
        <div className="space-y-3">
          <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the full original message or headers…" className="mono min-h-32 text-[12px]" />
          <Button variant="primary" disabled={!raw.trim()} loading={analyze.isPending} onClick={() => analyze.mutate()}>
            Analyze headers
          </Button>
        </div>
      </div>

      {analysis && (
        <div className="mt-5 space-y-3 rounded-xl border border-ink-200 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {analysis.pass ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>}
            {analysis.receiver && <span className="text-xs text-ink-500">Checked by {analysis.receiver}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ResultChip label="SPF" value={analysis.spf} />
            <ResultChip label="DKIM" value={analysis.dkim} />
            <ResultChip label="DKIM aligned" value={analysis.dkimAligned ? "pass" : "no"} />
            <ResultChip label="DMARC" value={analysis.dmarc} />
          </div>
          {analysis.issues.length > 0 && (
            <ul className="space-y-1 text-sm text-red-700">
              {analysis.issues.map((i) => (
                <li key={i}>• {i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {detail.headerTests.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-500 uppercase">History</p>
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200">
            {detail.headerTests.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                {t.pass ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>}
                <span className="mono text-xs text-ink-600">
                  spf={t.spf} dkim={t.dkim}
                  {t.dkimDomain ? ` (d=${t.dkimDomain})` : ""} dmarc={t.dmarc}
                </span>
                <span className="ml-auto text-xs text-ink-400">
                  {t.source === "seed" ? "Seed inbox · " : ""}
                  {dateTime(t.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function WarmupCard({ detail }: { detail: DomainDetail }) {
  const d = detail.domain;
  const [already, setAlready] = useState(false);
  const [since, setSince] = useState("");
  const start = useAction(() => post(`/domains/${d.id}/start-warmup`, { since: already && since ? new Date(since).toISOString() : null }), {
    invalidate: ["/domains", "/reserve"],
    success: "Warmup tracking started",
  });
  const live = detail.mailboxes.filter((m) => m.state !== "decommissioned");
  const min = live[0]?.warmup.min ?? 14;
  const target = live[0]?.warmup.target ?? 30;
  const days = live.length ? Math.min(...live.map((m) => m.warmup.days)) : 0;
  const started = live.some((m) => m.warmupStartedAt);
  const canStart = d.state === "auth_verified";

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Warmup <RuleTag n={6} />
        </span>
      }
      subtitle="Never start sending immediately. At least 14 days, a month is better."
    >
      {!started ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Turn on warmup in your warmup tool (or Hypertide) for every mailbox on this domain, then start tracking here. Cold won't let these inboxes send cold email until they reach {min} days.
          </p>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={already} onChange={(e) => setAlready(e.target.checked)} className="size-4 rounded border-ink-300" />
            Warmup is already running in another tool
          </label>
          {already && (
            <Field label="Running since" hint="You're attesting to this date. It's recorded in the audit log.">
              <Input type="date" value={since} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setSince(e.target.value)} className="sm:w-56" />
            </Field>
          )}
          {!canStart && (
            <Callout tone="amber">
              {d.state === "pending_dns" ? "Pass the DNS check and the header test first. Warming an unauthenticated domain wastes the warmup." : `This domain is ${d.state.replace("_", " ")}.`}
            </Callout>
          )}
          {detail.gates.warming.blockers.length > 0 && canStart && (
            <ul className="space-y-1 text-sm text-amber-700">
              {detail.gates.warming.blockers.map((b) => (
                <li key={b.code}>• {b.message}</li>
              ))}
            </ul>
          )}
          <Button variant="primary" disabled={!canStart || (already && !since) || live.length === 0} loading={start.isPending} onClick={() => start.mutate()}>
            {live.length === 0 ? "Add mailboxes first" : "Start warmup tracking"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-2xl font-semibold text-ink-900 tabular-nums">{days} days</p>
              <p className="text-sm text-ink-500">{days >= target ? "Fully warmed" : days >= min ? `Minimum reached · ${target - days} more days to the recommended ${target}` : `${min - days} days until it can send`}</p>
            </div>
          </div>
          <div className="relative h-2.5 rounded-full bg-ink-100">
            <div className={clsx("absolute inset-y-0 left-0 rounded-full", days >= min ? "bg-emerald-500" : "bg-violet-500")} style={{ width: `${Math.min(100, (days / target) * 100)}%` }} />
            <div className="absolute inset-y-[-3px] w-0.5 bg-ink-500" style={{ left: `${(min / target) * 100}%` }} title={`${min}-day minimum`} />
          </div>
          <div className="relative h-4 text-xs text-ink-500">
            <span className="absolute left-0">Day 0</span>
            {min < target * 0.8 && (
              <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(min / target) * 100}%` }}>
                {min}d minimum
              </span>
            )}
            <span className="absolute right-0 whitespace-nowrap">{target}d recommended</span>
          </div>
        </div>
      )}
    </Card>
  );
}
