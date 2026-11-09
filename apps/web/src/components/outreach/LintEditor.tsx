import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import type { LintFinding } from "@cold/core";

/**
 * Textarea with live lint highlights: a mirror layer behind a transparent textarea shows
 * wavy underlines under offending snippets (findings carry index + match).
 */
export function LintTextarea({
  value,
  onChange,
  findings,
  placeholder,
  minRows = 6,
  className,
  disabled,
  inputRef,
  onFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  findings: LintFinding[];
  placeholder?: string;
  minRows?: number;
  className?: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onFocus?: () => void;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const mirror = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 20;
    el.style.height = `${Math.max(el.scrollHeight + 2, minRows * lineHeight + 18)}px`;
    if (mirror.current) mirror.current.style.height = el.style.height;
  }, [value, minRows]);

  return (
    <div className={clsx("relative", className)}>
      <div ref={mirror} aria-hidden className="input pointer-events-none absolute inset-0 overflow-hidden leading-5 break-words whitespace-pre-wrap" style={{ color: "transparent" }}>
        {highlight(value, findings)}
        {"​"}
      </div>
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        className="input relative resize-none overflow-hidden leading-5"
        style={{ background: "transparent" }}
      />
    </div>
  );
}

function highlight(text: string, findings: LintFinding[]): ReactNode[] {
  const spans = findings
    .filter((f) => f.index != null && f.match && f.match.length > 0)
    .map((f) => ({ start: f.index!, end: f.index! + f.match!.length, severity: f.severity }))
    .sort((a, b) => a.start - b.start || (a.severity === "block" ? -1 : 1));
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [i, s] of spans.entries()) {
    if (s.start < pos) continue;
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push(
      <mark key={i} className={s.severity === "block" ? "lint-block" : "lint-warn"} style={{ color: "transparent" }}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  }
  out.push(text.slice(pos));
  return out;
}

export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? "#059669" : score >= 60 ? "#d97706" : "#dc2626";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title="Copy score: 100 minus 25 per blocking issue and 6 per warning">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#eef0f4" strokeWidth={5} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={5} fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums" style={{ color }}>
        {score}
      </span>
    </div>
  );
}
