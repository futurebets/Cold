import { useState } from "react";
import { Link, useParams } from "react-router";
import clsx from "clsx";
import { AlertTriangle, Download, Megaphone, Search } from "lucide-react";
import { post, useAction, useGet } from "../lib/api";
import { date, money, num, pct, PROVIDER_SHORT } from "../lib/format";
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Stat, Tabs, TableCard, type Tone } from "../components/ui";
import { ProviderLogo } from "../components/badges";
import { ImportStatus, removedCount, type ListImport } from "./Lists";

const BUCKETS: { key: string; label: string; tone: Tone; help: string; kept?: boolean }[] = [
  { key: "ready", label: "Ready to send", tone: "green", help: "Validated, reachable, not behind a blocked gateway.", kept: true },
  { key: "catch_all", label: "Catch-all (separated)", tone: "sky", help: "The domain accepts every address, so validation can't confirm the mailbox. Sent only from the catch-all pool.", kept: true },
  { key: "seg_blocked", label: "Behind a security gateway", tone: "violet", help: "Proofpoint, Mimecast or Barracuda filter cold email aggressively. Export them for another channel." },
  { key: "invalid", label: "Invalid", tone: "red", help: "Bad syntax, no mail server, or the mailbox doesn't exist." },
  { key: "unknown", label: "Unknown", tone: "amber", help: "The validator couldn't decide. Excluded by default." },
  { key: "disposable", label: "Disposable", tone: "red", help: "Throwaway inbox providers." },
  { key: "suppressed", label: "Suppressed", tone: "gray", help: "On your suppression list (opt-outs, bounces, do-not-contact)." },
  { key: "duplicate", label: "Duplicates", tone: "gray", help: "Already in this file or already in your workspace." },
];

const SEG_LABEL: Record<string, string> = { proofpoint: "Proofpoint", mimecast: "Mimecast", barracuda: "Barracuda", cisco: "Cisco", trendmicro: "Trend Micro", sophos: "Sophos", forcepoint: "Forcepoint" };

interface Prospect {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  recipientProvider: string | null;
  seg: string | null;
  validationStatus: string | null;
  bucket: string;
  segments: string[];
  isRole: boolean;
}

export default function ListDetailPage() {
  const { id } = useParams();
  const imp = useGet<ListImport>(`/lists/${id}`, { refetchInterval: (q) => ((q.state.data as ListImport | undefined)?.status === "processing" ? 2500 : false) });
  const [enrollOpen, setEnrollOpen] = useState(false);

  if (imp.isLoading) return <Loading />;
  if (imp.error || !imp.data) return <ErrorState error={imp.error} />;
  const l = imp.data;
  const c = l.counts ?? {};
  const total = BUCKETS.reduce((a, b) => a + (c[b.key] ?? 0), 0) || l.total;
  const kept = (c.ready ?? 0) + (c.catch_all ?? 0);
  const processing = l.status === "processing";

  return (
    <div>
      <PageHeader
        back={{ to: "/lists", label: "Lists" }}
        title={l.name}
        rules={[8]}
        description={`Uploaded ${date(l.createdAt)} · ${num(l.total)} rows`}
        actions={
          <>
            <div className="w-48">
              <ImportStatus l={l} />
            </div>
            <Button variant="primary" icon={<Megaphone className="size-4" />} disabled={processing || kept === 0} onClick={() => setEnrollOpen(true)}>
              Add to campaign
            </Button>
          </>
        }
      />

      {l.breakerTripped && (
        <Callout tone="red" title="Sending to this list is paused: too many hard bounces" className="mb-5">
          Enough emails to this list bounced that Cold paused its first touches. That points to the list, not your domains. Re-validate or replace it before resuming.
        </Callout>
      )}
      {l.status === "failed" && (
        <Callout tone="red" title="Processing failed" className="mb-5">
          {l.error}
        </Callout>
      )}
      {l.status === "done" && l.stage.startsWith("Done (") && (
        <Callout tone="amber" title="Some addresses weren't validated" className="mb-5" action={<Link to="/settings/integrations" className="text-sm font-medium text-brand-600 hover:underline">Connect a validator</Link>}>
          Unvalidated addresses are never sent to (rule 8: validate every address). Connect MillionVerifier or ZeroBounce, then upload the list again. Cached results are reused, so you won't pay twice.
        </Callout>
      )}

      {processing ? (
        <Card>
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-ink-800">{l.stage}…</p>
            <p className="mt-1 text-sm text-ink-500">Free checks run first, so gateway-protected and suppressed prospects never use a validation credit.</p>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ready to send" value={num(c.ready ?? 0)} tone="green" hint={`${pct((c.ready ?? 0) / Math.max(1, total), 0)} of the list`} />
            <Stat label="Catch-all, separated" value={num(c.catch_all ?? 0)} tone="sky" hint="Send from the catch-all pool only" />
            <Stat label="Removed" value={num(removedCount(c))} hint="Invalid, unknown, gateway, suppressed, duplicate" />
            <Stat label="Validation spend" value={money(l.validationCost, 2)} hint={`${num(l.validationsSaved)} checks skipped (free filters + cache)`} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <Card title="Hygiene report" subtitle="Where every row ended up">
              <div className="space-y-3">
                {BUCKETS.map((b) => {
                  const n = c[b.key] ?? 0;
                  return (
                    <div key={b.key}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex items-center gap-2">
                          <Badge tone={b.tone} dot>
                            {b.label}
                          </Badge>
                          {b.kept && <span className="text-xs text-ink-400">kept</span>}
                        </span>
                        <span className="font-medium text-ink-800 tabular-nums">{num(n)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                        <div className={clsx("h-full rounded-full", barColor[b.tone])} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-ink-500">{b.help}</p>
                      {b.key === "seg_blocked" && Object.keys(l.segBreakdown ?? {}).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {Object.entries(l.segBreakdown).map(([seg, k]) => (
                            <span key={seg} className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">
                              {SEG_LABEL[seg] ?? seg}: {num(k)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
            <ProviderMix mix={l.providerMix ?? {}} />
          </div>

          <ProspectTable importId={l.id} counts={c} />
        </>
      )}

      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} importId={l.id} counts={c} />
    </div>
  );
}

const barColor: Record<Tone, string> = {
  green: "bg-emerald-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  red: "bg-red-400",
  amber: "bg-amber-400",
  gray: "bg-ink-300",
  blue: "bg-brand-500",
  indigo: "bg-indigo-500",
};

function ProviderMix({ mix }: { mix: Record<string, number> }) {
  const parts = [
    { key: "google", color: "bg-[#4285f4]" },
    { key: "microsoft", color: "bg-[#00a4ef]" },
    { key: "other", color: "bg-ink-400" },
  ];
  const total = parts.reduce((a, p) => a + (mix[p.key] ?? 0), 0);
  const top = parts.map((p) => ({ ...p, n: mix[p.key] ?? 0 })).sort((a, b) => b.n - a.n)[0];
  const skew = total > 0 && top.n / total > 0.8;
  return (
    <Card title="Recipient providers" subtitle="Who hosts the mailboxes you'll send to">
      {total === 0 ? (
        <p className="text-sm text-ink-500">No sendable prospects yet.</p>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-full">
            {parts.map((p) => (
              <div key={p.key} className={p.color} style={{ width: `${((mix[p.key] ?? 0) / total) * 100}%` }} />
            ))}
          </div>
          <div className="mt-4 space-y-2.5">
            {parts.map((p) => (
              <div key={p.key} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-700">
                  {p.key === "other" ? <span className="size-3.5 rounded-sm bg-ink-400" /> : <ProviderLogo provider={p.key} />}
                  {p.key === "other" ? "Other / self-hosted" : PROVIDER_SHORT[p.key]}
                </span>
                <span className="text-ink-800 tabular-nums">
                  {num(mix[p.key] ?? 0)} <span className="text-ink-400">· {pct((mix[p.key] ?? 0) / total, 0)}</span>
                </span>
              </div>
            ))}
          </div>
          {skew ? (
            <Callout tone="amber" className="mt-5" title={`${pct(top.n / total, 0)} of this list is on ${top.key === "other" ? "other providers" : PROVIDER_SHORT[top.key]}`}>
              Mix recipient providers so no single filter sees all your volume. Cold interleaves providers per inbox, but a more varied list helps.
            </Callout>
          ) : (
            <p className="mt-5 text-xs text-ink-500">Cold interleaves these providers so each inbox's daily batch mirrors this mix instead of hitting one filter all day.</p>
          )}
        </>
      )}
    </Card>
  );
}

function ProspectTable({ importId, counts }: { importId: string; counts: Record<string, number> }) {
  const [bucket, setBucket] = useState("ready");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const q = `/prospects?importId=${importId}&bucket=${bucket}&limit=${limit}&offset=${offset}${search ? `&search=${encodeURIComponent(search)}` : ""}`;
  const data = useGet<{ rows: Prospect[]; total: number }>(q, { placeholderData: (prev) => prev });
  const tabs = BUCKETS.filter((b) => (counts[b.key] ?? 0) > 0 || b.key === "ready").map((b) => ({ value: b.key, label: b.label.replace(" (separated)", ""), count: counts[b.key] ?? 0 }));

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink-900">Prospects</h2>
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-400" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Search email or company"
              className="h-9 pl-8"
            />
          </div>
          <a
            href={`/api/lists/${importId}/export?bucket=${bucket}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-medium text-ink-700 shadow-xs hover:bg-ink-50"
            download
          >
            <Download className="size-4" />
            Export CSV
          </a>
        </div>
      </div>
      <Tabs
        value={bucket}
        onChange={(v) => {
          setBucket(v);
          setOffset(0);
        }}
        tabs={tabs}
      />
      <TableCard>
        {data.isLoading ? (
          <Loading />
        ) : !data.data?.rows.length ? (
          <EmptyState title="No prospects here">{search ? "Nothing matches that search." : "This bucket is empty."}</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Company</th>
                <th>Title</th>
                <th>Mail host</th>
                <th>Validation</th>
              </tr>
            </thead>
            <tbody>
              {data.data.rows.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-[13px]">
                    {p.email}
                    {p.isRole && (
                      <Badge tone="gray" className="ml-2">
                        role
                      </Badge>
                    )}
                  </td>
                  <td>{[p.firstName, p.lastName].filter(Boolean).join(" ") || "–"}</td>
                  <td className="max-w-48 truncate">{p.company ?? "–"}</td>
                  <td className="max-w-48 truncate text-ink-500">{p.title ?? "–"}</td>
                  <td>
                    {p.seg ? (
                      <Badge tone="violet">{SEG_LABEL[p.seg] ?? p.seg}</Badge>
                    ) : p.recipientProvider === "google" || p.recipientProvider === "microsoft" ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-ink-700">
                        <ProviderLogo provider={p.recipientProvider} />
                        {PROVIDER_SHORT[p.recipientProvider]}
                      </span>
                    ) : (
                      <span className="text-ink-500">{p.recipientProvider === "none" ? "No MX" : "Other"}</span>
                    )}
                  </td>
                  <td className="text-ink-600">{p.validationStatus?.replace("_", "-") ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(data.data?.total ?? 0) > limit && (
          <div className="flex items-center justify-between border-t border-ink-100 px-4 py-2.5 text-sm text-ink-500">
            <span>
              {num(offset + 1)}–{num(Math.min(offset + limit, data.data!.total))} of {num(data.data!.total)}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Previous
              </Button>
              <Button size="sm" disabled={offset + limit >= data.data!.total} onClick={() => setOffset(offset + limit)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </TableCard>
    </div>
  );
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  isCatchAll: boolean;
}

function EnrollModal({ open, onClose, importId, counts }: { open: boolean; onClose: () => void; importId: string; counts: Record<string, number> }) {
  const campaigns = useGet<CampaignRow[]>(open ? "/campaigns" : null);
  const [kind, setKind] = useState<"ready" | "catch_all">("ready");
  const [campaignId, setCampaignId] = useState("");
  const options = (campaigns.data ?? []).filter((c) => c.isCatchAll === (kind === "catch_all") && c.status !== "completed");
  const enroll = useAction(() => post<{ enrolled: number }>(`/campaigns/${campaignId}/enroll`, { importIds: [importId] }), {
    invalidate: ["/campaigns"],
    success: (r) => (r.enrolled ? `${num(r.enrolled)} prospects enrolled` : "Nobody new to enroll: they're already in an active sequence"),
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add this list to a campaign"
      description="Each prospect is only ever in one active sequence across the workspace."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!campaignId} loading={enroll.isPending} onClick={() => enroll.mutate()}>
            Enroll {num(counts[kind] ?? 0)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(["ready", "catch_all"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setCampaignId("");
              }}
              className={clsx("rounded-xl border p-3 text-left transition-colors", kind === k ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:bg-ink-50")}
            >
              <p className="text-sm font-medium text-ink-900">{k === "ready" ? "Ready prospects" : "Catch-all prospects"}</p>
              <p className="mt-0.5 text-xs text-ink-500">{num(counts[k] ?? 0)} · {k === "ready" ? "regular campaigns" : "catch-all campaigns only"}</p>
            </button>
          ))}
        </div>
        <Field label="Campaign">
          {campaigns.isLoading ? (
            <Loading />
          ) : options.length === 0 ? (
            <Callout tone="amber">
              <span className="flex items-center gap-1.5">
                <AlertTriangle className="size-4" />
                No {kind === "catch_all" ? "catch-all" : "regular"} campaign yet. Create one under Campaigns first.
              </span>
            </Callout>
          ) : (
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">Choose a campaign…</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  );
}
