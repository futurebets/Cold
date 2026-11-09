import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Globe, Plus, Search } from "lucide-react";
import { DEFAULT_POLICIES } from "@cold/core";
import { useGet } from "../lib/api";
import { num } from "../lib/format";
import { Button, EmptyState, ErrorState, Input, Loading, PageHeader, Progress, Segmented, Stat, TableCard } from "../components/ui";
import { DomainStateBadge, PoolBadge, ProviderLogo, VerdictBadge } from "../components/badges";
import { AddDomainsWizard } from "../components/infra/AddDomainsWizard";
import type { DomainListRow, PoliciesResponse } from "../components/infra/types";

type PoolFilter = "all" | "active" | "reserve" | "retired";

const ATTENTION = new Set(["pending_dns", "auth_failed", "flagged", "diagnosing"]);

export default function DomainsPage() {
  const q = useGet<DomainListRow[]>("/domains");
  const policies = useGet<PoliciesResponse>("/policies");
  const minDays = policies.data?.effective.warmup.minDays ?? DEFAULT_POLICIES.warmup.minDays;
  const navigate = useNavigate();
  const [pool, setPool] = useState<PoolFilter>("all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  const rows = q.data ?? [];
  const filtered = useMemo(
    () => rows.filter((d) => (pool === "all" ? d.state !== "retired" : d.pool === pool)).filter((d) => !search || d.name.includes(search.trim().toLowerCase())),
    [rows, pool, search],
  );

  const stats = useMemo(() => {
    const activeCap = rows.filter((d) => d.state === "active").reduce((a, d) => a + d.capacity, 0);
    const readyCap = rows.filter((d) => d.pool === "reserve" && d.state === "ready").reduce((a, d) => a + d.capacity, 0);
    const warming = rows.filter((d) => d.state === "warming");
    const attention = rows.filter((d) => ATTENTION.has(d.state) || (d.mailboxCount > 0 && d.connectedCount < d.mailboxCount && d.state !== "retired"));
    return { activeCap, readyCap, warming, attention };
  }, [rows]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        rules={[1, 4]}
        description="Lookalike sending domains and their mailboxes. Each one moves through DNS → warmup → sending, and Cold blocks every step until the previous one passes."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add domains
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active capacity" value={`${num(stats.activeCap)}/day`} hint={`${rows.filter((d) => d.state === "active").length} domains sending`} />
        <Stat label="Ready in reserve" value={`${num(stats.readyCap)}/day`} hint="Warmed replacements on standby" tone={stats.readyCap >= stats.activeCap && stats.activeCap > 0 ? "green" : stats.activeCap > 0 ? "amber" : undefined} />
        <Stat label="Warming" value={stats.warming.length} hint={`${num(stats.warming.reduce((a, d) => a + d.capacity, 0))}/day once ready`} tone="violet" />
        <Stat label="Needs attention" value={stats.attention.length} hint="DNS, auth, health or connection" tone={stats.attention.length ? "red" : "green"} />
      </div>

      {rows.length === 0 ? (
        <TableCard>
          <EmptyState
            icon={<Globe className="size-6" />}
            title="No sending domains yet"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Add your first domains
              </Button>
            }
          >
            Cold email goes out from separate domains that resemble your brand, never your primary domain. Add an active set to send from and a reserve set to warm as replacements.
          </EmptyState>
        </TableCard>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={pool}
              onChange={setPool}
              options={[
                { value: "all", label: `All (${rows.filter((d) => d.state !== "retired").length})` },
                { value: "active", label: `Active set (${rows.filter((d) => d.pool === "active").length})` },
                { value: "reserve", label: `Reserve set (${rows.filter((d) => d.pool === "reserve").length})` },
                { value: "retired", label: `Retired (${rows.filter((d) => d.pool === "retired").length})` },
              ]}
            />
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search domains" style={{ paddingLeft: "2.25rem" }} />
            </div>
          </div>

          <TableCard>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Set</th>
                  <th>Status</th>
                  <th>Mailboxes</th>
                  <th>Today</th>
                  <th>Warmup</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => navigate(`/domains/${d.id}`)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <ProviderLogo provider={d.provider} />
                        <span className="mono text-[13px] font-medium text-ink-900">{d.name}</span>
                      </div>
                      {d.vendor === "hypertide" && <p className="mt-0.5 pl-5.5 text-xs text-ink-400">via Hypertide</p>}
                    </td>
                    <td>
                      <PoolBadge pool={d.pool} />
                    </td>
                    <td>
                      <DomainStateBadge state={d.state} />
                    </td>
                    <td className="tabular-nums">
                      {d.mailboxCount === 0 ? (
                        <span className="text-ink-400">None</span>
                      ) : (
                        <span className={d.connectedCount < d.mailboxCount ? "text-amber-700" : "text-ink-700"}>
                          {d.connectedCount}/{d.mailboxCount} connected
                        </span>
                      )}
                    </td>
                    <td className="min-w-32">
                      {d.state === "active" ? (
                        <div>
                          <p className="text-xs text-ink-600 tabular-nums">
                            {num(d.scheduledOrSentToday)} / {num(d.capacity)}
                          </p>
                          <Progress value={d.scheduledOrSentToday} max={d.capacity || 1} className="mt-1" tone={d.scheduledOrSentToday >= d.capacity ? "green" : "blue"} />
                        </div>
                      ) : (
                        <span className="text-xs text-ink-400">{d.capacity ? `${num(d.capacity)}/day when sending` : "–"}</span>
                      )}
                    </td>
                    <td className="min-w-36">
                      <WarmupCell row={d} minDays={minDays} />
                    </td>
                    <td>{["active", "flagged", "diagnosing", "layover"].includes(d.state) ? <VerdictBadge verdict={d.healthVerdict} /> : <span className="text-xs text-ink-400">–</span>}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-sm text-ink-500">
                      No domains match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableCard>
        </>
      )}

      <AddDomainsWizard open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function WarmupCell({ row, minDays }: { row: DomainListRow; minDays: number }) {
  if (row.state === "retired" || row.state === "relay") return <span className="text-xs text-ink-400">–</span>;
  if (row.warmupLevel === "not_started") return <span className="text-xs text-ink-400">Not started</span>;
  if (row.warmupLevel === "warming")
    return (
      <div>
        <p className="text-xs text-violet-700 tabular-nums">
          Day {row.warmupDays} of {minDays}
        </p>
        <Progress value={row.warmupDays} max={minDays} className="mt-1" tone="blue" />
      </div>
    );
  return (
    <span className={row.warmupLevel === "ready_recommended" ? "text-xs text-emerald-700" : "text-xs text-ink-600"}>
      Warm · {row.warmupDays}d{row.warmupLevel === "ready_min" ? " (30 recommended)" : ""}
    </span>
  );
}
