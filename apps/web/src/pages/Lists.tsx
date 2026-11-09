import { useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import clsx from "clsx";
import { FileSpreadsheet, Filter, ShieldOff, Trash2, Upload, Users } from "lucide-react";
import { guessColumnMapping } from "@cold/core";
import { del, post, useAction, useGet } from "../lib/api";
import { ago, date, num } from "../lib/format";
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Progress, Select, TableCard, Textarea } from "../components/ui";
import { parseCsvPreview } from "../components/outreach/csv";

export interface ListImport {
  id: string;
  name: string;
  status: "processing" | "done" | "failed";
  stage: string;
  total: number;
  processed: number;
  counts: Record<string, number>;
  providerMix: Record<string, number>;
  segBreakdown: Record<string, number>;
  validationCost: number;
  validationsSaved: number;
  error: string | null;
  breakerTripped: boolean;
  createdAt: string;
  completedAt: string | null;
}

const REMOVED = ["invalid", "unknown", "disposable", "seg_blocked", "suppressed", "duplicate"];
export const removedCount = (c: Record<string, number>) => REMOVED.reduce((a, k) => a + (c[k] ?? 0), 0);

export default function ListsPage() {
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const lists = useGet<ListImport[]>("/lists", {
    refetchInterval: (q) => ((q.state.data as ListImport[] | undefined)?.some((l) => l.status === "processing") ? 3000 : false),
  });

  return (
    <div>
      <PageHeader
        title="Lists"
        rules={[8]}
        description="Upload prospects and Cold cleans them before anyone gets an email: every address validated, catch-alls separated, gateway-protected prospects removed, recipient providers mixed."
        actions={
          <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUploadOpen(true)}>
            Upload list
          </Button>
        }
      />

      <PipelineExplainer />

      {lists.isLoading ? (
        <Loading />
      ) : lists.error ? (
        <ErrorState error={lists.error} />
      ) : !lists.data?.length ? (
        <Card className="mt-6">
          <EmptyState
            icon={<Users className="size-6" />}
            title="No lists yet"
            action={
              <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUploadOpen(true)}>
                Upload your first CSV
              </Button>
            }
          >
            Any CSV with an email column works. Cold maps the other columns for you.
          </EmptyState>
        </Card>
      ) : (
        <TableCard className="mt-6">
          <table className="tbl">
            <thead>
              <tr>
                <th>List</th>
                <th>Uploaded</th>
                <th className="text-right">Rows</th>
                <th className="text-right">Ready</th>
                <th className="text-right">Catch-all</th>
                <th className="text-right">Removed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {lists.data.map((l) => (
                <tr key={l.id} className="clickable" onClick={() => navigate(`/lists/${l.id}`)}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <FileSpreadsheet className="size-4 shrink-0 text-ink-400" />
                      <span className="font-medium text-ink-900">{l.name}</span>
                      {l.breakerTripped && <Badge tone="red">Paused: bounces</Badge>}
                    </div>
                  </td>
                  <td className="text-ink-500" title={date(l.createdAt)}>
                    {ago(l.createdAt)}
                  </td>
                  <td className="text-right tabular-nums">{num(l.total)}</td>
                  <td className="text-right font-medium text-emerald-700 tabular-nums">{l.status === "done" ? num(l.counts.ready ?? 0) : "–"}</td>
                  <td className="text-right tabular-nums">{l.status === "done" ? num(l.counts.catch_all ?? 0) : "–"}</td>
                  <td className="text-right text-ink-500 tabular-nums">{l.status === "done" ? num(removedCount(l.counts)) : "–"}</td>
                  <td className="w-56">
                    <ImportStatus l={l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      <SuppressionSection />
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={(id) => navigate(`/lists/${id}`)} />
    </div>
  );
}

export function ImportStatus({ l }: { l: ListImport }) {
  if (l.status === "failed")
    return (
      <Badge tone="red" title={l.error ?? undefined}>
        Failed
      </Badge>
    );
  if (l.status === "done")
    return l.stage.startsWith("Done (") ? (
      <Badge tone="amber" title={l.stage}>
        Done, unvalidated
      </Badge>
    ) : (
      <Badge tone="green" dot>
        Clean
      </Badge>
    );
  const validating = l.stage.startsWith("Validating");
  return (
    <div className="space-y-1">
      <p className="truncate text-xs text-ink-600">{l.stage}…</p>
      <Progress value={validating ? l.processed : 0} max={validating ? Math.max(1, Number(l.stage.replace(/\D/g, "")) || l.total) : 1} />
    </div>
  );
}

function PipelineExplainer() {
  const steps = [
    { title: "Free checks first", body: "Syntax, duplicates, your suppression list and MX lookups. No credits spent." },
    { title: "Gateways removed", body: "Prospects behind Proofpoint, Mimecast or Barracuda filter cold email hard, so they're pulled out (exportable)." },
    { title: "Validate the rest", body: "Only survivors hit your validation provider. Results are cached for 30 days." },
    { title: "Catch-alls separated", body: "Catch-all addresses go to their own segment and mailbox pool, so their bounces can't hurt your main domains." },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((s, i) => (
        <div key={s.title} className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700">{i + 1}</span>
            <p className="text-sm font-medium text-ink-900">{s.title}</p>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{s.body}</p>
        </div>
      ))}
    </div>
  );
}

const FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Ignore (keep as custom field)" },
  { value: "email", label: "Email" },
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "company", label: "Company" },
  { value: "title", label: "Title" },
  { value: "timezone", label: "Timezone" },
  { value: "country", label: "Country" },
  { value: "state", label: "State / region" },
  { value: "segment", label: "Segment" },
  { value: "website", label: "Website" },
];

const SEGMENT_PRESETS = [
  { value: "smb", label: "SMB" },
  { value: "mid_market", label: "Mid-market" },
  { value: "enterprise", label: "Enterprise" },
];

function UploadModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [segments, setSegments] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const preview = useMemo(() => (csv ? parseCsvPreview(csv, 5) : null), [csv]);

  const reset = () => {
    setCsv("");
    setFileName("");
    setName("");
    setSegments([]);
    setMapping({});
    setReadError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const load = (file: File) => {
    setReadError(null);
    if (!/\.(csv|txt)$/i.test(file.name) && file.type !== "text/csv") {
      setReadError("Upload a .csv file (export from your sheet or CRM as CSV).");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setReadError("That file is over 50 MB. Split it into smaller lists.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const p = parseCsvPreview(text, 5);
      setCsv(text);
      setFileName(file.name);
      setName((n) => n || file.name.replace(/\.(csv|txt)$/i, ""));
      setMapping(guessColumnMapping(p.headers));
    };
    reader.onerror = () => setReadError("Couldn't read that file.");
    reader.readAsText(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) load(f);
  };

  const hasEmail = Object.values(mapping).includes("email");
  const upload = useAction(() => post<{ id: string }>("/lists", { name: name.trim() || "Import", csv, mapping, segments }), {
    invalidate: ["/lists"],
    success: "List uploaded. Cleaning it now.",
    onSuccess: (r) => {
      close();
      onDone(r.id);
    },
  });

  const toggleSeg = (s: string) => setSegments((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="Upload a list"
      description="CSV with one prospect per row. Only an email column is required."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!csv || !hasEmail} loading={upload.isPending} onClick={() => upload.mutate()}>
            Upload and clean {preview ? num(preview.rowCount) : ""} rows
          </Button>
        </>
      }
    >
      {!csv ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={clsx(
            "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging ? "border-brand-400 bg-brand-50" : "border-ink-200 hover:border-brand-300 hover:bg-ink-50",
          )}
        >
          <Upload className="size-8 text-brand-500" />
          <p className="mt-3 text-sm font-medium text-ink-800">Drop a CSV here, or click to choose</p>
          <p className="mt-1 text-xs text-ink-500">Up to 200,000 rows. Columns like email, first name, company, title and state are detected automatically.</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) load(f);
              e.target.value = "";
            }}
          />
          {readError && <p className="mt-3 text-sm text-red-600">{readError}</p>}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-50 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 text-ink-700">
              <FileSpreadsheet className="size-4 text-ink-400" />
              <span className="font-medium">{fileName}</span>
              <span className="text-ink-500">· {num(preview?.rowCount ?? 0)} rows</span>
            </span>
            <button className="text-sm font-medium text-brand-600 hover:underline" onClick={reset}>
              Choose another file
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="List name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Segment tags" hint="Applied to every row. A segment column in the file adds more.">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SEGMENT_PRESETS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => toggleSeg(s.value)}
                    className={clsx(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      segments.includes(s.value) ? "border-brand-300 bg-brand-50 text-brand-700" : "border-ink-200 text-ink-600 hover:bg-ink-50",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-ink-800">Columns</p>
              {!hasEmail && <span className="text-xs font-medium text-red-600">Map one column to Email to continue</span>}
            </div>
            <div className="overflow-x-auto rounded-lg border border-ink-200">
              <table className="tbl">
                <thead>
                  <tr>
                    {preview?.headers.map((h) => (
                      <th key={h} className="min-w-44 normal-case">
                        <div className="mb-1.5 truncate font-mono text-[11px] text-ink-500">{h}</div>
                        <Select
                          className="h-8 py-1 text-xs font-normal tracking-normal normal-case"
                          value={mapping[h] ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setMapping((m) => {
                              const next = { ...m };
                              for (const k of Object.keys(next)) if (v && next[k] === v) delete next[k];
                              if (v) next[h] = v;
                              else delete next[h];
                              return next;
                            });
                          }}
                        >
                          {FIELD_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview?.rows.map((r, i) => (
                    <tr key={i}>
                      {preview.headers.map((h, j) => (
                        <td key={h} className={clsx("max-w-56 truncate text-xs", mapping[h] ? "text-ink-800" : "text-ink-400")}>
                          {r[j] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Callout tone="blue">
            After upload Cold checks MX records, removes suppressed and gateway-protected prospects, then validates only what's left. You'll get a full hygiene report.
          </Callout>
        </div>
      )}
    </Modal>
  );
}

interface Suppression {
  id: string;
  email: string | null;
  domain: string | null;
  reason: string;
  source: string | null;
  createdAt: string;
}

const REASON: Record<string, { label: string; tone: "red" | "gray" | "amber" | "blue" | "violet" }> = {
  opt_out: { label: "Opt-out", tone: "red" },
  hard_bounce: { label: "Hard bounce", tone: "amber" },
  complaint: { label: "Complaint", tone: "red" },
  do_not_contact: { label: "Do not contact", tone: "gray" },
  customer: { label: "Customer", tone: "blue" },
  manual: { label: "Manual", tone: "gray" },
};

function SuppressionSection() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState("");
  const [reason, setReason] = useState("do_not_contact");
  const [search, setSearch] = useState("");
  const list = useGet<Suppression[]>("/suppressions");
  const add = useAction(
    () =>
      post<{ added: number }>("/suppressions", {
        entries: entries
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        reason,
      }),
    {
      invalidate: ["/suppressions", "/lists", "/prospects"],
      success: (r) => `${num(r.added)} entries suppressed across every domain`,
      onSuccess: () => {
        setOpen(false);
        setEntries("");
      },
    },
  );
  const remove = useAction((id: string) => del(`/suppressions/${id}`), { invalidate: ["/suppressions"], success: "Removed from suppression list" });
  const rows = (list.data ?? []).filter((s) => !search || (s.email ?? s.domain ?? "").includes(search.toLowerCase()));
  const counts = (list.data ?? []).reduce<Record<string, number>>((a, s) => ((a[s.reason] = (a[s.reason] ?? 0) + 1), a), {});

  return (
    <Card
      className="mt-8"
      padded={false}
      title="Suppression list"
      subtitle="Opt-outs, hard bounces and do-not-contact entries apply to every domain you own, including domains you rotate in later."
      actions={
        <Button size="sm" icon={<ShieldOff className="size-4" />} onClick={() => setOpen(true)}>
          Add entries
        </Button>
      }
    >
      {list.isLoading ? (
        <Loading />
      ) : !list.data?.length ? (
        <EmptyState icon={<ShieldOff className="size-6" />} title="Nobody suppressed yet">
          Opt-outs and hard bounces land here automatically. Add customers, partners or competitors so they're never cold-emailed.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-5 py-3">
            <div className="relative w-64">
              <Filter className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an email or domain" className="h-9 pl-8" />
            </div>
            {Object.entries(counts).map(([r, n]) => (
              <Badge key={r} tone={REASON[r]?.tone ?? "gray"}>
                {REASON[r]?.label ?? r} · {num(n)}
              </Badge>
            ))}
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Email or domain</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono text-[13px]">{s.email ?? `@${s.domain}`}</td>
                    <td>
                      <Badge tone={REASON[s.reason]?.tone ?? "gray"}>{REASON[s.reason]?.label ?? s.reason}</Badge>
                    </td>
                    <td className="max-w-64 truncate text-ink-500">{s.source ?? "–"}</td>
                    <td className="text-ink-500">{ago(s.createdAt)}</td>
                    <td className="text-right">
                      {s.reason !== "opt_out" && (
                        <button className="rounded-md p-1 text-ink-400 hover:bg-red-50 hover:text-red-600" title="Remove (owners only)" onClick={() => remove.mutate(s.id)}>
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Suppress emails or domains"
        description="One per line. Use a bare domain (acme.com) to block a whole company."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!entries.trim()} loading={add.isPending} onClick={() => add.mutate()}>
              Suppress
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Entries">
            <Textarea value={entries} onChange={(e) => setEntries(e.target.value)} className="min-h-36 font-mono text-[13px]" placeholder={"jane@customer.com\ncompetitor.com"} autoFocus />
          </Field>
          <Field label="Reason">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="do_not_contact">Do not contact</option>
              <option value="customer">Existing customer</option>
              <option value="manual">Other</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
