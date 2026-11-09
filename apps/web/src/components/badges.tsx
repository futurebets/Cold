import { Badge, type Tone } from "./ui";

export const DOMAIN_STATE: Record<string, { label: string; tone: Tone; help: string }> = {
  pending_dns: { label: "Needs DNS", tone: "gray", help: "Add SPF, DKIM and DMARC, then pass a header test." },
  auth_verified: { label: "Authenticated", tone: "sky", help: "Ready to start warmup." },
  warming: { label: "Warming", tone: "violet", help: "Warmup running. No cold email until the minimum is reached." },
  ready: { label: "Ready", tone: "indigo", help: "Warmed and authenticated, not sending." },
  active: { label: "Sending", tone: "green", help: "Sending campaign email within caps." },
  flagged: { label: "Paused: flagged", tone: "red", help: "Health or a circuit breaker paused this domain. Diagnose before replacing." },
  diagnosing: { label: "Diagnosing", tone: "amber", help: "Control test running. Sending is paused." },
  layover: { label: "Layover", tone: "amber", help: "Outgoing: follow-ups and replies only while a replacement warms." },
  relay: { label: "Relay", tone: "gray", help: "Outgoing: no cold email; replies still arrive." },
  retired: { label: "Retired", tone: "gray", help: "Out of service. Conversations are kept." },
  auth_failed: { label: "Auth failing", tone: "red", help: "SPF/DKIM/DMARC stopped passing. Sending and warmup paused." },
};

export function DomainStateBadge({ state }: { state: string }) {
  const s = DOMAIN_STATE[state] ?? { label: state, tone: "gray" as Tone, help: "" };
  return (
    <Badge tone={s.tone} dot title={s.help}>
      {s.label}
    </Badge>
  );
}

export const VERDICT: Record<string, { label: string; tone: Tone }> = {
  green: { label: "Healthy", tone: "green" },
  amber: { label: "Drifting", tone: "amber" },
  red: { label: "Red", tone: "red" },
  insufficient_data: { label: "Collecting data", tone: "gray" },
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? { label: verdict, tone: "gray" as Tone };
  return (
    <Badge tone={v.tone} dot>
      {v.label}
    </Badge>
  );
}

export function PoolBadge({ pool }: { pool: string }) {
  if (pool === "active") return <Badge tone="blue">Active set</Badge>;
  if (pool === "reserve") return <Badge tone="violet">Reserve set</Badge>;
  return <Badge tone="gray">Retired</Badge>;
}

export function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-700">
      <ProviderLogo provider={provider} />
      {provider === "google" ? "Google" : provider === "microsoft" ? "Microsoft" : provider}
    </span>
  );
}

export function ProviderLogo({ provider, className = "size-3.5" }: { provider: string; className?: string }) {
  if (provider === "microsoft")
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden>
        <rect x="0" y="0" width="7.5" height="7.5" fill="#f25022" />
        <rect x="8.5" y="0" width="7.5" height="7.5" fill="#7fba00" />
        <rect x="0" y="8.5" width="7.5" height="7.5" fill="#00a4ef" />
        <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#ffb900" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <rect width="16" height="16" rx="4" fill="#4285f4" />
      <text x="8" y="12" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="Arial, sans-serif" fill="#fff">
        G
      </text>
    </svg>
  );
}

export const DIAG_VERDICT: Record<string, { label: string; tone: Tone }> = {
  COPY: { label: "Copy problem", tone: "amber" },
  INFRA: { label: "Infrastructure burned", tone: "red" },
  LIST: { label: "List problem", tone: "amber" },
  OFFER: { label: "Offer / targeting", tone: "blue" },
  AUTH: { label: "Authentication broken", tone: "red" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "gray" },
};

export function DiagnosisVerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <Badge tone="gray">Pending</Badge>;
  const v = DIAG_VERDICT[verdict] ?? { label: verdict, tone: "gray" as Tone };
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

export const INTENT: Record<string, { label: string; tone: Tone }> = {
  positive: { label: "Positive", tone: "green" },
  question: { label: "Question", tone: "blue" },
  referral: { label: "Referral", tone: "indigo" },
  not_interested: { label: "Not interested", tone: "gray" },
  opt_out: { label: "Opt-out", tone: "red" },
  neutral: { label: "Neutral", tone: "gray" },
};

export function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return null;
  const i = INTENT[intent] ?? { label: intent, tone: "gray" as Tone };
  return <Badge tone={i.tone}>{i.label}</Badge>;
}
