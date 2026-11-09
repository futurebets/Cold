import clsx from "clsx";
import { Check as CheckIcon } from "lucide-react";
import { RuleTag } from "../ui";
import type { DomainDetail } from "./types";

const STEPS = [
  { key: "pending_dns", label: "Needs DNS", rule: 5 },
  { key: "auth_verified", label: "Authenticated", rule: 5 },
  { key: "warming", label: "Warming", rule: 6 },
  { key: "ready", label: "Ready", rule: 6 },
  { key: "active", label: "Sending", rule: 4 },
];

const INDEX: Record<string, number> = { pending_dns: 0, auth_verified: 1, warming: 2, ready: 3, active: 4, flagged: 4, diagnosing: 4 };

export function LifecycleStepper({ detail }: { detail: DomainDetail }) {
  const d = detail.domain;
  const idx = INDEX[d.state] ?? -1;
  const minDays = detail.mailboxes[0]?.warmup.min ?? 14;
  const targetDays = detail.mailboxes[0]?.warmup.target ?? 30;
  const live = detail.mailboxes.filter((m) => m.state !== "decommissioned");
  const days = live.length ? Math.min(...live.map((m) => m.warmup.days)) : 0;
  return (
    <ol className="grid grid-cols-5 gap-2">
      {STEPS.map((s, i) => {
        const done = idx > i;
        const current = idx === i;
        const sub =
          s.key === "warming" && (current || done)
            ? days >= minDays
              ? `${days} days warm`
              : `Day ${days} of ${minDays} · ${targetDays} recommended`
            : s.key === "active" && current && d.state !== "active"
              ? "Paused"
              : null;
        return (
          <li key={s.key} className="min-w-0">
            <div className={clsx("h-1.5 rounded-full", done ? "bg-emerald-500" : current ? (d.state === "flagged" || d.state === "diagnosing" ? "bg-amber-500" : "bg-brand-500") : "bg-ink-100")} />
            <div className="mt-2 flex items-center gap-1.5">
              {done && <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />}
              <p className={clsx("truncate text-xs font-medium sm:text-sm", current ? "text-ink-900" : done ? "text-ink-600" : "text-ink-400")}>{s.label}</p>
            </div>
            {sub && <p className="mt-0.5 truncate text-xs text-ink-500">{sub}</p>}
            {current && <RuleTag n={s.rule} className="mt-1 hidden sm:inline-flex" />}
          </li>
        );
      })}
    </ol>
  );
}
