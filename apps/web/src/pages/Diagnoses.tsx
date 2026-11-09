import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import clsx from "clsx";
import { FlaskConical, Play, ShieldCheck, ShieldX } from "lucide-react";
import { post, useAction, useGet } from "../lib/api";
import { ago, dateTime, num, pct } from "../lib/format";
import { Badge, Button, Callout, Card, Check, ConfirmButton, EmptyState, ErrorState, Field, Loading, PageHeader, Progress, Select, TableCard, Toggle } from "../components/ui";
import { DiagnosisVerdictBadge, DomainStateBadge, DIAG_VERDICT } from "../components/badges";

const TRIGGER: Record<string, string> = { red: "Red health verdict", amber: "Drifting from baseline", breaker: "Spam-block circuit breaker", blocklist: "Blocklist hit", manual: "Opened manually" };

function DecisionTable({ control, campaign, verdict }: { control?: boolean | null; campaign?: boolean | null; verdict?: string | null }) {
  const cells = [
    { c: true, k: false, v: "COPY", label: "Rewrite the copy", sub: "Infrastructure is fine" },
    { c: false, k: false, v: "INFRA", label: "Replace the infrastructure", sub: "Rotate in a warmed domain" },
    { c: true, k: true, v: "LIST/OFFER", label: "Placement is fine", sub: "Fix the list or the offer" },
    { c: false, k: true, v: "INCONCLUSIVE", label: "Re-test", sub: "Usually noise" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {cells.map((x) => {
        const hit = control === x.c && campaign === x.k;
        return (
          <div key={x.v} className={clsx("rounded-xl border p-3 transition-colors", hit ? "border-brand-400 bg-brand-50 ring-2 ring-brand-200" : "border-ink-200 bg-white")}>
            <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
              <span className={clsx("rounded px-1.5 py-0.5", x.c ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>Control {x.c ? "passes" : "fails"}</span>
              <span className={clsx("rounded px-1.5 py-0.5", x.k ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>Campaign {x.k ? "passes" : "fails"}</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-ink-900">{x.label}</p>
            <p className="text-xs text-ink-500">{x.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

export function DiagnosesPage() {
  const q = useGet<any[]>("/diagnoses", { refetchInterval: 30_000 });
  const navigate = useNavigate();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Diagnoses"
        rules={[13]}
        description="Diagnose before replacing. Cold sends neutral control copy and your campaign copy from the same inbox to seed inboxes, then reads where each landed."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div>
          {rows.length === 0 ? (
            <Card>
              <EmptyState icon={<FlaskConical className="size-6" />} title="No diagnoses yet">
                When a domain turns red or drifts from its baseline, Cold opens one here. You can also open one from the Health page.
              </EmptyState>
            </Card>
          ) : (
            <TableCard>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Verdict</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ diagnosis: d, domain }) => (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/diagnoses/${d.id}`)}>
                      <td className="font-medium text-ink-900">{domain.name}</td>
                      <td className="text-ink-600">{TRIGGER[d.trigger] ?? d.trigger}</td>
                      <td>
                        <Badge tone={d.status === "closed" ? "gray" : d.status === "testing" ? "amber" : d.status === "decided" ? "blue" : "violet"}>{d.status === "decided" ? "Verdict ready" : d.status}</Badge>
                      </td>
                      <td>
                        <DiagnosisVerdictBadge verdict={d.verdict} />
                      </td>
                      <td className="text-ink-500">{ago(d.openedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          )}
        </div>
        <Card title="How the verdict works">
          <DecisionTable />
          <p className="mt-3 text-xs text-ink-500">
            Before the test, Cold re-checks SPF/DKIM/DMARC and blocklists. Broken authentication means fix DNS, not replace. A blocklist listing is hard evidence and goes straight to rotation.
          </p>
        </Card>
      </div>
    </div>
  );
}

export function DiagnosisDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useGet<any>(`/diagnoses/${id}`, { refetchInterval: (query) => ((query.state.data as any)?.diagnosis?.status === "testing" ? 8_000 : false) });
  const inv = ["/diagnoses", "/domains", "/health", "/rotations"];
  const start = useAction(() => post(`/diagnoses/${id}/start-test`), { invalidate: inv, success: (r: any) => `Control test started: ${r.queued} seed sends queued` });
  const apply = useAction(() => post<any>(`/diagnoses/${id}/apply`), {
    invalidate: inv,
    onSuccess: (r) => (r.rotationId ? navigate(`/rotations/${r.rotationId}`) : undefined),
    success: (r: any) => r.result,
  });
  const dismiss = useAction(() => post(`/diagnoses/${id}/dismiss`), { invalidate: inv, success: "Diagnosis dismissed and domain resumed" });
  const [manual, setManual] = useState({ controlPass: true, campaignPass: false });
  const submitManual = useAction(() => post(`/diagnoses/${id}/manual-result`, manual), { invalidate: inv, success: "Result recorded" });
  const [ov, setOv] = useState("INFRA");
  const override = useAction((reason: string) => post(`/diagnoses/${id}/override`, { verdict: ov, reason }), { invalidate: inv, success: "Verdict overridden" });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const { diagnosis: d, domain, seedSends, campaign, seedCount } = q.data;
  const pre = d.prechecks ?? {};
  const bounces = pre.bounces;
  const control = d.controlResult as any;
  const camp = d.campaignResult as any;
  const actionLabel: Record<string, string> = {
    COPY: "Pause this copy and resume the domain",
    INFRA: "Plan the rotation",
    LIST: "Resume the domain",
    OFFER: "Resume the domain",
    AUTH: "Hold until DNS passes",
  };

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/diagnoses", label: "Diagnoses" }}
        title={
          <span className="flex items-center gap-2">
            {domain.name} <DomainStateBadge state={domain.state} />
          </span>
        }
        rules={[13]}
        description={`${TRIGGER[d.trigger] ?? d.trigger} · opened ${ago(d.openedAt)}${campaign ? ` · campaign "${campaign.name}"` : ""}`}
        actions={
          d.status !== "closed" && (
            <ConfirmButton title="Dismiss and resume sending?" body="The domain goes back to sending. Its next health verdict uses only new sends." confirmLabel="Dismiss" onConfirm={() => dismiss.mutate()} loading={dismiss.isPending}>
              Dismiss
            </ConfirmButton>
          )
        }
      />

      {d.verdict && (
        <Card className={clsx(d.verdict === "INFRA" || d.verdict === "AUTH" ? "border-red-200" : "border-brand-200")}>
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <DiagnosisVerdictBadge verdict={d.verdict} />
                {d.overrideReason && <Badge tone="gray">overridden</Badge>}
              </div>
              <p className="mt-2 text-lg font-semibold text-ink-900">{d.headline}</p>
              <p className="mt-1 text-sm text-ink-600">{d.explanation}</p>
            </div>
            {d.status === "decided" && actionLabel[d.verdict] && (
              <Button variant={d.verdict === "INFRA" ? "danger" : "primary"} loading={apply.isPending} onClick={() => apply.mutate()}>
                {actionLabel[d.verdict]}
              </Button>
            )}
            {d.status === "decided" && d.verdict === "INCONCLUSIVE" && (
              <Button variant="primary" icon={<Play className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
                Re-run test
              </Button>
            )}
            {d.status === "closed" && <Badge tone="gray">Closed {d.closedAt ? ago(d.closedAt) : ""}</Badge>}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="1 · Pre-checks" subtitle="Run automatically when the diagnosis opened">
          <div className="space-y-3">
            <Check ok={pre.authOk !== false}>
              <p className="font-medium">SPF, DKIM, DMARC</p>
              <p className="text-xs text-ink-500">{pre.authOk === false ? (pre.authDetail ?? []).join(" ") : "All passing."}</p>
            </Check>
            <Check ok={!pre.blocklist?.listed}>
              <p className="font-medium">Blocklists</p>
              <p className="text-xs text-ink-500">{pre.blocklist?.detail ?? "Not checked"}</p>
            </Check>
            <div className="border-t border-ink-100 pt-3">
              <p className="text-sm font-medium text-ink-800">Bounce mix (last {num(pre.recentSends ?? 0)} sends)</p>
              {bounces?.total ? (
                <div className="mt-2 space-y-2">
                  <BounceBar label="Unknown / invalid addresses (list)" value={bounces.listShare} tone="amber" />
                  <BounceBar label="Spam / policy blocks (reputation)" value={bounces.reputationShare} tone="red" />
                  <p className="text-xs text-ink-500">{num(bounces.total)} hard bounces total</p>
                </div>
              ) : (
                <p className="mt-1 text-xs text-ink-500">No bounces recorded.</p>
              )}
            </div>
          </div>
        </Card>

        <Card title="2 · Control test" subtitle="Same inboxes, two messages, seed inboxes at Gmail, Workspace, Outlook and Microsoft 365" className="lg:col-span-2">
          {d.status === "open" && (
            <div className="space-y-4">
              {seedCount >= 2 ? (
                <Callout tone="blue" title={`${seedCount} seed inboxes connected`} action={<Button variant="primary" icon={<Play className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>Run control test</Button>}>
                  Each seed gets a pair, neutral control copy and the campaign's first email, from the same inbox, spaced out and within every inbox's daily cap. Cold then reads which folder each landed in.
                </Callout>
              ) : (
                <Callout tone="amber" title="Connect at least 2 seed inboxes to automate this">
                  Mark a Gmail and an Outlook inbox as seeds under Domains → mailbox → Seed. Or run the test in your own placement tool and record the result below.
                </Callout>
              )}
              <div className="rounded-xl border border-ink-200 p-4">
                <p className="text-sm font-medium text-ink-800">Record a result manually</p>
                <p className="mt-0.5 text-xs text-ink-500">From GlockApps, a manual seed check, or similar. Pass = at most 20% of seeds in spam or missing.</p>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                  <Toggle checked={manual.controlPass} onChange={(v) => setManual({ ...manual, controlPass: v })} label={`Control copy ${manual.controlPass ? "passes" : "fails"}`} />
                  <Toggle checked={manual.campaignPass} onChange={(v) => setManual({ ...manual, campaignPass: v })} label={`Campaign copy ${manual.campaignPass ? "passes" : "fails"}`} />
                  <Button loading={submitManual.isPending} onClick={() => submitManual.mutate()}>
                    Record result
                  </Button>
                </div>
              </div>
            </div>
          )}
          {(d.status === "testing" || seedSends.length > 0) && <SeedGrid seedSends={seedSends} testing={d.status === "testing"} />}
          {(control || camp) && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ArmResult title="Control copy" r={control} />
              <ArmResult title="Campaign copy" r={camp} />
            </div>
          )}
          {d.status === "decided" && !control && !camp && d.verdict && <p className="text-sm text-ink-500">Decided from pre-checks. No control test needed.</p>}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="3 · Decision table">
          <DecisionTable control={control?.pass ?? null} campaign={camp?.pass ?? null} verdict={d.verdict} />
        </Card>
        {d.status !== "closed" && (
          <Card title="Override the verdict" subtitle="Your call, with a written reason. It's recorded in the audit log.">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Verdict" className="w-56">
                <Select value={ov} onChange={(e) => setOv(e.target.value)}>
                  {Object.entries(DIAG_VERDICT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <ConfirmButton title={`Set verdict to "${DIAG_VERDICT[ov]?.label}"?`} requireReason="Why?" confirmLabel="Override" onConfirm={(r) => override.mutate(r ?? "")}>
                Override
              </ConfirmButton>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function BounceBar({ label, value, tone }: { label: string; value: number; tone: "amber" | "red" }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-ink-600">{label}</span>
        <span className="font-medium tabular-nums">{pct(value, 0)}</span>
      </div>
      <Progress value={value} max={1} tone={tone} />
    </div>
  );
}

const FOLDER_TONE: Record<string, "green" | "amber" | "red" | "gray"> = { inbox: "green", promotions: "amber", spam: "red", missing: "red" };

function SeedGrid({ seedSends, testing }: { seedSends: any[]; testing: boolean }) {
  const done = seedSends.filter((s) => s.placement).length;
  return (
    <div className="space-y-3">
      {testing && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-ink-500">
            <span>Reading seed inboxes… results usually arrive within 30–60 minutes</span>
            <span>
              {done}/{seedSends.length}
            </span>
          </div>
          <Progress value={done} max={seedSends.length} />
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="tbl">
          <thead>
            <tr>
              <th>From</th>
              <th>To seed</th>
              <th>Message</th>
              <th>Status</th>
              <th>Landed in</th>
            </tr>
          </thead>
          <tbody>
            {seedSends.map((s) => (
              <tr key={s.id}>
                <td className="mono text-xs">{s.from}</td>
                <td className="mono text-xs">{s.to}</td>
                <td>
                  <Badge tone={s.arm === "control" ? "gray" : "blue"}>{s.arm}</Badge>
                </td>
                <td className="text-xs text-ink-500">{s.status === "sent" ? `sent ${dateTime(s.sentAt)}` : s.status}</td>
                <td>{s.placement ? <Badge tone={FOLDER_TONE[s.placement]}>{s.placement}</Badge> : <span className="text-xs text-ink-400">waiting</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ArmResult({ title, r }: { title: string; r: any }) {
  if (!r) return null;
  return (
    <div className={clsx("rounded-xl border p-4", r.pass ? "border-emerald-200 bg-emerald-50/50" : "border-red-200 bg-red-50/50")}>
      <div className="flex items-center gap-2">
        {r.pass ? <ShieldCheck className="size-5 text-emerald-600" /> : <ShieldX className="size-5 text-red-600" />}
        <p className="font-semibold text-ink-900">
          {title} {r.pass ? "passes" : "fails"}
        </p>
      </div>
      {r.manual ? (
        <p className="mt-1 text-xs text-ink-500">Recorded manually.</p>
      ) : (
        <p className="mt-1 text-sm text-ink-600">
          {r.inbox} inbox · {r.promotions} promotions · {r.spam} spam · {r.missing} missing ({pct(r.failShare, 0)} failed)
        </p>
      )}
    </div>
  );
}

export { DecisionTable, Link };
