import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CheckCircle2, Circle, Lock, Pause, Play, Plus, RefreshCw, Trash2, UserPlus, XCircle } from "lucide-react";
import { lintCopy, type LintFinding, type LintResult, type Policies } from "@cold/core";
import { ApiError, del, post, put, useAction, useGet } from "../lib/api";
import { num, pct } from "../lib/format";
import { useToast } from "../components/toast";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  RuleTag,
  Select,
  Spinner,
  Tabs,
  TableCard,
  Textarea,
  Toggle,
} from "../components/ui";
import { LintTextarea, ScoreRing } from "../components/outreach/LintEditor";
import { CAMPAIGN_STATUS, JURISDICTIONS } from "./Campaigns";

interface Variant {
  id: string;
  stepId: string;
  label: string;
  subject: string;
  body: string;
  standaloneBody: string | null;
  active: boolean;
  pausedReason: string | null;
  acknowledgedWarnings: string[];
  lint: LintResult;
}
interface Step {
  id: string;
  position: number;
  delayDays: number;
  variants: Variant[];
}
interface Campaign {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  isCatchAll: boolean;
  jurisdiction: "none" | "us" | "eu_uk" | "ca";
  poolId: string | null;
  schedule: { days: number[]; startHour: number; endHour: number; defaultTimezone: string; saturday: boolean; saturdayTestShare: number };
}
interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail?: string;
  href?: string;
}
interface Detail {
  campaign: Campaign;
  steps: Step[];
  checklist: ChecklistItem[];
}

interface LintCtx {
  jurisdiction: Campaign["jurisdiction"];
  postalAddressConfigured: boolean;
  policies?: Policies;
}

export default function CampaignEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const detail = useGet<Detail>(`/campaigns/${id}`);
  const settings = useGet<any>("/settings");
  const policies = useGet<any>("/policies");
  const [tab, setTab] = useState<"sequence" | "settings" | "stats">("sequence");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [launchFailures, setLaunchFailures] = useState<ChecklistItem[] | null>(null);

  const launch = useAction(() => post(`/campaigns/${id}/launch`), {
    invalidate: [`/campaigns`],
    success: "Campaign launched. Sends are planned in each recipient's business hours.",
    onSuccess: () => setLaunchFailures(null),
    onError: (e: ApiError) => {
      const list = (e.details?.checklist as ChecklistItem[] | undefined)?.filter((i) => i.blocking && !i.ok);
      setLaunchFailures(list ?? null);
      toast.show({ tone: "error", title: "Not ready to launch", body: list?.map((i) => i.label).join(" · ") ?? e.message });
    },
  });
  const pause = useAction(() => post(`/campaigns/${id}/pause`), { invalidate: ["/campaigns"], success: "Campaign paused. Queued sends were cancelled." });
  const remove = useAction(() => del(`/campaigns/${id}`), { invalidate: ["/campaigns"], success: "Campaign deleted", onSuccess: () => navigate("/campaigns") });

  if (detail.isLoading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} />;
  const { campaign, steps, checklist } = detail.data;
  const ctx: LintCtx = {
    jurisdiction: campaign.jurisdiction,
    postalAddressConfigured: !!settings.data?.workspace?.settings?.postalAddress?.trim(),
    policies: policies.data?.effective,
  };
  const activePreview = previewId ?? steps[0]?.variants.find((v) => v.active)?.id ?? steps[0]?.variants[0]?.id ?? null;
  const st = CAMPAIGN_STATUS[campaign.status];

  return (
    <div>
      <PageHeader
        back={{ to: "/campaigns", label: "Campaigns" }}
        title={
          <span className="flex items-center gap-2">
            {campaign.name}
            <Badge tone={st?.tone ?? "gray"} dot>
              {st?.label ?? campaign.status}
            </Badge>
            {campaign.isCatchAll && <Badge tone="sky">Catch-all</Badge>}
          </span>
        }
        description={JURISDICTIONS.find((j) => j.value === campaign.jurisdiction)?.label}
        actions={
          <>
            <Button icon={<UserPlus className="size-4" />} onClick={() => setEnrollOpen(true)}>
              Enroll prospects
            </Button>
            {campaign.status === "active" ? (
              <Button icon={<Pause className="size-4" />} loading={pause.isPending} onClick={() => pause.mutate()}>
                Pause
              </Button>
            ) : (
              <Button variant="primary" icon={<Play className="size-4" />} loading={launch.isPending} onClick={() => launch.mutate()}>
                {campaign.status === "paused" ? "Resume" : "Launch"}
              </Button>
            )}
            {campaign.status !== "active" && (
              <ConfirmButton
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                title="Delete this campaign?"
                body="Only campaigns that never sent can be deleted. Sent campaigns keep their history; pause them instead."
                confirmVariant="danger"
                confirmLabel="Delete"
                onConfirm={() => remove.mutate()}
              >
                Delete
              </ConfirmButton>
            )}
          </>
        }
      />

      {launchFailures && launchFailures.length > 0 && (
        <Callout tone="red" title="Fix these before launching" className="mb-5">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {launchFailures.map((f) => (
              <li key={f.id}>
                {f.label}
                {f.detail ? `: ${f.detail}` : ""}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "sequence", label: "Sequence" },
          { value: "settings", label: "Schedule & settings" },
          { value: "stats", label: "Results" },
        ]}
      />

      {tab === "sequence" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <Callout tone="blue" title="Write it like a note to one person">
              Short, plain text, no links, images or formatting, a simple offer and a soft question at the end. Cold checks every keystroke and blocks launch on anything that hurts deliverability. <RuleTag n={9} />
            </Callout>
            {steps.map((s) => (
              <StepCard key={s.id} step={s} campaignId={campaign.id} ctx={ctx} onPreview={setPreviewId} />
            ))}
            <AddStepButton campaignId={campaign.id} disabled={steps.length >= 6} />
          </div>
          <aside className="space-y-5 lg:sticky lg:top-4 lg:self-start">
            <ChecklistCard items={checklist} status={campaign.status} onLaunch={() => launch.mutate()} launching={launch.isPending} />
            <PreviewCard variantId={activePreview} />
          </aside>
        </div>
      )}
      {tab === "settings" && <SettingsTab campaign={campaign} />}
      {tab === "stats" && <StatsTab campaignId={campaign.id} steps={steps} />}

      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} campaign={campaign} />
    </div>
  );
}

// ───────────────────────── Sequence ─────────────────────────

function StepCard({ step, campaignId, ctx, onPreview }: { step: Step; campaignId: string; ctx: LintCtx; onPreview: (id: string) => void }) {
  const [selected, setSelected] = useState(step.variants[0]?.id);
  const [delay, setDelay] = useState(step.delayDays);
  useEffect(() => setDelay(step.delayDays), [step.delayDays]);
  const variant = step.variants.find((v) => v.id === selected) ?? step.variants[0];
  const saveDelay = useAction((d: number) => put(`/steps/${step.id}`, { delayDays: d }), { invalidate: [`/campaigns/${campaignId}`] });
  const addVariant = useAction(() => post<{ id: string }>(`/steps/${step.id}/variants`), {
    invalidate: [`/campaigns/${campaignId}`],
    success: "Variant added. Cold splits the step's sends evenly across active variants.",
    onSuccess: (v) => setSelected(v.id),
  });
  const removeVariant = useAction((vid: string) => del(`/variants/${vid}`), { invalidate: [`/campaigns/${campaignId}`], success: "Variant removed", onSuccess: () => setSelected(step.variants[0]?.id) });
  const removeStep = useAction(() => del(`/steps/${step.id}`), { invalidate: [`/campaigns/${campaignId}`], success: "Step removed" });
  const first = step.position === 0;

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-7 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{step.position + 1}</span>
          <div>
            <p className="text-sm font-semibold text-ink-900">{first ? "First email" : `Follow-up ${step.position}`}</p>
            {first ? (
              <p className="text-xs text-ink-500">Sent on the first available business-hours slot</p>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-ink-500">
                Wait
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  onBlur={() => delay !== step.delayDays && delay >= 1 && delay <= 30 && saveDelay.mutate(delay)}
                  className="h-6 w-12 rounded-md border border-ink-200 px-1.5 text-center text-xs text-ink-800 focus:border-brand-400 focus:outline-none"
                />
                business days, then reply in the same thread
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {step.variants.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setSelected(v.id);
                onPreview(v.id);
              }}
              className={clsx(
                "flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold transition-colors",
                variant?.id === v.id ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200" : "text-ink-500 hover:bg-ink-100",
                !v.active && "line-through opacity-70",
              )}
              title={v.active ? `Variant ${v.label}` : `Variant ${v.label} (paused)`}
            >
              {v.label}
              {v.lint.blocks > 0 && <span className="size-1.5 rounded-full bg-red-500" />}
            </button>
          ))}
          {step.variants.length < 4 && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} loading={addVariant.isPending} onClick={() => addVariant.mutate()}>
              A/B
            </Button>
          )}
          {!first && (
            <ConfirmButton size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} title="Remove this step?" body="Prospects already past this step aren't affected." confirmVariant="danger" confirmLabel="Remove" onConfirm={() => removeStep.mutate()}>
              {""}
            </ConfirmButton>
          )}
        </div>
      </div>
      {variant && (
        <VariantEditor
          key={variant.id}
          variant={variant}
          campaignId={campaignId}
          isFirst={first}
          ctx={ctx}
          onFocus={() => onPreview(variant.id)}
          canDelete={step.variants.length > 1}
          onDelete={() => removeVariant.mutate(variant.id)}
        />
      )}
    </Card>
  );
}

const MERGE_CHIPS = ["{{firstName|there}}", "{{company|your team}}", "{{title}}", "{{senderFirstName}}"];

function VariantEditor({ variant, campaignId, isFirst, ctx, onFocus, canDelete, onDelete }: { variant: Variant; campaignId: string; isFirst: boolean; ctx: LintCtx; onFocus: () => void; canDelete: boolean; onDelete: () => void }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(variant.subject);
  const [body, setBody] = useState(variant.body);
  const [standalone, setStandalone] = useState(variant.standaloneBody ?? "");
  const [showStandalone, setShowStandalone] = useState(!!variant.standaloneBody);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const first = useRef(true);

  const lint = useMemo(
    () => lintCopy({ subject: isFirst ? subject : "", body, isFirstTouch: isFirst, jurisdiction: ctx.jurisdiction, postalAddressConfigured: ctx.postalAddressConfigured, policies: ctx.policies }),
    [subject, body, isFirst, ctx.jurisdiction, ctx.postalAddressConfigured, ctx.policies],
  );
  const standaloneLint = useMemo(
    () => (standalone.trim() ? lintCopy({ subject: "", body: standalone, isFirstTouch: false, jurisdiction: ctx.jurisdiction, postalAddressConfigured: ctx.postalAddressConfigured, policies: ctx.policies }) : null),
    [standalone, ctx.jurisdiction, ctx.postalAddressConfigured, ctx.policies],
  );

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        await put(`/variants/${variant.id}`, { subject, body, standaloneBody: standalone.trim() ? standalone : null });
        setSaveState("saved");
        qc.invalidateQueries({ queryKey: [`/campaigns/${campaignId}`] });
        qc.invalidateQueries({ queryKey: [`/variants/${variant.id}/preview`] });
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(t);
  }, [subject, body, standalone, variant.id, campaignId, qc]);

  const ack = useAction((rules: string[]) => put(`/variants/${variant.id}`, { acknowledgedWarnings: rules }), { invalidate: [`/campaigns/${campaignId}`] });
  const setActive = useAction((active: boolean) => put(`/variants/${variant.id}`, { active }), {
    invalidate: [`/campaigns/${campaignId}`],
    success: (r: any) => (r.active ? "Variant resumed" : "Variant paused"),
  });

  const insert = (token: string) => {
    const el = bodyRef.current;
    if (!el) return setBody((b) => b + token);
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const warnRules = [...new Set(lint.findings.filter((f) => f.severity === "warn").map((f) => f.rule))];
  const subjectFindings = lint.findings.filter((f) => f.field === "subject");
  const bodyFindings = lint.findings.filter((f) => f.field !== "subject");

  return (
    <div className="space-y-4 p-5">
      {!variant.active && (
        <Callout
          tone="red"
          title={`Variant ${variant.label} is paused`}
          action={
            <Button size="sm" loading={setActive.isPending} disabled={lint.blocks > 0} onClick={() => setActive.mutate(true)}>
              Resume
            </Button>
          }
        >
          {variant.pausedReason ?? "Paused manually."} {lint.blocks > 0 && "Fix the blocking issues first."}
        </Callout>
      )}
      <div className="flex items-start gap-4">
        <ScoreRing score={lint.score} />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-ink-900">
            {lint.blocks > 0 ? `${lint.blocks} blocking ${lint.blocks === 1 ? "issue" : "issues"}` : lint.warns > 0 ? `${lint.warns} suggestion${lint.warns === 1 ? "" : "s"}` : "Clean. Ready to send."}
          </p>
          <p className="text-xs text-ink-500">
            {lint.wordCount} words · aim for under {ctx.policies?.copy.maxWordsWarn ?? 100}
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-ink-500">
          {saveState === "saving" && (
            <>
              <Spinner className="size-3.5" /> Saving
            </>
          )}
          {saveState === "saved" && (
            <>
              <CheckCircle2 className="size-3.5 text-emerald-600" /> Saved
            </>
          )}
          {saveState === "error" && <span className="text-red-600">Couldn't save. Retrying on next edit.</span>}
        </span>
      </div>

      {isFirst ? (
        <Field label="Subject" error={subjectFindings.find((f) => f.severity === "block")?.message}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={onFocus} placeholder="quick question" />
        </Field>
      ) : (
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500">Sent in the same thread as “Re: {"<first subject>"}” so it reads as a quick nudge.</p>
      )}

      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="label mb-0">Body</span>
          <div className="flex flex-wrap gap-1">
            {MERGE_CHIPS.map((c) => (
              <button key={c} type="button" onClick={() => insert(c)} className="rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600 hover:bg-brand-50 hover:text-brand-700" title="Insert at cursor">
                {c}
              </button>
            ))}
          </div>
        </div>
        <LintTextarea value={body} onChange={setBody} findings={bodyFindings.filter((f) => f.field === "body")} inputRef={bodyRef} onFocus={onFocus} minRows={7} />
        <p className="mt-1.5 text-xs text-ink-500">
          Use <span className="font-mono">{"{{field|fallback}}"}</span> for merge fields and <span className="font-mono">{"{Hi|Hey}"}</span> to vary wording. Signature and postal address are added from the mailbox.
        </p>
      </div>

      <Findings findings={lint.findings} />

      {warnRules.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-xs font-medium text-amber-900">Keep any suggestion on purpose? Acknowledge it so launch isn't blocked.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {warnRules.map((r) => {
              const checked = variant.acknowledgedWarnings.includes(r);
              return (
                <label key={r} className="flex items-center gap-1.5 text-xs text-amber-900">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => ack.mutate(checked ? variant.acknowledgedWarnings.filter((x) => x !== r) : [...variant.acknowledgedWarnings, r])}
                    className="accent-amber-600"
                  />
                  {RULE_LABEL[r] ?? r}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {!isFirst && (
        <div className="rounded-lg border border-ink-200">
          <button type="button" onClick={() => setShowStandalone(!showStandalone)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
            <span className="flex items-center gap-2 text-sm font-medium text-ink-800">
              Standalone version <RuleTag n={14} />
              {standalone.trim() ? <Badge tone="green">Set</Badge> : <Badge tone="gray">Optional</Badge>}
            </span>
            <span className="text-xs text-ink-500">{showStandalone ? "Hide" : "Show"}</span>
          </button>
          {showStandalone && (
            <div className="space-y-2 border-t border-ink-100 p-3">
              <p className="text-xs text-ink-500">
                If this domain burns mid-sequence, Cold moves the prospect to a warmed replacement inbox. That inbox can't reply in the old thread, so it sends this version as a fresh email. Without it, the sequence ends and the prospect becomes eligible again after a cooldown.
              </p>
              <Textarea value={standalone} onChange={(e) => setStandalone(e.target.value)} className="min-h-28" placeholder="Hi {{firstName|there}}, …" />
              {standaloneLint && standaloneLint.blocks > 0 && <p className="text-xs text-red-600">{standaloneLint.findings.find((f) => f.severity === "block")?.message}</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {variant.active && canDelete && (
          <Button size="sm" variant="ghost" icon={<Pause className="size-3.5" />} onClick={() => setActive.mutate(false)}>
            Pause variant
          </Button>
        )}
        {canDelete && (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
            Delete variant {variant.label}
          </Button>
        )}
      </div>
    </div>
  );
}

const RULE_LABEL: Record<string, string> = {
  merge_fallback: "Merge field without fallback",
  corporate_language: "Corporate language",
  spam_words: "Spam-trigger words",
  all_caps: "ALL-CAPS words",
  exclamations: "Exclamation marks",
  subject_length: "Long subject",
  too_long: "Length",
  long_signature: "Long signature",
  hard_cta: "Hard CTA",
  soft_cta: "No soft question CTA",
  no_bullets: "Bullets",
};

function Findings({ findings }: { findings: LintFinding[] }) {
  if (!findings.length)
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-700">
        <CheckCircle2 className="size-4" /> Plain text, no links, short, soft CTA. Nice.
      </p>
    );
  const unique = new Map<string, LintFinding & { n: number }>();
  for (const f of findings) {
    const key = `${f.rule}:${f.message}`;
    const ex = unique.get(key);
    if (ex) ex.n++;
    else unique.set(key, { ...f, n: 1 });
  }
  const list = [...unique.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
  return (
    <ul className="space-y-1.5">
      {list.map((f, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          {f.severity === "block" ? <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Circle className="mt-0.5 size-4 shrink-0 text-amber-500" />}
          <span className={f.severity === "block" ? "text-red-800" : "text-ink-700"}>
            {f.message}
            {f.n > 1 && <span className="text-ink-400"> ×{f.n}</span>}
            {f.field === "signature" && <span className="text-ink-400"> (signature)</span>}
          </span>
          {f.ruleRef && <RuleTag n={f.ruleRef} className="ml-auto" />}
        </li>
      ))}
    </ul>
  );
}

function AddStepButton({ campaignId, disabled }: { campaignId: string; disabled: boolean }) {
  const add = useAction(() => post(`/campaigns/${campaignId}/steps`), { invalidate: [`/campaigns/${campaignId}`], success: "Follow-up added" });
  return (
    <button
      type="button"
      disabled={disabled || add.isPending}
      onClick={() => add.mutate()}
      className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-200 py-4 text-sm font-medium text-ink-500 transition-colors hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus className="size-4" />
      {disabled ? "Six steps is the limit" : "Add follow-up"}
    </button>
  );
}

function ChecklistCard({ items, status, onLaunch, launching }: { items: ChecklistItem[]; status: string; onLaunch: () => void; launching: boolean }) {
  const blocking = items.filter((i) => i.blocking && !i.ok).length;
  return (
    <Card title="Launch checklist" subtitle={status === "active" ? "Sending" : blocking ? `${blocking} to fix before launch` : "Ready to launch"}>
      <ul className="space-y-2.5">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-2 text-sm">
            {i.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : i.blocking ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            )}
            <div className="min-w-0">
              <p className={i.ok ? "text-ink-700" : "text-ink-900"}>
                {i.href && !i.ok ? (
                  <Link to={i.href} className="hover:underline">
                    {i.label}
                  </Link>
                ) : (
                  i.label
                )}
              </p>
              {i.detail && <p className="text-xs text-ink-500">{i.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
      {status !== "active" && (
        <Button variant="primary" className="mt-4 w-full" icon={<Play className="size-4" />} disabled={blocking > 0} loading={launching} onClick={onLaunch}>
          {status === "paused" ? "Resume campaign" : "Launch campaign"}
        </Button>
      )}
    </Card>
  );
}

function PreviewCard({ variantId }: { variantId: string | null }) {
  const p = useGet<{ prospect: { email: string; firstName: string | null; company: string | null } | null; from: string; subject: string; text: string; missing: string[] }>(variantId ? `/variants/${variantId}/preview` : null);
  return (
    <Card
      title="Preview"
      subtitle={p.data?.prospect ? `As ${p.data.prospect.firstName ?? p.data.prospect.email} at ${p.data.prospect.company ?? "their company"} sees it` : "With sample data"}
      actions={
        <button className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" title="Re-render (new spintax pick)" onClick={() => p.refetch()}>
          <RefreshCw className={clsx("size-4", p.isFetching && "animate-spin")} />
        </button>
      }
      padded={false}
    >
      {!p.data ? (
        <div className="p-5">{p.isLoading ? <Loading /> : <p className="text-sm text-ink-500">Select a variant.</p>}</div>
      ) : (
        <div className="text-sm">
          <div className="space-y-1 border-b border-ink-100 px-5 py-3 text-xs">
            <p>
              <span className="inline-block w-14 text-ink-400">From</span>
              <span className="text-ink-700">{p.data.from}</span>
            </p>
            <p>
              <span className="inline-block w-14 text-ink-400">To</span>
              <span className="text-ink-700">{p.data.prospect?.email ?? "alex@northwind.com"}</span>
            </p>
            <p>
              <span className="inline-block w-14 text-ink-400">Subject</span>
              <span className="font-medium text-ink-900">{p.data.subject || "Re: (previous subject)"}</span>
            </p>
          </div>
          <pre className="max-h-96 overflow-y-auto px-5 py-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink-800">{p.data.text}</pre>
          {p.data.missing.length > 0 && (
            <div className="border-t border-ink-100 px-5 py-3 text-xs text-amber-700">Missing for this prospect: {p.data.missing.join(", ")}. Add a fallback or this send is skipped.</div>
          )}
          <div className="flex items-center gap-1.5 border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">
            <Lock className="size-3.5" /> Plain text · no tracking pixel · no link rewriting
          </div>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── Settings ─────────────────────────

const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Toronto", "Europe/London", "Europe/Berlin", "Europe/Paris", "Australia/Sydney", "Asia/Singapore"];
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 || h === 24 ? "am" : "pm"}`;

function SettingsTab({ campaign }: { campaign: Campaign }) {
  const pools = useGet<{ id: string; name: string; isCatchAll: boolean }[]>("/pools");
  const [name, setName] = useState(campaign.name);
  const [jurisdiction, setJurisdiction] = useState(campaign.jurisdiction);
  const [poolId, setPoolId] = useState(campaign.poolId ?? "");
  const [s, setS] = useState(campaign.schedule);
  const weekdays = s.days.filter((d) => d !== 6);
  const save = useAction(
    () =>
      put(`/campaigns/${campaign.id}`, {
        name: name.trim(),
        jurisdiction,
        ...(poolId ? { poolId } : {}),
        schedule: { ...s, days: weekdays },
      }),
    { invalidate: [`/campaigns`], success: "Settings saved" },
  );
  const toggleDay = (n: number) => {
    if (n === 6) return setS({ ...s, saturday: !s.saturday });
    setS({ ...s, days: weekdays.includes(n) ? weekdays.filter((d) => d !== n) : [...weekdays, n].sort() });
  };
  const tzs = TIMEZONES.includes(s.defaultTimezone) ? TIMEZONES : [s.defaultTimezone, ...TIMEZONES];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <Card title={<span className="flex items-center gap-2">Sending window <RuleTag n={11} /></span>} subtitle="In each recipient's local time. Every inbox starts at a random time inside the window so they never fire together.">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start">
                <Select value={s.startHour} onChange={(e) => setS({ ...s, startHour: Number(e.target.value) })}>
                  {Array.from({ length: 23 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="End" error={s.endHour <= s.startHour ? "End must be after start" : undefined}>
                <Select value={s.endHour} onChange={(e) => setS({ ...s, endHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div>
              <p className="label">Days</p>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => {
                  const on = d.n === 6 ? s.saturday : weekdays.includes(d.n);
                  return (
                    <button
                      key={d.n}
                      type="button"
                      onClick={() => toggleDay(d.n)}
                      className={clsx("h-9 w-12 rounded-lg border text-sm font-medium transition-colors", on ? "border-brand-300 bg-brand-50 text-brand-700" : "border-ink-200 text-ink-500 hover:bg-ink-50")}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Fallback timezone" hint="Used when a prospect has no timezone, state or country. Cold infers US states and common countries automatically.">
              <Select value={s.defaultTimezone} onChange={(e) => setS({ ...s, defaultTimezone: e.target.value })}>
                {tzs.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2">Saturday test <RuleTag n={11} /></span>} subtitle="SMB and mid-market buyers often read email on Saturdays. Test it on a slice instead of guessing.">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-ink-700">Share of new prospects held for Saturday</span>
              <span className="text-sm font-semibold text-ink-900 tabular-nums">{Math.round(s.saturdayTestShare * 100)}%</span>
            </div>
            <input type="range" min={0} max={50} step={5} value={Math.round(s.saturdayTestShare * 100)} onChange={(e) => setS({ ...s, saturdayTestShare: Number(e.target.value) / 100 })} className="w-full accent-brand-600" />
            <p className="text-xs text-ink-500">
              {s.saturdayTestShare > 0
                ? `${Math.round(s.saturdayTestShare * 100)}% of first emails go out on Saturdays, the rest on weekdays. Compare reply rates under Results. Daily caps still apply.`
                : "Off. Turn it up to split first emails between weekdays and Saturdays."}
            </p>
          </div>
        </Card>

        <Card title="Campaign">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Compliance" hint={JURISDICTIONS.find((j) => j.value === jurisdiction)?.help}>
              <Select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as Campaign["jurisdiction"])}>
                {JURISDICTIONS.map((j) => (
                  <option key={j.value} value={j.value}>
                    {j.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mailbox pool" hint={campaign.isCatchAll ? "Catch-all campaigns send from the catch-all pool so bounces stay contained." : "Domains in this pool send for this campaign. Rotated-in replacements join it automatically."}>
              <Select value={poolId} onChange={(e) => setPoolId(e.target.value)}>
                {(pools.data ?? [])
                  .filter((p) => p.isCatchAll === campaign.isCatchAll)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        </Card>
        <div className="flex justify-end">
          <Button variant="primary" disabled={s.endHour <= s.startHour || weekdays.length + (s.saturday ? 1 : 0) === 0 || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Save settings
          </Button>
        </div>
      </div>
      <aside className="space-y-5">
        <Card title="Always on">
          <ul className="space-y-3 text-sm">
            <LockedRow label="Open tracking" value="Off" rule={10} help="Pixels are unreliable and hurt deliverability. Cold tracks replies and bounces." />
            <LockedRow label="Click tracking" value="Off" rule={9} help="No links, so nothing to track." />
            <LockedRow label="Format" value="Plain text" rule={9} help="One text/plain part. No HTML, images or attachments." />
            <LockedRow label="Volume caps" value="Per inbox & domain" rule={4} help="Enforced at plan time and again right before each send." />
          </ul>
        </Card>
      </aside>
    </div>
  );
}

function LockedRow({ label, value, rule, help }: { label: string; value: string; rule: number; help: string }) {
  return (
    <li>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-ink-700">
          <Lock className="size-3.5 text-ink-400" /> {label}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-ink-900">{value}</span>
          <RuleTag n={rule} />
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink-500">{help}</p>
    </li>
  );
}

// ───────────────────────── Results ─────────────────────────

interface Stats {
  byDay: { day: string; sent: number; replies: number; bounces: number }[];
  byVariant: { variantId: string | null; stepIndex: number | null; sent: number; replies: number; bounces: number }[];
  saturday: { saturday: boolean; sent: number; replies: number }[];
}

function StatsTab({ campaignId, steps }: { campaignId: string; steps: Step[] }) {
  const stats = useGet<Stats>(`/campaigns/${campaignId}/stats`);
  if (stats.isLoading) return <Loading />;
  if (stats.error || !stats.data) return <ErrorState error={stats.error} />;
  const { byDay, byVariant, saturday } = stats.data;
  if (!byDay.length)
    return (
      <Card>
        <EmptyState title="No sends yet">Results appear once the campaign starts sending. Replies and bounces need about 48 hours to settle.</EmptyState>
      </Card>
    );
  const labelFor = (vid: string | null, si: number | null) => {
    const s = steps.find((x) => x.position === si);
    const v = s?.variants.find((x) => x.id === vid);
    return `${si === 0 ? "First email" : `Follow-up ${si}`} · ${v ? `Variant ${v.label}` : "Removed variant"}`;
  };
  const sat = saturday.find((x) => x.saturday);
  const wk = saturday.find((x) => !x.saturday);
  const data = byDay.map((d) => ({ ...d, label: d.day.slice(5) }));

  return (
    <div className="space-y-6">
      <Card title="Daily volume, replies and bounces" subtitle="Opens aren't tracked on purpose (rule 10).">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#eef0f4" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#667085" }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="l" tick={{ fontSize: 11, fill: "#667085" }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: "#667085" }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ borderRadius: 10, borderColor: "#dde1e9", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="sent" name="Sent" stroke="#3b6ff5" strokeWidth={2} dot={false} />
              <Line yAxisId="r" type="monotone" dataKey="replies" name="Replies" stroke="#059669" strokeWidth={2} dot={false} />
              <Line yAxisId="r" type="monotone" dataKey="bounces" name="Bounces" stroke="#dc2626" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <TableCard>
          <table className="tbl">
            <thead>
              <tr>
                <th>Step / variant</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Reply rate</th>
                <th className="text-right">Bounce rate</th>
              </tr>
            </thead>
            <tbody>
              {[...byVariant]
                .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0))
                .map((v, i) => (
                  <tr key={i}>
                    <td>{labelFor(v.variantId, v.stepIndex)}</td>
                    <td className="text-right tabular-nums">{num(v.sent)}</td>
                    <td className="text-right font-medium tabular-nums">{pct(v.sent ? v.replies / v.sent : null)}</td>
                    <td className="text-right tabular-nums">{pct(v.sent ? v.bounces / v.sent : null)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableCard>
        <Card title={<span className="flex items-center gap-2">Saturday vs weekdays <RuleTag n={11} /></span>} subtitle="First emails only">
          {!sat ? (
            <p className="text-sm text-ink-500">No Saturday sends yet. Turn on the Saturday test under Schedule & settings.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Weekdays", r: wk },
                { label: "Saturdays", r: sat },
              ].map((x) => (
                <div key={x.label}>
                  <p className="text-xs font-medium text-ink-500 uppercase">{x.label}</p>
                  <p className="mt-1 text-2xl font-semibold text-ink-900 tabular-nums">{pct(x.r?.sent ? x.r.replies / x.r.sent : null)}</p>
                  <p className="text-xs text-ink-500">{num(x.r?.sent ?? 0)} sent</p>
                </div>
              ))}
              <p className="col-span-2 text-xs text-ink-500">
                {(sat.sent ?? 0) < 300 ? "Small sample. Let it run before drawing conclusions." : "Enough data for a directional read. Keep the winner."}
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── Enroll ─────────────────────────

function EnrollModal({ open, onClose, campaign }: { open: boolean; onClose: () => void; campaign: Campaign }) {
  const lists = useGet<{ id: string; name: string; status: string; counts: Record<string, number> }[]>(open ? "/lists" : null);
  const [picked, setPicked] = useState<string[]>([]);
  const [segment, setSegment] = useState("");
  const bucket = campaign.isCatchAll ? "catch_all" : "ready";
  const done = (lists.data ?? []).filter((l) => l.status === "done");
  const total = done.filter((l) => picked.includes(l.id)).reduce((a, l) => a + (l.counts[bucket] ?? 0), 0);
  const enroll = useAction(() => post<{ enrolled: number }>(`/campaigns/${campaign.id}/enroll`, { importIds: picked, ...(segment ? { segment } : {}) }), {
    invalidate: [`/campaigns`],
    success: (r) => (r.enrolled ? `${num(r.enrolled)} prospects enrolled` : "Nobody new to enroll. They're already in a sequence."),
    onSuccess: () => {
      setPicked([]);
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enroll prospects"
      description={campaign.isCatchAll ? "Catch-all campaigns only take catch-all prospects." : "Only validated, ready prospects are enrolled. Catch-alls go to a catch-all campaign."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked.length} loading={enroll.isPending} onClick={() => enroll.mutate()}>
            Enroll up to {num(total)}
          </Button>
        </>
      }
    >
      {lists.isLoading ? (
        <Loading />
      ) : !done.length ? (
        <EmptyState title="No clean lists yet" action={<Link to="/lists" className="text-sm font-medium text-brand-600 hover:underline">Upload a list</Link>}>
          Upload a CSV and let Cold clean it first.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {done.map((l) => (
              <label key={l.id} className={clsx("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5", picked.includes(l.id) ? "border-brand-300 bg-brand-50/50" : "border-ink-200 hover:bg-ink-50")}>
                <input type="checkbox" className="accent-brand-600" checked={picked.includes(l.id)} onChange={() => setPicked((p) => (p.includes(l.id) ? p.filter((x) => x !== l.id) : [...p, l.id]))} />
                <span className="flex-1 text-sm font-medium text-ink-800">{l.name}</span>
                <span className="text-xs text-ink-500">
                  {num(l.counts[bucket] ?? 0)} {campaign.isCatchAll ? "catch-all" : "ready"}
                </span>
              </label>
            ))}
          </div>
          <Field label="Only this segment (optional)" hint="Matches segment tags from the upload, e.g. smb or mid_market.">
            <Input value={segment} onChange={(e) => setSegment(e.target.value.trim().toLowerCase())} placeholder="smb" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

