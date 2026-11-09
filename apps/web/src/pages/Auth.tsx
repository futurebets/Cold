import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Flame, RefreshCcw } from "lucide-react";
import { post, ApiError } from "../lib/api";
import { Button, Callout, Field, Input, Select } from "../components/ui";
import { Logo } from "../components/layout";

function Shell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.05fr]">
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <Logo className="mb-8" />
          {children}
        </div>
      </div>
      <div className="hidden bg-gradient-to-br from-brand-800 via-brand-900 to-ink-900 p-12 text-brand-50 lg:flex lg:flex-col lg:justify-center">{aside}</div>
    </div>
  );
}

function Pitch() {
  const items = [
    { icon: <ShieldCheck className="size-5" />, title: "Guardrails, not advice", body: "Cold won't send from your primary domain, an unwarmed inbox, an unauthenticated domain, or above the caps. Ever." },
    { icon: <Flame className="size-5" />, title: "Know when a domain is burning", body: "Reply and bounce rates on 1,000+ mature sends, against each domain's own baseline. Then a control test to tell copy from infrastructure." },
    { icon: <RefreshCcw className="size-5" />, title: "Rotate without stopping", body: "Warmed replacements on standby. One click swaps them in, keeps every reply, and orders the next replacement." },
  ];
  return (
    <div className="max-w-md">
      <p className="text-sm font-medium tracking-wide text-brand-200 uppercase">Cold email deliverability</p>
      <h2 className="mt-3 text-3xl leading-tight font-semibold text-white">Your domains will eventually burn. Be ready when they do.</h2>
      <div className="mt-10 space-y-6">
        {items.map((it) => (
          <div key={it.title} className="flex gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-brand-100">{it.icon}</div>
            <div>
              <p className="font-medium text-white">{it.title}</p>
              <p className="mt-1 text-sm text-brand-100/80">{it.body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LoginPage({ demo }: { demo?: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(demo ? "demo@cold.local" : "");
  const [password, setPassword] = useState(demo ? "cold-demo-2026" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { email, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell aside={<Pitch />}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Sign in</h1>
      <p className="mt-1 text-sm text-ink-500">Welcome back.</p>
      {demo && (
        <Callout tone="blue" className="mt-6" title="Demo workspace">
          Sign in with <span className="mono">demo@cold.local</span> / <span className="mono">cold-demo-2026</span>. Mailboxes are simulated, so nothing is really sent.
        </Callout>
      )}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button variant="primary" className="w-full" loading={busy} type="submit">
          Sign in
        </Button>
      </form>
    </Shell>
  );
}

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Australia/Sydney", "Asia/Singapore"];

export function SetupPage({ tokenRequired = false }: { tokenRequired?: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ setupToken: "", name: "", email: "", password: "", workspaceName: "", primaryDomain: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/setup", f);
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const tzs = TIMEZONES.includes(f.timezone) ? TIMEZONES : [f.timezone, ...TIMEZONES];
  return (
    <Shell aside={<Pitch />}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Set up Cold</h1>
      <p className="mt-1 text-sm text-ink-500">Create the owner account and protect your primary domain. It takes a minute.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {tokenRequired && (
          <Field label="Setup token" hint="The SETUP_TOKEN secret you set when deploying. It stops anyone else who finds this URL from claiming the workspace.">
            <Input type="password" value={f.setupToken} onChange={set("setupToken")} required autoComplete="off" />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input value={f.name} onChange={set("name")} required autoFocus />
          </Field>
          <Field label="Company">
            <Input value={f.workspaceName} onChange={set("workspaceName")} required />
          </Field>
        </div>
        <Field label="Work email">
          <Input type="email" value={f.email} onChange={set("email")} required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" value={f.password} onChange={set("password")} required minLength={10} />
        </Field>
        <Field label="Primary domain" hint="Your real company domain. Cold will never send cold email from it or any subdomain of it (rule 1).">
          <Input value={f.primaryDomain} onChange={set("primaryDomain")} placeholder="acme.com" required />
        </Field>
        <Field label="Timezone">
          <Select value={f.timezone} onChange={set("timezone")}>
            {tzs.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button variant="primary" className="w-full" loading={busy} type="submit">
          Create workspace
        </Button>
      </form>
    </Shell>
  );
}
