import { useNavigate, useSearchParams } from "react-router";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { FlaskConical, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { post, useAction, useGet } from "../lib/api";
import { ago, num, pct } from "../lib/format";
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Loading, PageHeader, Progress, TableCard } from "../components/ui";
import { DomainStateBadge, ProviderBadge, VerdictBadge } from "../components/badges";

const ORDER: Record<string, number> = { red: 0, amber: 1, insufficient_data: 2, green: 3 };

export default function HealthPage() {
  const q = useGet<any>("/health", { refetchInterval: 60_000 });
  const [params, setParams] = useSearchParams();
  const selected = params.get("domain");
  const navigate = useNavigate();
  const evaluate = useAction(() => post("/health/evaluate"), { invalidate: ["/health", "/domains"], success: "Health re-evaluated" });
  const diagnose = useAction((domainId: string) => post<any>("/diagnoses", { domainId }), {
    invalidate: ["/diagnoses", "/health", "/domains"],
    onSuccess: (d) => navigate(`/diagnoses/${d.id}`),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const th = q.data.thresholds;
  const domains = [...q.data.domains].sort((a: any, b: any) => (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9) || a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        rules={[10, 12]}
        description="Each sending domain is judged on reply and bounce rates over its latest 1,000 mature sends, compared with its own normal baseline."
        actions={
          <Button icon={<RefreshCw className="size-4" />} loading={evaluate.isPending} onClick={() => evaluate.mutate()}>
            Re-evaluate now
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Rule label="Minimum sample" value={`${num(th.minSample)} sends`} />
        <Rule label="Wait before counting" value={`${th.maturityHours} hours`} />
        <Rule label="Red" value={`reply < ${pct(th.redReplyRateBelow, 0)} and bounce > ${pct(th.redBounceRateAbove, 0)}`} tone="red" />
        <Rule label="Drifting" value={`reply < ${Math.round(th.amberReplyVsBaseline * 100)}% of normal, or bounce +${pct(th.amberBounceOverBaseline, 0)}`} tone="amber" />
      </div>

      {domains.length === 0 ? (
        <Card>
          <EmptyState title="No sending domains yet">Health appears once domains are active and sending.</EmptyState>
        </Card>
      ) : (
        <TableCard>
          <table className="tbl">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Verdict</th>
                <th>Sample</th>
                <th>Reply rate</th>
                <th>Bounce rate</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {domains.map((d: any) => {
                const w = d.window;
                return (
                  <tr key={d.id} className={clsx("clickable", selected === d.id && "bg-brand-50/50")} onClick={() => setParams({ domain: d.id })}>
                    <td>
                      <p className="font-medium text-ink-900">{d.name}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <ProviderBadge provider={d.provider} />
                        <DomainStateBadge state={d.state} />
                      </div>
                    </td>
                    <td>
                      <VerdictBadge verdict={d.verdict} />
                    </td>
                    <td className="w-40">
                      <Progress value={d.matureSends} max={th.minSample} tone={d.matureSends >= th.minSample ? "green" : "gray"} />
                      <p className="mt-1 text-xs text-ink-500">
                        {num(d.matureSends)} / {num(th.minSample)} mature
                      </p>
                    </td>
                    <td>
                      <RateCell value={w?.replyRate} base={w?.baselineReplyRate} bad={(w?.replyRate ?? 1) < th.redReplyRateBelow} />
                    </td>
                    <td>
                      <RateCell value={w?.bounceRate} base={w?.baselineBounceRate} bad={(w?.bounceRate ?? 0) > th.redBounceRateAbove} />
                    </td>
                    <td className="max-w-xs text-xs text-ink-500">{w?.reasons?.join(" ") ?? "Waiting for the first evaluation."}</td>
                    <td className="text-right">
                      {["active", "flagged"].includes(d.state) && d.verdict !== "green" && d.verdict !== "insufficient_data" && (
                        <Button
                          size="sm"
                          variant={d.verdict === "red" ? "primary" : "secondary"}
                          icon={<FlaskConical className="size-4" />}
                          loading={diagnose.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            diagnose.mutate(d.id);
                          }}
                        >
                          Diagnose
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}

      {selected && <DomainHistory id={selected} name={domains.find((d: any) => d.id === selected)?.name ?? ""} th={th} />}

      <Callout tone="gray" title="Why not open rates?">
        Open tracking needs a tracking pixel, which hurts deliverability, and Apple Mail Privacy Protection makes open data unreliable anyway. Cold judges domains on replies and bounces only.
      </Callout>
    </div>
  );
}

function Rule({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-4 py-3 shadow-xs">
      <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">{label}</p>
      <p className={clsx("mt-1 text-sm font-semibold", tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-ink-800")}>{value}</p>
    </div>
  );
}

function RateCell({ value, base, bad }: { value?: number | null; base?: number | null; bad?: boolean }) {
  if (value == null) return <span className="text-ink-400">–</span>;
  return (
    <div>
      <p className={clsx("font-semibold tabular-nums", bad ? "text-red-700" : "text-ink-800")}>{pct(value)}</p>
      {base != null && <p className="text-xs text-ink-500">normal {pct(base)}</p>}
    </div>
  );
}

function DomainHistory({ id, name, th }: { id: string; name: string; th: any }) {
  const q = useGet<any>(`/health/domains/${id}`);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const daily = q.data.daily.map((r: any) => ({ ...r, replyRate: r.sent ? (r.replies / r.sent) * 100 : 0, bounceRate: r.sent ? (r.bounces / r.sent) * 100 : 0 }));
  const windows = q.data.windows;
  const last = windows[windows.length - 1];
  return (
    <Card title={`${name}: last 60 days`} subtitle="Daily reply and bounce rates. Dashed lines are the red thresholds.">
      {daily.length === 0 ? (
        <p className="text-sm text-ink-500">No sends in the last 60 days.</p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#eef0f4" vertical={false} />
              <XAxis dataKey="day" tickFormatter={(v) => v.slice(5)} tick={{ fontSize: 11, fill: "#8d96a8" }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: "#8d96a8" }} axisLine={false} tickLine={false} unit="%" />
              <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} contentStyle={{ borderRadius: 10, border: "1px solid #dde1e9", fontSize: 12 }} />
              <ReferenceLine y={th.redReplyRateBelow * 100} stroke="#2652e0" strokeDasharray="4 4" />
              <ReferenceLine y={th.redBounceRateAbove * 100} stroke="#dc2626" strokeDasharray="4 4" />
              <Area dataKey="replyRate" name="Reply rate" stroke="#2652e0" fill="#dbe7ff" strokeWidth={2} />
              <Line dataKey="bounceRate" name="Bounce rate" stroke="#dc2626" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {last && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-500">
          <span>Last evaluated {ago(last.evaluatedAt)}</span>
          <span>·</span>
          <span>{num(last.sends)} sends in window</span>
          {last.baselineSource && <Badge tone="gray">baseline: {last.baselineSource === "own" ? "this domain's history" : "peer domains"}</Badge>}
        </div>
      )}
    </Card>
  );
}
