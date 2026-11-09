import { useState } from "react";
import { useNavigate } from "react-router";
import clsx from "clsx";
import { PackagePlus, ShieldCheck } from "lucide-react";
import { DEFAULT_POLICIES } from "@cold/core";
import { post, put, useAction, useGet } from "../lib/api";
import { date, num, pct, PROVIDER_LABEL } from "../lib/format";
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Field, Input, LinkButton, Loading, Modal, PageHeader, Progress, RuleTag, Select, TableCard } from "../components/ui";
import { DomainStateBadge, ProviderLogo } from "../components/badges";
import type { PoliciesResponse } from "../components/infra/types";

interface Coverage {
  provider: "google" | "microsoft";
  activeCapacity: number;
  readyReserveCapacity: number;
  warmingReserveCapacity: number;
  ratio: number | null;
  target: number;
  status: "ok" | "warn" | "critical" | "none";
}
interface ReserveDomain {
  id: string;
  name: string;
  provider: "google" | "microsoft";
  pool: string;
  state: string;
  billingStatus: string;
  vendor: string;
  mailboxes: number;
  capacity: number;
  warmupDays: number;
  readyInDays: number | null;
}
interface Order {
  id: string;
  provider: "google" | "microsoft";
  domainCount: number;
  mailboxesPerDomain: number;
  targetPool: string;
  status: "draft" | "ordered" | "done" | "cancelled";
  reason: string;
  createdAt: string;
}
interface ReserveView {
  coverage: Coverage[];
  domains: ReserveDomain[];
  orders: Order[];
  target: number;
  minDays: number;
  targetDays: number;
}

const BILLING: Record<string, { label: string; tone: "violet" | "gray" | "amber" }> = {
  recovery_pool: { label: "Recovery Pool", tone: "violet" },
  active: { label: "Billed as active", tone: "gray" },
  layover: { label: "Layover", tone: "amber" },
  relay: { label: "Relay", tone: "gray" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

const ORDER_TONE = { draft: "amber", ordered: "blue", done: "green", cancelled: "gray" } as const;

export default function ReservePage() {
  const q = useGet<ReserveView>("/reserve");
  const policiesQ = useGet<PoliciesResponse>("/policies");
  const policies = policiesQ.data?.effective ?? DEFAULT_POLICIES;
  const navigate = useNavigate();
  const [newOrder, setNewOrder] = useState<{ provider: "google" | "microsoft"; domainCount: string; mailboxesPerDomain: string; reason: string } | null>(null);
  const inv = ["/reserve", "/domains"];

  const createOrder = useAction((body: { provider: string; domainCount: number; mailboxesPerDomain: number; reason: string }) => post("/orders", body), {
    invalidate: inv,
    success: "Replacement order created",
    onSuccess: () => setNewOrder(null),
  });
  const setStatus = useAction((v: { id: string; status: Order["status"] }) => put(`/orders/${v.id}`, { status: v.status }), { invalidate: inv, success: "Order updated" });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const { coverage, domains, orders, target, minDays, targetDays } = q.data;

  const pipeline = domains.filter((d) => d.pool === "reserve").sort((a, b) => (a.state === "ready" ? -1 : 1) - (b.state === "ready" ? -1 : 1) || b.warmupDays - a.warmupDays);
  const openOrders = orders.filter((o) => o.status === "draft" || o.status === "ordered");

  /** Domains needed to close the gap, counting capacity that is already warming or on order. */
  const gapFor = (c: Coverage) => {
    const active = domains.filter((d) => d.provider === c.provider && d.pool === "active");
    const boxes = active.length ? Math.round(active.reduce((a, d) => a + d.mailboxes, 0) / active.length) : c.provider === "google" ? policies.caps.google.mailboxesPerDomain : policies.caps.microsoft.mailboxesPerDomainMax;
    const perDomain = Math.max(1, active.length ? Math.round(active.reduce((a, d) => a + d.capacity, 0) / active.length) : c.provider === "google" ? policies.caps.google.perDomainDaily : policies.caps.microsoft.perDomainDaily);
    const onOrder = openOrders.filter((o) => o.provider === c.provider).reduce((a, o) => a + o.domainCount, 0) * perDomain;
    const missing = c.activeCapacity * c.target - c.readyReserveCapacity - c.warmingReserveCapacity - onOrder;
    return { domains: Math.max(0, Math.ceil(missing / perDomain)), boxes: Math.max(1, boxes) };
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reserve"
        rules={[7, 14]}
        description="Your second infrastructure set: warmed replacements standing by so a burned domain can be swapped out the same hour, without a sending gap."
        actions={
          <Button icon={<PackagePlus className="size-4" />} onClick={() => setNewOrder({ provider: "microsoft", domainCount: "1", mailboxesPerDomain: String(policies.caps.microsoft.mailboxesPerDomainMax), reason: "Grow reserve" })}>
            New order
          </Button>
        }
      />

      {coverage.length === 0 ? (
        <TableCard>
          <EmptyState icon={<ShieldCheck className="size-6" />} title="No infrastructure yet" action={<LinkButton to="/domains" variant="primary">Add domains</LinkButton>}>
            Add an active set to send from and a reserve set of the same size to warm as replacements.
          </EmptyState>
        </TableCard>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {coverage.map((c) => {
            const ratio = c.ratio ?? 0;
            const gap = gapFor(c);
            const tone = c.status === "ok" ? "green" : c.status === "warn" ? "amber" : c.status === "critical" ? "red" : "gray";
            return (
              <Card key={c.provider}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ProviderLogo provider={c.provider} className="size-4" />
                    <p className="font-medium text-ink-900">{PROVIDER_LABEL[c.provider]}</p>
                  </div>
                  <Badge tone={tone === "gray" ? "gray" : tone} dot>
                    {c.status === "ok" ? "Covered" : c.status === "warn" ? "Thin" : c.status === "critical" ? "Exposed" : "No active domains"}
                  </Badge>
                </div>
                <div className="mt-4 flex items-baseline gap-2">
                  <p className={clsx("text-4xl font-semibold tracking-tight tabular-nums", tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-ink-700")}>
                    {c.ratio == null ? "–" : pct(ratio, 0)}
                  </p>
                  <p className="text-sm text-ink-500">of active capacity is warmed and ready (target {pct(c.target, 0)})</p>
                </div>
                <Progress value={ratio} max={Math.max(c.target, ratio, 0.01)} tone={tone === "gray" ? "gray" : tone} className="mt-3 h-2" />
                <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-ink-500">Active</p>
                    <p className="font-semibold text-ink-900 tabular-nums">{num(c.activeCapacity)}/day</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-500">Ready in reserve</p>
                    <p className="font-semibold text-indigo-700 tabular-nums">{num(c.readyReserveCapacity)}/day</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-500">Still warming</p>
                    <p className="font-semibold text-violet-700 tabular-nums">{num(c.warmingReserveCapacity)}/day</p>
                  </div>
                </div>
                {c.status !== "ok" && c.status !== "none" && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-50 p-3">
                    <p className="text-sm text-ink-600">
                      {gap.domains > 0
                        ? `Order ${gap.domains} more domain${gap.domains === 1 ? "" : "s"} to reach full coverage once they've warmed ${minDays}+ days.`
                        : "Enough capacity is warming or on order. It will count once warmup reaches the minimum."}
                    </p>
                    {gap.domains > 0 && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={createOrder.isPending}
                        onClick={() => createOrder.mutate({ provider: c.provider, domainCount: gap.domains, mailboxesPerDomain: gap.boxes, reason: `Close reserve gap (${pct(ratio, 0)} → ${pct(c.target, 0)})` })}
                      >
                        Order {gap.domains} replacement{gap.domains === 1 ? "" : "s"}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Callout tone="blue" title="Why keep a second set?" action={<RuleTag n={7} />}>
        Domains burn eventually, however careful you are, and a new domain needs {minDays}+ days of warmup ({targetDays} is better). Warming replacements now means a rotation
        takes minutes, not weeks. With Hypertide, reserve domains sit in the Recovery Pool so you don't pay for them as active infrastructure.
      </Callout>

      <Card title="Warming pipeline" subtitle="Reserve domains, warmest first. The top Ready domain is the next replacement." padded={false}>
        {pipeline.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-500">Nothing in reserve. Add domains to the reserve set from the Domains page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Mailboxes</th>
                  <th>Capacity</th>
                  <th>Warmup</th>
                  <th>Billing</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.map((d, i) => {
                  const b = BILLING[d.billingStatus] ?? { label: d.billingStatus, tone: "gray" as const };
                  return (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/domains/${d.id}`)}>
                      <td>
                        <div className="flex items-center gap-2">
                          <ProviderLogo provider={d.provider} />
                          <span className="mono text-[13px] font-medium">{d.name}</span>
                          {i === 0 && d.state === "ready" && <Badge tone="indigo">Next up</Badge>}
                        </div>
                      </td>
                      <td>
                        <DomainStateBadge state={d.state} />
                      </td>
                      <td className="tabular-nums">{d.mailboxes}</td>
                      <td className="tabular-nums">{num(d.capacity)}/day</td>
                      <td className="min-w-40">
                        {d.readyInDays == null ? (
                          <span className="text-xs text-ink-400">Not started</span>
                        ) : (
                          <>
                            <p className="text-xs text-ink-600 tabular-nums">
                              {d.warmupDays}d {d.readyInDays > 0 ? `· ready in ${d.readyInDays}d` : d.warmupDays >= targetDays ? "· fully warm" : `· ${targetDays - d.warmupDays}d to recommended`}
                            </p>
                            <Progress value={Math.min(d.warmupDays, targetDays)} max={targetDays} className="mt-1" tone={d.readyInDays > 0 ? "blue" : "green"} />
                          </>
                        )}
                      </td>
                      <td>
                        <Badge tone={b.tone}>{b.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Replacement orders" subtitle="Created automatically after each rotation, or by you. Place the order with your vendor, then track it here." padded={false}>
        {orders.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-500">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap text-ink-600">{date(o.createdAt)}</td>
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <ProviderLogo provider={o.provider} />
                        {o.domainCount} domain{o.domainCount === 1 ? "" : "s"} × {o.mailboxesPerDomain} mailboxes
                      </span>
                    </td>
                    <td className="text-ink-600">{o.reason}</td>
                    <td>
                      <Badge tone={ORDER_TONE[o.status]}>{o.status === "draft" ? "To order" : o.status === "ordered" ? "Ordered" : o.status === "done" ? "Delivered" : "Cancelled"}</Badge>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {o.status === "draft" && (
                        <Button size="sm" onClick={() => setStatus.mutate({ id: o.id, status: "ordered" })}>
                          Mark ordered
                        </Button>
                      )}
                      {o.status === "ordered" && (
                        <Button size="sm" onClick={() => setStatus.mutate({ id: o.id, status: "done" })}>
                          Mark delivered
                        </Button>
                      )}
                      {(o.status === "draft" || o.status === "ordered") && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: o.id, status: "cancelled" })}>
                          Cancel
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={!!newOrder}
        onClose={() => setNewOrder(null)}
        title="New replacement order"
        description="Track domains you're buying for the reserve set. Add them on the Domains page once they arrive."
        footer={
          <>
            <Button onClick={() => setNewOrder(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={createOrder.isPending}
              disabled={!newOrder || Number(newOrder.domainCount) < 1 || Number(newOrder.mailboxesPerDomain) < 1}
              onClick={() =>
                newOrder &&
                createOrder.mutate({ provider: newOrder.provider, domainCount: Number(newOrder.domainCount), mailboxesPerDomain: Number(newOrder.mailboxesPerDomain), reason: newOrder.reason || "Manual order" })
              }
            >
              Create order
            </Button>
          </>
        }
      >
        {newOrder && (
          <div className="space-y-4">
            <Field label="Provider">
              <Select
                value={newOrder.provider}
                onChange={(e) => {
                  const p = e.target.value as "google" | "microsoft";
                  setNewOrder({ ...newOrder, provider: p, mailboxesPerDomain: String(p === "google" ? policies.caps.google.mailboxesPerDomain : policies.caps.microsoft.mailboxesPerDomainMax) });
                }}
              >
                <option value="microsoft">Microsoft 365</option>
                <option value="google">Google Workspace</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Domains">
                <Input type="number" min={1} value={newOrder.domainCount} onChange={(e) => setNewOrder({ ...newOrder, domainCount: e.target.value })} />
              </Field>
              <Field label="Mailboxes per domain" hint={`Max ${newOrder.provider === "google" ? policies.caps.google.mailboxesPerDomain : policies.caps.microsoft.mailboxesPerDomainMax}`}>
                <Input
                  type="number"
                  min={1}
                  max={newOrder.provider === "google" ? policies.caps.google.mailboxesPerDomain : policies.caps.microsoft.mailboxesPerDomainMax}
                  value={newOrder.mailboxesPerDomain}
                  onChange={(e) => setNewOrder({ ...newOrder, mailboxesPerDomain: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Reason">
              <Input value={newOrder.reason} onChange={(e) => setNewOrder({ ...newOrder, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
