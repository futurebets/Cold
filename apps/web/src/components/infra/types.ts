import type { DnsCheckItem, DnsRecord, HeaderTestAnalysis, Policies } from "@cold/core";

export interface DomainRow {
  id: string;
  name: string;
  provider: "google" | "microsoft";
  tenantId: string | null;
  poolId: string | null;
  pool: "active" | "reserve" | "retired";
  state: string;
  billingStatus: string;
  vendor: "hypertide" | "direct" | "other";
  registrar: string | null;
  expiresAt: string | null;
  dnsManaged: "cloudflare" | "manual";
  dnsValues: { googleDkimValue?: string; msDkimSelector1?: string; msDkimSelector2?: string; msMxHost?: string };
  authVerifiedAt: string | null;
  lastDnsCheckAt: string | null;
  lastDnsResult: { pass: boolean; items: DnsCheckItem[] } | null;
  headerTestPassedAt: string | null;
  blocklisted: boolean;
  capOverride: number | null;
  healthVerdict: string;
  activatedAt: string | null;
  layoverEndsAt: string | null;
  relayEndsAt: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface DomainListRow extends DomainRow {
  mailboxCount: number;
  connectedCount: number;
  capacity: number;
  scheduledOrSentToday: number;
  warmupDays: number;
  warmupLevel: "not_started" | "warming" | "ready_min" | "ready_recommended";
  readyAt: string | null;
}

export interface WarmupStatus {
  days: number;
  min: number;
  target: number;
  rateOk: boolean;
  level: "not_started" | "warming" | "ready_min" | "ready_recommended";
  ready: boolean;
  readyAt: string | null;
  daysLeft: number;
}

export interface MailboxRow {
  id: string;
  address: string;
  firstName: string;
  lastName: string;
  signature: string;
  timezone: string;
  state: string;
  connection: "connected" | "disconnected" | "unknown";
  connectionDetail: string | null;
  warmupStartedAt: string | null;
  warmupInboxRate: number | null;
  isSeed: boolean;
  seedFamily: string | null;
  lastSyncedAt: string | null;
  warmup: WarmupStatus;
}

export interface Blocker {
  code: string;
  message: string;
  rule?: number;
}

export interface HeaderTestRow {
  id: string;
  source: "manual" | "seed";
  spf: string;
  dkim: string;
  dkimDomain: string | null;
  dkimAligned: boolean;
  dmarc: string;
  pass: boolean;
  issues: string[];
  createdAt: string;
}

export interface DomainDetail {
  domain: DomainRow;
  tenant: { id: string; name: string; provider: string; transport: string; vendor: string } | null;
  expected: DnsRecord[];
  mailboxes: MailboxRow[];
  headerTests: HeaderTestRow[];
  capacity: number;
  gates: Record<"warming" | "ready" | "active", { ok: boolean; blockers: Blocker[] }>;
}

export interface Tenant {
  id: string;
  name: string;
  provider: "google" | "microsoft";
  transport: "api" | "simulated";
  vendor: string;
  status: string;
  hasSecret: boolean;
}

export interface Integrations {
  tenants: Tenant[];
  cloudflare: boolean;
  simulation: boolean;
}

export interface PoliciesResponse {
  effective: Policies;
}

export interface SettingsResponse {
  workspace: { id: string; name: string; timezone: string; settings: { prices?: Record<string, Record<string, number>>; [k: string]: unknown } };
  role: "owner" | "operator" | "sdr" | "viewer";
}

export type { HeaderTestAnalysis, DnsRecord, DnsCheckItem };
