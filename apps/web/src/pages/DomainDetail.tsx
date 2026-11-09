import { Link, useNavigate, useParams } from "react-router";
import { Activity, FlaskConical } from "lucide-react";
import { DEFAULT_POLICIES } from "@cold/core";
import { post, useAction, useGet } from "../lib/api";
import { date, num } from "../lib/format";
import { Badge, Button, Callout, Card, ErrorState, KeyValue, Loading, PageHeader } from "../components/ui";
import { DomainStateBadge, PoolBadge, ProviderBadge, VerdictBadge } from "../components/badges";
import { LifecycleStepper } from "../components/infra/Lifecycle";
import { DnsCard, HeaderTestCard, WarmupCard } from "../components/infra/AuthCards";
import { MailboxesCard } from "../components/infra/MailboxesCard";
import { DomainSettingsCard } from "../components/infra/DomainSettingsCard";
import type { DomainDetail, Integrations, PoliciesResponse } from "../components/infra/types";

const BILLING: Record<string, string> = {
  active: "Billed as active",
  recovery_pool: "Recovery Pool",
  layover: "Layover",
  relay: "Relay",
  cancelled: "Cancelled",
};

export default function DomainDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useGet<DomainDetail>(`/domains/${id}`);
  const integrations = useGet<Integrations>("/integrations");
  const policiesQ = useGet<PoliciesResponse>("/policies");
  const policies = policiesQ.data?.effective ?? DEFAULT_POLICIES;
  const diagnose = useAction(() => post<{ id: string }>("/diagnoses", { domainId: id }), {
    invalidate: ["/domains", "/diagnoses", "/health"],
    success: "Diagnosis opened. Sending on this domain is paused while you test.",
    onSuccess: (r) => navigate(`/diagnoses/${r.id}`),
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const detail = q.data;
  const d = detail.domain;
  const live = detail.mailboxes.filter((m) => m.state !== "decommissioned");
  const sending = ["active", "flagged", "diagnosing"].includes(d.state);
  const nextGate = d.state === "auth_verified" ? detail.gates.warming : d.state === "warming" ? detail.gates.ready : d.state === "ready" ? detail.gates.active : null;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/domains", label: "Domains" }}
        title={<span className="mono">{d.name}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ProviderBadge provider={d.provider} />
            <span className="text-ink-300">·</span>
            <PoolBadge pool={d.pool} />
            <DomainStateBadge state={d.state} />
            <span className="text-ink-300">·</span>
            <span>
              {num(detail.capacity)}/day capacity across {live.length} mailbox{live.length === 1 ? "" : "es"}
            </span>
          </span>
        }
        actions={
          <>
            {sending && (
              <Link to="/health" className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
                <Activity className="size-4" /> <VerdictBadge verdict={d.healthVerdict} />
              </Link>
            )}
            {sending && d.state !== "diagnosing" && (
              <Button icon={<FlaskConical className="size-4" />} loading={diagnose.isPending} onClick={() => diagnose.mutate()}>
                Diagnose
              </Button>
            )}
          </>
        }
      />

      <StateCallout detail={detail} />

      <Card>
        <LifecycleStepper detail={detail} />
        {nextGate && (
          <div className="mt-5 rounded-xl bg-ink-50 p-4">
            {nextGate.ok ? (
              <p className="text-sm text-ink-700">
                {d.state === "auth_verified" && "Authenticated. Start warmup tracking below."}
                {d.state === "warming" && "Warmup gates pass. This domain becomes Ready on the next lifecycle check."}
                {d.state === "ready" &&
                  (d.pool === "active" ? "Ready. Because it's in the active set, it starts sending on the next lifecycle check." : "Ready and waiting in reserve. It replaces a burned domain the moment a rotation needs it.")}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-ink-800">What's needed next</p>
                <ul className="mt-1.5 space-y-1 text-sm text-ink-600">
                  {nextGate.blockers.map((b) => (
                    <li key={b.code}>• {b.message}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {d.state === "pending_dns" && (
          <div className="mt-5 rounded-xl bg-ink-50 p-4 text-sm text-ink-700">
            <p className="font-medium text-ink-800">What's needed next</p>
            <ul className="mt-1.5 space-y-1 text-ink-600">
              <li>{d.authVerifiedAt ? "✓ SPF, DKIM and DMARC pass" : "• Publish the DNS records below and pass the DNS check"}</li>
              <li>{d.headerTestPassedAt ? "✓ Header test passed" : "• Send yourself a test email and pass the header test"}</li>
              {live.length === 0 && <li>• Add the mailboxes that will send from this domain</li>}
            </ul>
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <DnsCard detail={detail} cloudflare={!!integrations.data?.cloudflare} />
          <HeaderTestCard detail={detail} />
          <WarmupCard detail={detail} />
          <MailboxesCard detail={detail} policies={policies} />
        </div>
        <div className="space-y-6">
          <Card title="At a glance">
            <KeyValue
              cols={2}
              items={[
                { label: "Tenant", value: detail.tenant ? detail.tenant.name : <span className="text-amber-700">None attached</span> },
                { label: "Billing", value: <Badge tone={d.billingStatus === "recovery_pool" ? "violet" : "gray"}>{BILLING[d.billingStatus] ?? d.billingStatus}</Badge> },
                { label: "DNS", value: d.dnsManaged === "cloudflare" ? "Cloudflare (automatic)" : "Manual" },
                { label: "Auth verified", value: d.authVerifiedAt ? date(d.authVerifiedAt) : "Not yet" },
                { label: "Sending since", value: d.activatedAt ? date(d.activatedAt) : "–" },
                { label: "Added", value: date(d.createdAt) },
              ]}
            />
          </Card>
          <DomainSettingsCard detail={detail} policies={policies} />
        </div>
      </div>
    </div>
  );
}

function StateCallout({ detail }: { detail: DomainDetail }) {
  const d = detail.domain;
  switch (d.state) {
    case "auth_failed":
      return (
        <Callout tone="red" title="Authentication is failing. Sending and warmup are paused.">
          Fix the records flagged below, then click Check DNS now. The domain resumes where it left off as soon as everything passes.
        </Callout>
      );
    case "flagged":
      return (
        <Callout tone="red" title="Paused: this domain was flagged" action={<Link to="/diagnoses" className="text-sm font-medium text-red-700 underline">Open diagnoses</Link>}>
          Health or a circuit breaker paused cold sending here. Diagnose before replacing: a control test tells you whether the copy or the domain is the problem.
        </Callout>
      );
    case "diagnosing":
      return (
        <Callout tone="amber" title="Control test running" action={<Link to="/diagnoses" className="text-sm font-medium text-amber-800 underline">View diagnosis</Link>}>
          Neutral control copy and campaign copy are going to seed inboxes from these mailboxes. Sending is paused until there's a verdict.
        </Callout>
      );
    case "layover":
      return (
        <Callout tone="amber" title={`Layover until ${date(d.layoverEndsAt)}`}>
          Rotated out while a replacement finishes warming. No new first emails; follow-ups in existing threads and replies continue.
        </Callout>
      );
    case "relay":
      return (
        <Callout tone="gray" title={`Relay until ${date(d.relayEndsAt)}`}>
          Rotated out. No cold email is sent from here, but replies keep arriving in your inbox and you can still answer them.
        </Callout>
      );
    case "retired":
      return (
        <Callout tone="gray" title="Retired">
          {d.retireReason ?? "Out of service."} Conversations from this domain are kept in the inbox.
        </Callout>
      );
    default:
      return null;
  }
}
