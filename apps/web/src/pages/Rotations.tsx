import { Link, useNavigate, useParams } from "react-router";
import { ArrowRight, RefreshCcw } from "lucide-react";
import { post, useAction, useGet } from "../lib/api";
import { ago, date, num } from "../lib/format";
import { Badge, Button, Callout, Card, ConfirmButton, EmptyState, ErrorState, KeyValue, Loading, PageHeader, TableCard } from "../components/ui";
import { DomainStateBadge } from "../components/badges";

const STATUS_TONE: Record<string, "amber" | "green" | "gray" | "blue"> = { planned: "amber", executed: "blue", completed: "green", cancelled: "gray" };

export function RotationsPage() {
  const q = useGet<any[]>("/rotations", { refetchInterval: 30_000 });
  const navigate = useNavigate();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Rotations"
        rules={[14]}
        description="Swap burned domains for warmed replacements without stopping sending. Replies to outgoing inboxes keep arriving through Relay."
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<RefreshCcw className="size-6" />} title="No rotations yet">
            Rotations are planned from a diagnosis with an Infrastructure verdict. Your domains will eventually burn, and when one does it shows up here.
          </EmptyState>
        </Card>
      ) : (
        <TableCard>
          <table className="tbl">
            <thead>
              <tr>
                <th>Outgoing</th>
                <th />
                <th>Replacement</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Capacity</th>
                <th>Moved / ended / kept</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/rotations/${r.id}`)}>
                  <td className="font-medium text-ink-900">{r.outgoing?.name}</td>
                  <td>
                    <ArrowRight className="size-4 text-ink-300" />
                  </td>
                  <td className="font-medium text-ink-900">{r.replacement?.name ?? <span className="text-ink-400">none yet</span>}</td>
                  <td>{r.mode === "immediate" ? <Badge tone="green">Immediate</Badge> : <Badge tone="amber">Layover</Badge>}</td>
                  <td>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="text-ink-600 tabular-nums">
                    {num(r.capacityBefore)} → {num(r.capacityAfter)}/day
                  </td>
                  <td className="text-ink-600 tabular-nums">
                    {r.migratedCount} / {r.endedCount} / {r.threadsKept}
                  </td>
                  <td className="text-ink-500">{ago(r.executedAt ?? r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}

export function RotationDetailPage() {
  const { id } = useParams();
  const q = useGet<any>(`/rotations/${id}`);
  const inv = ["/rotations", "/domains", "/reserve", "/diagnoses", "/health"];
  const exec = useAction(() => post(`/rotations/${id}/execute`), { invalidate: inv, success: "Rotation executed. Sending continues." });
  const cancel = useAction(() => post(`/rotations/${id}/cancel`), { invalidate: inv, success: "Rotation cancelled" });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data;
  const plan = r.plan ?? {};
  const immediate = r.mode === "immediate";
  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/rotations", label: "Rotations" }}
        title={`Rotate ${r.outgoing?.name ?? ""}`}
        rules={[14]}
        description={r.status === "planned" ? "Review the plan, then approve. The replacement starts sending before the outgoing domain stops (make before break)." : `Executed ${ago(r.executedAt)}.`}
        actions={
          r.status === "planned" && (
            <>
              <Button loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel
              </Button>
              <ConfirmButton
                variant="primary"
                confirmVariant="primary"
                title="Approve and execute this rotation?"
                body={immediate ? "The replacement goes active now, in-flight sequences move over, and the outgoing domain moves to Relay." : `No warmed replacement is ready, so the outgoing domain enters a ${plan.layoverDays}-day Layover.`}
                confirmLabel="Approve & execute"
                onConfirm={() => exec.mutate()}
                loading={exec.isPending}
              >
                Approve & execute
              </ConfirmButton>
            </>
          )
        }
      />

      <div className="grid items-stretch gap-4 md:grid-cols-[1fr_auto_1fr]">
        <Card title="Outgoing">
          <p className="text-lg font-semibold text-ink-900">{r.outgoing?.name}</p>
          <div className="mt-2">{r.outgoing && <DomainStateBadge state={r.outgoing.state} />}</div>
          <p className="mt-3 text-sm text-ink-600">
            {r.status === "planned"
              ? immediate
                ? `Moves to Relay for ${plan.relayDays} days: no new cold email, every reply still arrives in your inbox.`
                : `Enters a ${plan.layoverDays}-day Layover: follow-ups and replies continue, new first emails go to other domains.`
              : r.relayEndsAt
                ? `Relay until ${date(r.relayEndsAt)}.`
                : r.layoverEndsAt
                  ? `Layover until ${date(r.layoverEndsAt)}.`
                  : ""}
          </p>
        </Card>
        <div className="hidden items-center justify-center md:flex">
          <div className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <ArrowRight className="size-5" />
          </div>
        </div>
        <Card title="Replacement">
          {r.replacement ? (
            <>
              <p className="text-lg font-semibold text-ink-900">{r.replacement.name}</p>
              <div className="mt-2">
                <DomainStateBadge state={r.replacement.state} />
              </div>
              <p className="mt-3 text-sm text-ink-600">
                {plan.replacement ? `${plan.replacement.warmupDays} days warm · ${plan.replacement.capacity}/day capacity.` : plan.nextUp ? `Still warming: ready in about ${plan.nextUp.readyInDays} days.` : ""}
              </p>
            </>
          ) : (
            <Callout tone="amber" title="No replacement warming">
              Order replacements on the Reserve page. Capacity stays reduced until one is ready.
            </Callout>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Plan">
          <ol className="space-y-3">
            {(plan.steps ?? []).map((s: string, i: number) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">{i + 1}</span>
                <span className="pt-0.5 text-ink-700">{s}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Impact">
          <KeyValue
            items={[
              { label: "Capacity before", value: `${num(r.capacityBefore)}/day` },
              { label: "Capacity after", value: `${num(r.capacityAfter)}/day` },
              { label: "Sequences moved", value: num(r.migratedCount) },
              { label: "Sequences ended", value: `${num(r.endedCount)} (re-enroll after cooldown)` },
              { label: "Conversations kept", value: num(r.threadsKept) },
              { label: "Status", value: <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
            ]}
          />
          {r.diagnosisId && (
            <Link to={`/diagnoses/${r.diagnosisId}`} className="mt-4 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
              View the diagnosis →
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}
