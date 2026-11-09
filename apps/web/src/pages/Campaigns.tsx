import { useState } from "react";
import { useNavigate } from "react-router";
import clsx from "clsx";
import { Megaphone, Plus } from "lucide-react";
import { post, useAction, useGet } from "../lib/api";
import { ago, num, pct } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, TableCard, type Tone } from "../components/ui";

export interface CampaignSummary {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  isCatchAll: boolean;
  jurisdiction: string;
  enrolled: number;
  activeEnrollments: number;
  replied: number;
  sent: number;
  replies: number;
  bounces: number;
  scheduled: number;
  launchedAt: string | null;
  createdAt: string;
}

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "gray" },
  active: { label: "Sending", tone: "green" },
  paused: { label: "Paused", tone: "amber" },
  completed: { label: "Completed", tone: "gray" },
};

export const JURISDICTIONS = [
  { value: "us", label: "United States (CAN-SPAM)", help: "Reply-based opt-out line in every email and your postal address in the signature." },
  { value: "eu_uk", label: "EU / UK (GDPR, PECR)", help: "Reply-based opt-out line in every email. Check your legitimate-interest basis with counsel." },
  { value: "ca", label: "Canada (CASL)", help: "Reply-based opt-out line in every email. CASL is strict about consent; check with counsel." },
  { value: "none", label: "None", help: "No jurisdiction-specific checks." },
];

export default function CampaignsPage() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const list = useGet<CampaignSummary[]>("/campaigns", { refetchInterval: 60_000 });

  return (
    <div>
      <PageHeader
        title="Campaigns"
        rules={[9, 10, 11]}
        description="Short, plain-text sequences sent in business hours from staggered inboxes. Cold tracks replies and bounces, never opens."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New campaign
          </Button>
        }
      />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState
            icon={<Megaphone className="size-6" />}
            title="No campaigns yet"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                Create a campaign
              </Button>
            }
          >
            Cold starts you with a three-step plain-text sequence you can edit, with live checks for links, formatting, length and CTA.
          </EmptyState>
        </Card>
      ) : (
        <TableCard>
          <table className="tbl">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th className="text-right">Enrolled</th>
                <th className="text-right">In sequence</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Reply rate</th>
                <th className="text-right">Bounce rate</th>
                <th className="text-right">Queued today</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => {
                const rr = c.sent ? c.replies / c.sent : null;
                const br = c.sent ? c.bounces / c.sent : null;
                return (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink-900">{c.name}</span>
                        {c.isCatchAll && <Badge tone="sky">Catch-all</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">{c.launchedAt ? `Launched ${ago(c.launchedAt)}` : `Created ${ago(c.createdAt)}`}</p>
                    </td>
                    <td>
                      <Badge tone={CAMPAIGN_STATUS[c.status]?.tone ?? "gray"} dot>
                        {CAMPAIGN_STATUS[c.status]?.label ?? c.status}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{num(c.enrolled)}</td>
                    <td className="text-right tabular-nums">{num(c.activeEnrollments)}</td>
                    <td className="text-right tabular-nums">{num(c.sent)}</td>
                    <td className={clsx("text-right tabular-nums", rr != null && c.sent >= 200 && rr < 0.01 && "font-medium text-red-600")}>{pct(rr)}</td>
                    <td className={clsx("text-right tabular-nums", br != null && c.sent >= 200 && br > 0.03 && "font-medium text-red-600")}>{pct(br)}</td>
                    <td className="text-right text-ink-500 tabular-nums">{num(c.scheduled)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}
      <NewCampaignModal open={open} onClose={() => setOpen(false)} onCreated={(id) => navigate(`/campaigns/${id}`)} />
    </div>
  );
}

function NewCampaignModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [catchAll, setCatchAll] = useState(false);
  const [jurisdiction, setJurisdiction] = useState("us");
  const create = useAction(() => post<{ id: string }>("/campaigns", { name: name.trim(), isCatchAll: catchAll, jurisdiction }), {
    invalidate: ["/campaigns"],
    success: "Campaign created with a starter sequence",
    onSuccess: (c) => {
      onClose();
      setName("");
      onCreated(c.id);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create and write copy
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q1 – Ops leaders, US SMB" autoFocus />
        </Field>
        <div>
          <p className="label">Audience</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { v: false, title: "Validated prospects", body: "Addresses confirmed by validation. Sends from your main mailbox pool." },
              { v: true, title: "Catch-all prospects", body: "Domains that accept every address. Sends from a separate catch-all pool so bounces stay contained." },
            ].map((o) => (
              <button
                key={String(o.v)}
                type="button"
                onClick={() => setCatchAll(o.v)}
                className={clsx("rounded-xl border p-3 text-left transition-colors", catchAll === o.v ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:bg-ink-50")}
              >
                <p className="text-sm font-medium text-ink-900">{o.title}</p>
                <p className="mt-0.5 text-xs text-ink-500">{o.body}</p>
              </button>
            ))}
          </div>
        </div>
        <Field label="Compliance" hint={JURISDICTIONS.find((j) => j.value === jurisdiction)?.help}>
          <Select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
            {JURISDICTIONS.map((j) => (
              <option key={j.value} value={j.value}>
                {j.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
