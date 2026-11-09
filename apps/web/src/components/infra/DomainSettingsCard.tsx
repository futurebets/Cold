import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { DEFAULT_POLICIES } from "@cold/core";
import { patch, post, useAction, useGet } from "../../lib/api";
import { Button, Card, ConfirmButton, Field, Input, RuleTag, Segmented, Select, Textarea } from "../ui";
import type { DomainDetail, Integrations, SettingsResponse } from "./types";

export function DomainSettingsCard({ detail, policies = DEFAULT_POLICIES }: { detail: DomainDetail; policies?: typeof DEFAULT_POLICIES }) {
  const d = detail.domain;
  const integrations = useGet<Integrations>("/integrations");
  const settings = useGet<SettingsResponse>("/settings");
  const isOwner = settings.data?.role === "owner";
  const tenants = (integrations.data?.tenants ?? []).filter((t) => t.provider === d.provider);
  const playbookCap = d.provider === "google" ? policies.caps.google.perDomainDaily : policies.caps.microsoft.perDomainDaily;
  const inv = ["/domains", "/reserve", "/mailboxes"];
  const outgoing = ["retired", "relay", "layover"].includes(d.state);

  const [form, setForm] = useState({ registrar: d.registrar ?? "", expiresAt: d.expiresAt?.slice(0, 10) ?? "", notes: d.notes ?? "", cap: d.capOverride?.toString() ?? "", capReason: "" });
  useEffect(() => {
    setForm({ registrar: d.registrar ?? "", expiresAt: d.expiresAt?.slice(0, 10) ?? "", notes: d.notes ?? "", cap: d.capOverride?.toString() ?? "", capReason: "" });
  }, [d.id, d.registrar, d.expiresAt, d.notes, d.capOverride]);

  const save = useAction((body: Record<string, unknown>) => patch(`/domains/${d.id}`, body), { invalidate: inv, success: "Saved" });
  const setPool = useAction((pool: "active" | "reserve") => post(`/domains/${d.id}/pool`, { pool }), {
    invalidate: inv,
    success: (_r) => "Set updated",
  });
  const retire = useAction((reason: string) => post(`/domains/${d.id}/retire`, { reason }), { invalidate: inv, success: "Domain retired. Its conversations are kept." });

  const capNum = form.cap.trim() === "" ? null : Number(form.cap);
  const aboveCap = capNum != null && capNum > playbookCap;
  const dirty =
    form.registrar !== (d.registrar ?? "") || form.expiresAt !== (d.expiresAt?.slice(0, 10) ?? "") || form.notes !== (d.notes ?? "") || (capNum ?? null) !== (d.capOverride ?? null);

  return (
    <Card title="Settings">
      <div className="space-y-5">
        <Field label="Tenant" hint="Where these mailboxes live. Changing it re-tests every mailbox.">
          <Select value={d.tenantId ?? ""} onChange={(e) => save.mutate({ tenantId: e.target.value || null })} disabled={outgoing}>
            <option value="">None</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.transport === "simulated" && !/simulated/i.test(t.name) ? " (simulated)" : ""}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="label mb-0">Set</span>
            <RuleTag n={7} />
          </div>
          <Segmented
            value={d.pool === "retired" ? "reserve" : d.pool}
            onChange={(v) => !outgoing && v !== d.pool && setPool.mutate(v)}
            options={[
              { value: "active", label: "Active" },
              { value: "reserve", label: "Reserve" },
            ]}
          />
          <p className="mt-1.5 text-xs text-ink-500">
            {outgoing
              ? "This domain has been rotated out."
              : d.pool === "active"
                ? "Sends once warm. Moving it to reserve stops cold sending and keeps it warm as a replacement."
                : "Warms quietly as a replacement. Move to active to start sending once it's ready."}
          </p>
        </div>

        <Field label="Bought through">
          <Select value={d.vendor} onChange={(e) => save.mutate({ vendor: e.target.value })}>
            <option value="hypertide">Hypertide</option>
            <option value="direct">Direct</option>
            <option value="other">Other reseller</option>
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Registrar">
            <Input value={form.registrar} onChange={(e) => setForm({ ...form, registrar: e.target.value })} placeholder="Porkbun" />
          </Field>
          <Field label="Expires">
            <Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
        </div>

        <Field
          label={
            <span className="flex items-center gap-2">
              Daily cap override <RuleTag n={4} />
            </span>
          }
          hint={isOwner ? `Playbook cap is ${playbookCap}/day. Lowering is always fine; raising it needs a reason and marks the domain off-playbook.` : `Playbook cap is ${playbookCap}/day. Only owners can change it.`}
        >
          <Input type="number" min={0} value={form.cap} disabled={!isOwner} onChange={(e) => setForm({ ...form, cap: e.target.value })} placeholder={`${playbookCap} (playbook default)`} />
        </Field>
        {aboveCap && (
          <Field label="Why go above the playbook cap?" error={!form.capReason.trim() ? "A reason is required" : undefined}>
            <Input value={form.capReason} onChange={(e) => setForm({ ...form, capReason: e.target.value })} />
          </Field>
        )}

        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-16" />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-4">
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || (aboveCap && !form.capReason.trim())}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                registrar: form.registrar || null,
                expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
                notes: form.notes || null,
                ...((capNum ?? null) !== (d.capOverride ?? null) ? { capOverride: capNum, capReason: form.capReason || undefined } : {}),
              })
            }
          >
            Save changes
          </Button>
          {d.state !== "retired" && (
            <ConfirmButton
              size="sm"
              variant="ghost"
              icon={<Archive className="size-4" />}
              title={`Retire ${d.name}?`}
              body="It stops sending and syncing. Conversation history stays in Cold. To replace a burned domain without a gap, use a diagnosis and rotation instead."
              requireReason="Reason"
              confirmLabel="Retire domain"
              confirmVariant="danger"
              loading={retire.isPending}
              onConfirm={(reason) => retire.mutate(reason ?? "Retired manually")}
            >
              Retire
            </ConfirmButton>
          )}
        </div>
      </div>
    </Card>
  );
}
