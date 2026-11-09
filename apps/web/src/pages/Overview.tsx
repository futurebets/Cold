import { Link, useNavigate } from "react-router";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, CheckCircle2, Circle, Inbox as InboxIcon, Send, ShieldCheck, Activity, X } from "lucide-react";
import clsx from "clsx";
import { post, put, useAction, useGet } from "../lib/api";
import { ago, num, pct } from "../lib/format";
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Loading, PageHeader, Progress, RuleTag, Stat } from "../components/ui";
import { DOMAIN_STATE, IntentBadge, ProviderLogo, VERDICT } from "../components/badges";

export default function OverviewPage() {
  const q = useGet<any>("/overview", { refetchInterval: 30_000 });
  const navigate = useNavigate();
  const dismiss = useAction(() => put("/settings", { onboardingDismissed: true }), { invalidate: ["/overview"] });
  const resolve = useAction((id: string) => post(`/alerts/${id}/resolve`), { invalidate: ["/overview", "/alerts"] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  const t = d.totals30d;
  const replyRate = t.sent ? t.replies / t.sent : null;
  const bounceRate = t.sent ? t.bounces / t.sent : null;
  const showChecklist = !d.checklist.dismissed && d.checklist.done < d.checklist.total;
  const attention = d.alerts.filter((a: any) => a.severity !== "info");
  const info = d.alerts.filter((a: any) => a.severity === "info");

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Your sending fleet at a glance: capacity, health, what needs you, and what's next." />

      {showChecklist && (
        <Card
          title={`Launch checklist · ${d.checklist.done} of ${d.checklist.total}`}
          subtitle="The playbook, in order. Each step unlocks the next."
          actions={
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => dismiss.mutate()}>
              Hide
            </Button>
          }
        >
          <Progress value={d.checklist.done} max={d.checklist.total} tone="green" className="mb-4" />
          <ol className="grid gap-x-6 gap-y-1 md:grid-cols-2">
            {d.checklist.steps.map((s: any, i: number) => (
              <li key={s.id}>
                <Link to={s.href} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-ink-50">
                  {s.done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : <Circle className="size-5 shrink-0 text-ink-300" />}
                  <span className={clsx("flex-1 text-sm", s.done ? "text-ink-500 line-through decoration-ink-300" : "font-medium text-ink-800")}>
                    {i + 1}. {s.title}
                  </span>
                  <RuleTag n={s.rule} />
                  <ArrowRight className="size-4 text-ink-300 group-hover:text-ink-500" />
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sending capacity" value={`${num(d.capacity.active)}/day`} hint={`${d.domains.byState.active ?? 0} domains sending`} icon={<Send className="size-4" />} />
        <Stat label="Today" value={num(d.capacity.today.sent)} hint={`${num(d.capacity.today.scheduled)} scheduled · ${num(d.capacity.today.skipped)} skipped by guardrails`} icon={<Activity className="size-4" />} />
        <Stat label="Reply rate · 30d" value={pct(replyRate)} tone={replyRate == null ? undefined : replyRate < 0.01 ? "red" : "green"} hint={`${num(t.replies)} replies from ${num(t.sent)} sends`} icon={<InboxIcon className="size-4" />} />
        <Stat label="Bounce rate · 30d" value={pct(bounceRate)} tone={bounceRate == null ? undefined : bounceRate > 0.03 ? "red" : bounceRate > 0.02 ? "amber" : "green"} hint="Warning threshold 3%" icon={<ShieldCheck className="size-4" />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Needs attention" subtitle={attention.length ? undefined : "Nothing is blocking you."} className="lg:col-span-1" padded={false}>
          {attention.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6" />} title="All clear">
              Domains are healthy and the reserve is covered.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-ink-100">
              {attention.slice(0, 8).map((a: any) => (
                <li key={a.id} className="px-5 py-3.5">
                  <div className="flex items-start gap-2.5">
                    <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", a.severity === "critical" ? "bg-red-500" : "bg-amber-500")} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-800">{a.title}</p>
                      {a.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">{a.body}</p>}
                      <div className="mt-2 flex items-center gap-2">
                        {a.actionHref && (
                          <Button size="sm" variant="primary" onClick={() => navigate(a.actionHref)}>
                            {a.actionLabel ?? "Open"}
                          </Button>
                        )}
                        <button className="text-xs text-ink-400 hover:text-ink-600" onClick={() => resolve.mutate(a.id)}>
                          Dismiss
                        </button>
                        <span className="ml-auto text-xs text-ink-400">{ago(a.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Last 30 days" subtitle="Sends, replies and hard bounces per day. Opens aren't tracked (rule 10)." className="lg:col-span-2">
          {d.daily.length === 0 ? (
            <EmptyState title="No sends yet">Once domains finish warmup and a campaign is live, daily volume shows here.</EmptyState>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={d.daily} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#eef0f4" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={(v) => v.slice(5)} tick={{ fontSize: 11, fill: "#8d96a8" }} axisLine={false} tickLine={false} minTickGap={16} />
                  <YAxis yAxisId="l" tick={{ fontSize: 11, fill: "#8d96a8" }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: "#8d96a8" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #dde1e9", fontSize: 12 }} />
                  <Bar yAxisId="l" dataKey="sent" name="Sent" fill="#c3c9d5" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="r" dataKey="replies" name="Replies" stroke="#2652e0" strokeWidth={2} dot={false} />
                  <Line yAxisId="r" dataKey="bounces" name="Bounces" stroke="#dc2626" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Fleet" subtitle="Every domain by lifecycle state" actions={<Link to="/domains" className="text-sm font-medium text-brand-600 hover:text-brand-700">All domains →</Link>}>
          {d.domains.total === 0 ? (
            <p className="text-sm text-ink-500">No domains yet.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {Object.entries(d.domains.byState).map(([state, n]) => (
                  <Badge key={state} tone={DOMAIN_STATE[state]?.tone ?? "gray"} dot>
                    {DOMAIN_STATE[state]?.label ?? state} · {n as number}
                  </Badge>
                ))}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium tracking-wide text-ink-500 uppercase">Health of sending domains</p>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(d.domains.verdicts).length === 0 && <span className="text-sm text-ink-500">No sending domains yet.</span>}
                  {Object.entries(d.domains.verdicts).map(([v, n]) => (
                    <Badge key={v} tone={VERDICT[v]?.tone ?? "gray"} dot>
                      {VERDICT[v]?.label ?? v} · {n as number}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Reserve coverage" subtitle="Warmed replacements vs. active capacity" actions={<RuleTag n={7} />}>
          {d.capacity.coverage.length === 0 ? (
            <p className="text-sm text-ink-500">Add active and reserve domains to see coverage.</p>
          ) : (
            <div className="space-y-4">
              {d.capacity.coverage.map((c: any) => {
                const ratio = c.ratio ?? 0;
                return (
                  <div key={c.provider}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 font-medium text-ink-700">
                        <ProviderLogo provider={c.provider} /> {c.provider === "google" ? "Google" : "Microsoft"}
                      </span>
                      <span className={clsx("font-semibold tabular-nums", c.status === "ok" ? "text-emerald-700" : c.status === "warn" ? "text-amber-700" : "text-red-700")}>{Math.round(ratio * 100)}%</span>
                    </div>
                    <Progress value={ratio} max={c.target} tone={c.status === "ok" ? "green" : c.status === "warn" ? "amber" : "red"} />
                    <p className="mt-1 text-xs text-ink-500">
                      {num(c.readyReserveCapacity)}/day ready · {num(c.warmingReserveCapacity)}/day warming · {num(c.activeCapacity)}/day active
                    </p>
                  </div>
                );
              })}
              <Link to="/reserve" className="inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
                Manage reserve →
              </Link>
            </div>
          )}
        </Card>

        <Card title="Latest replies" padded={false} actions={<Link to="/inbox" className="text-sm font-medium text-brand-600 hover:text-brand-700">Inbox →</Link>}>
          {d.recentReplies.length === 0 ? (
            <p className="p-5 text-sm text-ink-500">No replies yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {d.recentReplies.map((r: any) => (
                <li key={r.id}>
                  <Link to={`/inbox/${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-ink-50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-800">{r.firstName ? `${r.firstName} · ${r.company ?? r.counterpart}` : r.counterpart}</p>
                      <p className="truncate text-xs text-ink-500">{r.subject}</p>
                    </div>
                    <IntentBadge intent={r.intent} />
                    <span className="text-xs whitespace-nowrap text-ink-400">{ago(r.lastInboundAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {info.length > 0 && (
        <Card title="Recent events" padded={false}>
          <ul className="divide-y divide-ink-100">
            {info.slice(0, 6).map((a: any) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="size-2 shrink-0 rounded-full bg-brand-400" />
                <span className="flex-1 text-ink-700">{a.title}</span>
                <span className="text-xs text-ink-400">{ago(a.createdAt)}</span>
                <button className="text-xs text-ink-400 hover:text-ink-600" onClick={() => resolve.mutate(a.id)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.workspace.simulation && (
        <Callout tone="gray" title="Simulation mode is on">
          Mailboxes, DNS and list validation are simulated, so nothing is sent. Turn it off in Settings → Integrations when you connect real tenants.
        </Callout>
      )}
    </div>
  );
}
