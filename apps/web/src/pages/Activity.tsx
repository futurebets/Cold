import { useState } from "react";
import { SKIP_REASON_TEXT } from "@cold/core";
import { useGet } from "../lib/api";
import { dateTime } from "../lib/format";
import { Badge, Card, EmptyState, ErrorState, Loading, PageHeader, Segmented, TableCard } from "../components/ui";

const STATUS_TONE: Record<string, "green" | "gray" | "amber" | "red" | "blue"> = { sent: "green", scheduled: "blue", sending: "blue", skipped: "amber", failed: "red" };
const KIND: Record<string, string> = { first_touch: "First email", follow_up: "Follow-up", seed: "Seed test", header_test: "Header test" };

export default function ActivityPage() {
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const qs = new URLSearchParams({ ...(status !== "all" ? { status } : {}), ...(kind !== "all" ? { kind } : {}), limit: "300" }).toString();
  const q = useGet<any[]>(`/sends?${qs}`, { refetchInterval: 20_000 });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Send log"
        rules={[4, 11]}
        description="Every email passes a pre-flight guard just before it goes out: caps, authentication, warmup, validation, suppression, copy. Anything that fails is skipped with the reason shown here."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "scheduled", label: "Scheduled" },
            { value: "sent", label: "Sent" },
            { value: "skipped", label: "Skipped" },
            { value: "failed", label: "Failed" },
          ]}
        />
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All kinds" },
            { value: "first_touch", label: "First emails" },
            { value: "follow_up", label: "Follow-ups" },
            { value: "seed", label: "Seed tests" },
          ]}
        />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState title="Nothing here yet">Sends appear once a campaign is live and domains are active.</EmptyState>
        </Card>
      ) : (
        <TableCard>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-ink-500">{dateTime(s.sentAt ?? s.scheduledAt)}</td>
                  <td className="mono text-xs">{s.from}</td>
                  <td>
                    <p className="mono text-xs">{s.to}</p>
                    {s.company && <p className="text-xs text-ink-500">{s.company}</p>}
                  </td>
                  <td className="text-ink-600">{KIND[s.kind] ?? s.kind}</td>
                  <td>
                    <Badge tone={STATUS_TONE[s.status] ?? "gray"}>{s.status}</Badge>
                  </td>
                  <td className="max-w-sm text-xs">
                    {s.status === "skipped" && (s.skipReasons ?? []).map((r: string) => <p key={r} className="text-amber-800">{(SKIP_REASON_TEXT as Record<string, string>)[r] ?? r}</p>)}
                    {s.status === "failed" && <p className="text-red-700">{s.error}</p>}
                    {s.replyKind === "human" && <Badge tone="green">Replied</Badge>}
                    {s.replyKind === "auto" && <Badge tone="gray">Auto-reply</Badge>}
                    {s.bounceType && (
                      <Badge tone="red">
                        {s.bounceType} bounce{s.bounceCategory ? ` · ${s.bounceCategory.replace(/_/g, " ")}` : ""}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}
