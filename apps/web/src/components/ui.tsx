/** Design-system primitives. Every page composes these so the app reads as one system. */
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle, BookOpen } from "lucide-react";
import { RULES } from "../lib/playbook";

export type Tone = "gray" | "green" | "amber" | "red" | "blue" | "violet" | "indigo" | "sky";

// ───────── Buttons ─────────
type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-brand-200 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
          variant === "primary" && "bg-brand-600 text-white shadow-xs hover:bg-brand-700",
          variant === "secondary" && "border border-ink-200 bg-white text-ink-700 shadow-xs hover:bg-ink-50",
          variant === "ghost" && "text-ink-600 hover:bg-ink-100",
          variant === "danger" && "bg-red-600 text-white shadow-xs hover:bg-red-700",
          variant === "success" && "bg-emerald-600 text-white shadow-xs hover:bg-emerald-700",
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

export function LinkButton({ to, children, variant = "secondary", size = "md", icon }: { to: string; children: ReactNode; variant?: Variant; size?: "sm" | "md"; icon?: ReactNode }) {
  return (
    <Link
      to={to}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-brand-600 text-white shadow-xs hover:bg-brand-700",
        variant === "secondary" && "border border-ink-200 bg-white text-ink-700 shadow-xs hover:bg-ink-50",
        variant === "ghost" && "text-ink-600 hover:bg-ink-100",
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

// ───────── Layout ─────────
export function PageHeader({ title, description, actions, rules, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; rules?: number[]; back?: { to: string; label: string } }) {
  return (
    <div className="mb-6">
      {back && (
        <Link to={back.to} className="mb-2 inline-block text-sm text-ink-500 hover:text-ink-700">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
            {rules?.map((r) => <RuleTag key={r} n={r} />)}
          </div>
          {description && <p className="mt-1 max-w-3xl text-sm text-ink-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, padded = true, footer }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean; footer?: ReactNode }) {
  return (
    <section className={clsx("rounded-xl border border-ink-200 bg-white shadow-xs", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && "p-5")}>{children}</div>
      {footer && <footer className="border-t border-ink-100 px-5 py-3">{footer}</footer>}
    </section>
  );
}

export function Stat({ label, value, hint, tone, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-500">{label}</p>
        {icon && <span className="text-ink-400">{icon}</span>}
      </div>
      <p className={clsx("mt-1.5 text-2xl font-semibold tracking-tight tabular-nums", tone ? toneText[tone] : "text-ink-900")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const toneText: Record<Tone, string> = {
  gray: "text-ink-700",
  green: "text-emerald-700",
  amber: "text-amber-700",
  red: "text-red-700",
  blue: "text-brand-700",
  violet: "text-violet-700",
  indigo: "text-indigo-700",
  sky: "text-sky-700",
};

const toneBadge: Record<Tone, string> = {
  gray: "bg-ink-100 text-ink-600 ring-ink-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
};

export function Badge({ tone = "gray", children, dot, className, title }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", toneBadge[tone], className)}>
      {dot && <span className={clsx("size-1.5 rounded-full", dotColor[tone])} />}
      {children}
    </span>
  );
}

const dotColor: Record<Tone, string> = {
  gray: "bg-ink-400",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-brand-500",
  violet: "bg-violet-500",
  indigo: "bg-indigo-500",
  sky: "bg-sky-500",
};

export function RuleTag({ n, className }: { n: number; className?: string }) {
  const r = RULES[n];
  return (
    <span title={r ? `Playbook rule ${n}: ${r.title}. ${r.text}` : undefined} className={clsx("inline-flex cursor-help items-center gap-1 rounded-md bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-600", className)}>
      <BookOpen className="size-3" />
      Rule {n}
    </span>
  );
}

export function Callout({ tone = "blue", title, children, action, className }: { tone?: "blue" | "amber" | "red" | "green" | "gray"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = tone === "red" ? XCircle : tone === "amber" ? AlertTriangle : tone === "green" ? CheckCircle2 : Info;
  return (
    <div
      className={clsx(
        "flex gap-3 rounded-xl border p-4",
        tone === "blue" && "border-brand-200 bg-brand-50/60",
        tone === "amber" && "border-amber-200 bg-amber-50/70",
        tone === "red" && "border-red-200 bg-red-50/70",
        tone === "green" && "border-emerald-200 bg-emerald-50/70",
        tone === "gray" && "border-ink-200 bg-ink-50",
        className,
      )}
    >
      <Icon className={clsx("mt-0.5 size-5 shrink-0", tone === "blue" && "text-brand-600", tone === "amber" && "text-amber-600", tone === "red" && "text-red-600", tone === "green" && "text-emerald-600", tone === "gray" && "text-ink-500")} />
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-medium text-ink-900">{title}</p>}
        {children && <div className={clsx("text-ink-600", title && "mt-1")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">{icon}</div>}
      <p className="text-[15px] font-semibold text-ink-900">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Progress({ value, max = 100, tone = "blue", className }: { value: number; max?: number; tone?: "blue" | "green" | "amber" | "red" | "gray"; className?: string }) {
  const p = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-ink-100", className)}>
      <div
        className={clsx("h-full rounded-full transition-all", tone === "blue" && "bg-brand-500", tone === "green" && "bg-emerald-500", tone === "amber" && "bg-amber-500", tone === "red" && "bg-red-500", tone === "gray" && "bg-ink-400")}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("size-5 animate-spin text-ink-400", className)} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-ink-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <Callout tone="red" title="Couldn't load this page">
      {(error as Error)?.message ?? String(error)}
    </Callout>
  );
}

// ───────── Forms ─────────
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-ink-500">{hint}</span>}
      {error && <span className="mt-1.5 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx("input", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx("input min-h-24", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx("input pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx("inline-flex items-center gap-2.5", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-brand-600" : "bg-ink-200")}
      >
        <span className={clsx("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
      </button>
      {label && <span className="text-sm text-ink-700">{label}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-lg bg-ink-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-md font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === o.value ? "bg-white text-ink-900 shadow-xs" : "text-ink-500 hover:text-ink-700",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
            value === t.value ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-800",
          )}
        >
          {t.label}
          {t.count != null && <span className={clsx("rounded-full px-1.5 text-xs", value === t.value ? "bg-brand-100 text-brand-700" : "bg-ink-100 text-ink-500")}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ───────── Overlays ─────────
export function Modal({ open, onClose, title, description, children, footer, size = "md" }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 pt-[8vh] backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx("animate-in w-full rounded-2xl bg-white shadow-2xl", size === "sm" && "max-w-md", size === "md" && "max-w-lg", size === "lg" && "max-w-2xl", size === "xl" && "max-w-4xl")}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-ink-900">{title}</h3>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600">
            <X className="size-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-2xl border-t border-ink-100 bg-ink-50/60 px-6 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmButton({ children, title, body, onConfirm, variant = "secondary", confirmLabel = "Confirm", confirmVariant = "primary", size, icon, loading, requireReason }: {
  children: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  onConfirm: (reason?: string) => void;
  variant?: Variant;
  confirmLabel?: string;
  confirmVariant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
  requireReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button variant={variant} size={size} icon={icon} loading={loading} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant={confirmVariant}
              disabled={!!requireReason && reason.trim().length < 3}
              onClick={() => {
                onConfirm(reason || undefined);
                setOpen(false);
                setReason("");
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-ink-600">
          {body}
          {requireReason && (
            <Field label={requireReason}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20" autoFocus />
            </Field>
          )}
        </div>
      </Modal>
    </>
  );
}

export function KeyValue({ items, cols = 2 }: { items: { label: ReactNode; value: ReactNode }[]; cols?: 2 | 3 | 4 }) {
  return (
    <dl className={clsx("grid gap-x-6 gap-y-4", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3", cols === 4 && "sm:grid-cols-2 lg:grid-cols-4")}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium tracking-wide text-ink-500 uppercase">{it.label}</dt>
          <dd className="mt-1 truncate text-sm text-ink-800">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="rounded-md px-1.5 py-0.5 text-xs font-medium text-brand-600 hover:bg-brand-50"
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
      <div className={ok ? "text-ink-700" : "text-ink-800"}>{children}</div>
    </div>
  );
}

export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("overflow-x-auto rounded-xl border border-ink-200 bg-white shadow-xs", className)}>{children}</div>;
}
