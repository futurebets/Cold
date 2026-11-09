import { useState } from "react";
import { Plug, Plus, PenLine } from "lucide-react";
import { DEFAULT_POLICIES, maxMailboxesPerDomain } from "@cold/core";
import { patch, post, useAction } from "../../lib/api";
import { plural } from "../../lib/format";
import { Badge, Button, Callout, Card, Field, Modal, RuleTag, Textarea, Toggle } from "../ui";
import { parsePersonas } from "./AddDomainsWizard";
import type { DomainDetail, MailboxRow } from "./types";

function ConnectionBadge({ m }: { m: MailboxRow }) {
  if (m.connection === "connected") return <Badge tone="green" dot title={m.connectionDetail ?? undefined}>Connected</Badge>;
  if (m.connection === "disconnected") return <Badge tone="red" dot title={m.connectionDetail ?? undefined}>Disconnected</Badge>;
  return <Badge tone="gray" dot>Not tested</Badge>;
}

export function MailboxesCard({ detail, policies = DEFAULT_POLICIES }: { detail: DomainDetail; policies?: typeof DEFAULT_POLICIES }) {
  const d = detail.domain;
  const live = detail.mailboxes.filter((m) => m.state !== "decommissioned");
  const max = maxMailboxesPerDomain(d.provider, policies);
  const [adding, setAdding] = useState(false);
  const [personasText, setPersonasText] = useState("");
  const [sig, setSig] = useState<{ id: string; address: string; value: string } | null>(null);
  const [testResults, setTestResults] = useState<{ address: string; ok: boolean; detail: string }[] | null>(null);
  const inv = ["/domains", "/mailboxes", "/reserve"];

  const personas = parsePersonas(personasText);
  const add = useAction(() => post(`/domains/${d.id}/mailboxes`, { personas }), {
    invalidate: inv,
    success: `Added ${plural(personas.length, "mailbox", "mailboxes")}`,
    onSuccess: () => {
      setAdding(false);
      setPersonasText("");
    },
  });
  const test = useAction(() => post<{ address: string; ok: boolean; detail: string }[]>(`/domains/${d.id}/test-mailboxes`), {
    invalidate: inv,
    success: (r) => `${r.filter((x) => x.ok).length} of ${r.length} connected`,
    onSuccess: setTestResults,
  });
  const update = useAction((v: { id: string; body: Record<string, unknown> }) => patch(`/mailboxes/${v.id}`, v.body), { invalidate: inv, success: "Saved" });
  const sigHasLink = !!sig && /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app)\b/i.test(sig.value);
  const sigLines = sig ? sig.value.split("\n").filter((l) => l.trim()).length : 0;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Mailboxes <RuleTag n={4} />
        </span>
      }
      subtitle={`${live.length} of ${max} allowed on a ${d.provider === "google" ? "Google" : "Microsoft"} domain · ${detail.capacity}/day combined`}
      actions={
        <>
          <Button size="sm" icon={<Plug className="size-4" />} loading={test.isPending} disabled={!live.length} onClick={() => test.mutate()}>
            Test connections
          </Button>
          <Button size="sm" icon={<Plus className="size-4" />} disabled={live.length >= max || d.state === "retired"} onClick={() => setAdding(true)}>
            Add mailboxes
          </Button>
        </>
      }
      padded={false}
    >
      {!detail.tenant && live.length > 0 && (
        <div className="p-5 pb-0">
          <Callout tone="amber" title="No tenant attached">
            Pick the Google Workspace or Microsoft 365 tenant these mailboxes live in under Settings on this page, then test connections.
          </Callout>
        </div>
      )}
      {testResults && testResults.some((r) => !r.ok) && (
        <div className="p-5 pb-0">
          <Callout tone="red" title="Some mailboxes couldn't connect">
            {testResults
              .filter((r) => !r.ok)
              .slice(0, 4)
              .map((r) => (
                <p key={r.address}>
                  <span className="mono">{r.address}</span>: {r.detail}
                </p>
              ))}
          </Callout>
        </div>
      )}
      {live.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-500">No mailboxes yet. Add the people who will send from this domain.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Address</th>
                <th>Connection</th>
                <th>Warmup</th>
                <th>Signature</th>
                <th title="Seed inboxes receive header tests and diagnosis placement tests">Seed</th>
              </tr>
            </thead>
            <tbody>
              {live.map((m) => (
                <tr key={m.id}>
                  <td>
                    <p className="mono text-[13px] text-ink-900">{m.address}</p>
                    <p className="text-xs text-ink-500">
                      {[m.firstName, m.lastName].filter(Boolean).join(" ")} · {m.state}
                    </p>
                  </td>
                  <td>
                    <ConnectionBadge m={m} />
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {m.warmup.level === "not_started" ? (
                      <span className="text-ink-400">Not started</span>
                    ) : (
                      <span className={m.warmup.ready ? "text-emerald-700" : "text-violet-700"}>
                        {m.warmup.days}d {m.warmup.ready ? "· warm" : `· ${m.warmup.daysLeft}d left`}
                      </span>
                    )}
                    {m.warmupInboxRate != null && <p className="text-ink-400">{Math.round(m.warmupInboxRate * 100)}% inbox</p>}
                  </td>
                  <td className="max-w-56">
                    <button className="group flex items-start gap-1.5 text-left" onClick={() => setSig({ id: m.id, address: m.address, value: m.signature })}>
                      <span className="line-clamp-2 text-xs whitespace-pre-line text-ink-600">{m.signature || "No signature"}</span>
                      <PenLine className="mt-0.5 size-3 shrink-0 text-ink-300 group-hover:text-brand-600" />
                    </button>
                  </td>
                  <td>
                    <Toggle checked={m.isSeed} onChange={(v) => update.mutate({ id: m.id, body: { isSeed: v } })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add mailboxes to ${d.name}`}
        description={`Room for ${max - live.length} more.`}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!personas.length || live.length + personas.length > max} loading={add.isPending} onClick={() => add.mutate()}>
              Add {plural(personas.length, "mailbox", "mailboxes")}
            </Button>
          </>
        }
      >
        <Field
          label="People"
          hint={`One per line: "First Last". Addresses become first.last@${d.name}.`}
          error={live.length + personas.length > max ? `This domain holds at most ${max} mailboxes.` : undefined}
        >
          <Textarea value={personasText} onChange={(e) => setPersonasText(e.target.value)} placeholder={"Jane Doe\nSam Lee"} className="min-h-32" autoFocus />
        </Field>
      </Modal>

      <Modal
        open={!!sig}
        onClose={() => setSig(null)}
        title="Signature"
        description={sig?.address}
        footer={
          <>
            <Button onClick={() => setSig(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={sigHasLink}
              loading={update.isPending}
              onClick={() => {
                if (sig) update.mutate({ id: sig.id, body: { signature: sig.value } });
                setSig(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        {sig && (
          <div className="space-y-3">
            <Field label="Plain text" error={sigHasLink ? "Signatures can't contain links or domains (rule 9)." : sigLines > 3 ? "Keep it to 3 lines. Long signatures look like marketing." : undefined}>
              <Textarea value={sig.value} onChange={(e) => setSig({ ...sig, value: e.target.value })} className="min-h-24" autoFocus />
            </Field>
            <p className="text-xs text-ink-500">Name, title and company are enough. No logos, links or phone banners. Your postal address is added automatically for US campaigns.</p>
          </div>
        )}
      </Modal>
    </Card>
  );
}
