import { randomUUID } from "node:crypto";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  BounceCategory,
  CampaignSchedule,
  Connection,
  DiagnosisVerdict,
  DnsCheckItem,
  DomainState,
  Jurisdiction,
  MailboxState,
  Pool,
  ProspectBucket,
  RecipientProvider,
  Role,
  Seg,
  ValidationStatus,
  Verdict,
} from "@cold/core";

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  policies: jsonb("policies").$type<Record<string, unknown>>().notNull().default({}),
  settings: jsonb("settings")
    .$type<{
      postalAddress?: string;
      dmarcRua?: string;
      warmupPattern?: string;
      slackWebhookConfigured?: boolean;
      validationProvider?: "millionverifier" | "zerobounce" | "simulated" | "none";
      /** "cold": built-in peer warmup (default). "external": warmup runs in another tool; Cold only tracks dates. */
      warmupEngine?: "cold" | "external";
      dnsProvider?: "cloudflare" | "manual";
      simulation?: boolean;
      onboardingDismissed?: boolean;
      prices?: Record<string, Record<string, number>>;
    }>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of token
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Encrypted integration credentials (AES-256-GCM with APP_SECRET). */
export const secrets = pgTable(
  "secrets",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const protectedDomains = pgTable(
  "protected_domains",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("protected_domains_ws_domain").on(t.workspaceId, t.domain)],
);

/** A Google Workspace or Microsoft 365 tenant that Cold sends through. */
export const tenants = pgTable("tenants", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  provider: text("provider").$type<"google" | "microsoft">().notNull(),
  /** "simulated" uses the built-in simulator instead of real APIs. */
  transport: text("transport").$type<"api" | "simulated">().notNull().default("api"),
  vendor: text("vendor").$type<"hypertide" | "direct" | "other">().notNull().default("direct"),
  /** Microsoft: tenantId + clientId. Google: serviceAccountEmail + adminEmail. Secret material lives in `secrets`. */
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  status: text("status").$type<"untested" | "ok" | "error">().notNull().default("untested"),
  statusDetail: text("status_detail"),
  checkedAt: ts("checked_at"),
  createdAt: createdAt(),
});

export const mailboxPools = pgTable("mailbox_pools", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isCatchAll: boolean("is_catch_all").notNull().default(false),
  createdAt: createdAt(),
});

export const domains = pgTable(
  "domains",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").$type<"google" | "microsoft">().notNull(),
    tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    poolId: text("pool_id").references(() => mailboxPools.id, { onDelete: "set null" }),
    pool: text("pool").$type<Pool>().notNull().default("reserve"),
    state: text("state").$type<DomainState>().notNull().default("pending_dns"),
    previousState: text("previous_state").$type<DomainState>(),
    billingStatus: text("billing_status").$type<"active" | "recovery_pool" | "layover" | "relay" | "cancelled">().notNull().default("active"),
    vendor: text("vendor").$type<"hypertide" | "direct" | "other">().notNull().default("direct"),
    registrar: text("registrar"),
    expiresAt: ts("expires_at"),
    dnsManaged: text("dns_managed").$type<"cloudflare" | "manual">().notNull().default("manual"),
    /** Provider-specific DNS values (Google DKIM TXT, Microsoft selector CNAME targets, MX host). */
    dnsValues: jsonb("dns_values").$type<{ googleDkimValue?: string; msDkimSelector1?: string; msDkimSelector2?: string; msMxHost?: string }>().notNull().default({}),
    authVerifiedAt: ts("auth_verified_at"),
    lastDnsCheckAt: ts("last_dns_check_at"),
    lastDnsResult: jsonb("last_dns_result").$type<{ pass: boolean; items: DnsCheckItem[] }>(),
    headerTestPassedAt: ts("header_test_passed_at"),
    blocklisted: boolean("blocklisted").notNull().default(false),
    capOverride: integer("cap_override"),
    healthVerdict: text("health_verdict").$type<Verdict>().notNull().default("insufficient_data"),
    activatedAt: ts("activated_at"),
    lastResumeAt: ts("last_resume_at"),
    layoverEndsAt: ts("layover_ends_at"),
    relayEndsAt: ts("relay_ends_at"),
    retiredAt: ts("retired_at"),
    retireReason: text("retire_reason"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("domains_ws_name").on(t.workspaceId, t.name), index("domains_ws_state").on(t.workspaceId, t.state)],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    address: text("address").notNull(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    signature: text("signature").notNull().default(""),
    timezone: text("timezone").notNull().default("America/New_York"),
    state: text("state").$type<MailboxState>().notNull().default("provisioning"),
    connection: text("connection").$type<Connection>().notNull().default("unknown"),
    connectionDetail: text("connection_detail"),
    warmupStartedAt: ts("warmup_started_at"),
    warmupPausedDays: integer("warmup_paused_days").notNull().default(0),
    warmupPausedAt: ts("warmup_paused_at"),
    warmupInboxRate: doublePrecision("warmup_inbox_rate"),
    capOverride: integer("cap_override"),
    /** Seed inboxes receive header tests and diagnosis placement tests. */
    isSeed: boolean("is_seed").notNull().default(false),
    seedFamily: text("seed_family").$type<"gmail" | "google_workspace" | "outlook" | "microsoft365">(),
    syncCursor: text("sync_cursor"),
    lastSyncedAt: ts("last_synced_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mailboxes_ws_address").on(t.workspaceId, t.address), index("mailboxes_domain").on(t.domainId)],
);

export const dnsChecks = pgTable("dns_checks", {
  id: id(),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  pass: boolean("pass").notNull(),
  items: jsonb("items").$type<DnsCheckItem[]>().notNull(),
  createdAt: createdAt(),
});

export const headerTests = pgTable("header_tests", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
  source: text("source").$type<"manual" | "seed">().notNull(),
  rawHeaders: text("raw_headers").notNull(),
  spf: text("spf").notNull(),
  dkim: text("dkim").notNull(),
  dkimDomain: text("dkim_domain"),
  dkimAligned: boolean("dkim_aligned").notNull(),
  dmarc: text("dmarc").notNull(),
  pass: boolean("pass").notNull(),
  issues: jsonb("issues").$type<string[]>().notNull().default([]),
  folder: text("folder"),
  createdAt: createdAt(),
});

export const listImports = pgTable("list_imports", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").$type<"processing" | "done" | "failed">().notNull().default("processing"),
  stage: text("stage").notNull().default("queued"),
  total: integer("total").notNull().default(0),
  processed: integer("processed").notNull().default(0),
  counts: jsonb("counts").$type<Partial<Record<ProspectBucket, number>>>().notNull().default({}),
  providerMix: jsonb("provider_mix").$type<Partial<Record<RecipientProvider, number>>>().notNull().default({}),
  segBreakdown: jsonb("seg_breakdown").$type<Partial<Record<Seg, number>>>().notNull().default({}),
  validationCost: doublePrecision("validation_cost").notNull().default(0),
  validationsSaved: integer("validations_saved").notNull().default(0),
  error: text("error"),
  breakerTripped: boolean("breaker_tripped").notNull().default(false),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
});

export const prospects = pgTable(
  "prospects",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    importId: text("import_id").references(() => listImports.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    title: text("title"),
    companyDomain: text("company_domain").notNull(),
    timezone: text("timezone"),
    country: text("country"),
    state: text("state"),
    segments: jsonb("segments").$type<string[]>().notNull().default([]),
    customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
    recipientProvider: text("recipient_provider").$type<RecipientProvider>(),
    mxHost: text("mx_host"),
    seg: text("seg").$type<Seg>(),
    validationStatus: text("validation_status").$type<ValidationStatus>(),
    validatedAt: ts("validated_at"),
    isRole: boolean("is_role").notNull().default(false),
    bucket: text("bucket").$type<ProspectBucket>().notNull().default("unknown"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prospects_ws_email").on(t.workspaceId, t.email), index("prospects_ws_bucket").on(t.workspaceId, t.bucket), index("prospects_import").on(t.importId)],
);

export const mxCache = pgTable("mx_cache", {
  domain: text("domain").primaryKey(),
  hosts: jsonb("hosts").$type<string[]>().notNull(),
  provider: text("provider").$type<RecipientProvider>().notNull(),
  seg: text("seg").$type<Seg>(),
  checkedAt: ts("checked_at").notNull().defaultNow(),
});

export const validationCache = pgTable(
  "validation_cache",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status").$type<ValidationStatus>().notNull(),
    provider: text("provider").notNull(),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.email] })],
);

export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** Lowercased email, or null for a domain-level entry. */
    email: text("email"),
    domain: text("domain"),
    reason: text("reason").$type<"opt_out" | "hard_bounce" | "complaint" | "do_not_contact" | "customer" | "manual">().notNull(),
    source: text("source"),
    createdAt: createdAt(),
  },
  (t) => [index("suppressions_ws_email").on(t.workspaceId, t.email), index("suppressions_ws_domain").on(t.workspaceId, t.domain)],
);

export const campaigns = pgTable("campaigns", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").$type<"draft" | "active" | "paused" | "completed">().notNull().default("draft"),
  poolId: text("pool_id").references(() => mailboxPools.id, { onDelete: "set null" }),
  isCatchAll: boolean("is_catch_all").notNull().default(false),
  schedule: jsonb("schedule").$type<CampaignSchedule>().notNull(),
  jurisdiction: text("jurisdiction").$type<Jurisdiction>().notNull().default("us"),
  dailyNewLimit: integer("daily_new_limit"),
  createdAt: createdAt(),
  launchedAt: ts("launched_at"),
});

export const steps = pgTable("steps", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  delayDays: integer("delay_days").notNull().default(3),
});

export const variants = pgTable("variants", {
  id: id(),
  stepId: text("step_id").notNull().references(() => steps.id, { onDelete: "cascade" }),
  label: text("label").notNull().default("A"),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  standaloneBody: text("standalone_body"),
  active: boolean("active").notNull().default(true),
  pausedReason: text("paused_reason"),
  acknowledgedWarnings: jsonb("acknowledged_warnings").$type<string[]>().notNull().default([]),
});

export const controlMessages = pgTable("control_messages", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
});

export const enrollments = pgTable(
  "enrollments",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    status: text("status").$type<"active" | "replied" | "bounced" | "opted_out" | "completed" | "interrupted" | "paused">().notNull().default("active"),
    /** Index of the next step to send. */
    nextStep: integer("next_step").notNull().default(0),
    nextDueAt: ts("next_due_at"),
    threadId: text("thread_id"),
    /** RFC Message-IDs of the thread for In-Reply-To / References. */
    lastMessageId: text("last_message_id"),
    references: text("references"),
    providerThreadId: text("provider_thread_id"),
    firstSubject: text("first_subject"),
    /** Sequence moved to a new mailbox during rotation: next step goes as a new thread with standalone copy. */
    standaloneNext: boolean("standalone_next").notNull().default(false),
    reenrollAfter: ts("reenroll_after"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("enrollments_campaign_prospect").on(t.campaignId, t.prospectId), index("enrollments_ws_status").on(t.workspaceId, t.status), index("enrollments_mailbox").on(t.mailboxId)],
);

export const sends = pgTable(
  "sends",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"first_touch" | "follow_up" | "seed" | "header_test" | "warmup">().notNull(),
    enrollmentId: text("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    stepId: text("step_id"),
    stepIndex: integer("step_index"),
    variantId: text("variant_id"),
    mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id"),
    importId: text("import_id"),
    diagnosisId: text("diagnosis_id"),
    arm: text("arm").$type<"control" | "campaign">(),
    toAddress: text("to_address").notNull(),
    recipientProvider: text("recipient_provider").$type<RecipientProvider>(),
    scheduledAt: ts("scheduled_at").notNull(),
    localDate: text("local_date").notNull(),
    status: text("status").$type<"scheduled" | "sending" | "sent" | "skipped" | "failed">().notNull().default("scheduled"),
    skipReasons: jsonb("skip_reasons").$type<string[]>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    subject: text("subject"),
    body: text("body"),
    sentAt: ts("sent_at"),
    rfcMessageId: text("rfc_message_id"),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    repliedAt: ts("replied_at"),
    replyKind: text("reply_kind").$type<"human" | "auto">(),
    bouncedAt: ts("bounced_at"),
    bounceType: text("bounce_type").$type<"hard" | "soft">(),
    bounceCategory: text("bounce_category").$type<BounceCategory>(),
    placement: text("placement").$type<"inbox" | "promotions" | "spam" | "missing">(),
    /** Warmup: 0 = new conversation, 1+ = reply depth. */
    warmupDepth: integer("warmup_depth"),
    inReplyTo: text("in_reply_to"),
    referencesHdr: text("references_hdr"),
  },
  (t) => [
    index("sends_domain_sent").on(t.domainId, t.sentAt),
    index("sends_mailbox_date").on(t.mailboxId, t.localDate),
    index("sends_status_sched").on(t.status, t.scheduledAt),
    index("sends_rfc").on(t.rfcMessageId),
    index("sends_enrollment").on(t.enrollmentId),
    index("sends_campaign_sent").on(t.campaignId, t.sentAt),
    index("sends_kind_date").on(t.workspaceId, t.kind, t.localDate),
  ],
);

/** Atomic per-day counters for cap enforcement (CAP-2). */
export const capCounters = pgTable(
  "cap_counters",
  {
    scope: text("scope").$type<"mailbox" | "domain">().notNull(),
    scopeId: text("scope_id").notNull(),
    localDate: text("local_date").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scope, t.scopeId, t.localDate] })],
);

export const threads = pgTable(
  "threads",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id"),
    enrollmentId: text("enrollment_id"),
    campaignId: text("campaign_id"),
    providerThreadId: text("provider_thread_id"),
    subject: text("subject").notNull().default(""),
    counterpart: text("counterpart").notNull(),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    lastInboundAt: ts("last_inbound_at"),
    classification: text("classification"),
    intent: text("intent"),
    unread: boolean("unread").notNull().default(false),
    needsReview: boolean("needs_review").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("threads_ws_last").on(t.workspaceId, t.lastMessageAt), index("threads_provider").on(t.mailboxId, t.providerThreadId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id").notNull(),
    direction: text("direction").$type<"in" | "out">().notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    rfcMessageId: text("rfc_message_id"),
    providerMessageId: text("provider_message_id"),
    classification: text("classification"),
    intent: text("intent"),
    sendId: text("send_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread").on(t.threadId), uniqueIndex("messages_mailbox_provider").on(t.mailboxId, t.providerMessageId)],
);

export const healthWindows = pgTable(
  "health_windows",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").$type<"domain" | "campaign_pool" | "mailbox">().notNull(),
    scopeId: text("scope_id").notNull(),
    sends: integer("sends").notNull(),
    hardBounces: integer("hard_bounces").notNull(),
    humanReplies: integer("human_replies").notNull(),
    replyRate: doublePrecision("reply_rate").notNull(),
    bounceRate: doublePrecision("bounce_rate").notNull(),
    baselineReplyRate: doublePrecision("baseline_reply_rate"),
    baselineBounceRate: doublePrecision("baseline_bounce_rate"),
    baselineSource: text("baseline_source"),
    verdict: text("verdict").$type<Verdict>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    firstSendAt: ts("first_send_at"),
    lastSendAt: ts("last_send_at"),
    evaluatedAt: ts("evaluated_at").notNull().defaultNow(),
  },
  (t) => [index("health_scope").on(t.scopeType, t.scopeId, t.evaluatedAt)],
);

export const diagnoses = pgTable("diagnoses", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id"),
  trigger: text("trigger").$type<"red" | "amber" | "breaker" | "blocklist" | "manual">().notNull(),
  status: text("status").$type<"open" | "testing" | "decided" | "closed">().notNull().default("open"),
  prechecks: jsonb("prechecks").$type<Record<string, unknown>>().notNull().default({}),
  controlResult: jsonb("control_result").$type<Record<string, unknown> | null>(),
  campaignResult: jsonb("campaign_result").$type<Record<string, unknown> | null>(),
  attempt: integer("attempt").notNull().default(1),
  verdict: text("verdict").$type<DiagnosisVerdict>(),
  action: text("action"),
  headline: text("headline"),
  explanation: text("explanation"),
  decidedBy: text("decided_by"),
  overrideReason: text("override_reason"),
  testStartedAt: ts("test_started_at"),
  openedAt: ts("opened_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
});

export const rotations = pgTable("rotations", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  outgoingDomainId: text("outgoing_domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  replacementDomainId: text("replacement_domain_id").references(() => domains.id, { onDelete: "set null" }),
  diagnosisId: text("diagnosis_id"),
  mode: text("mode").$type<"immediate" | "layover">().notNull(),
  status: text("status").$type<"planned" | "executed" | "completed" | "cancelled">().notNull().default("planned"),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull().default({}),
  approvedBy: text("approved_by"),
  executedAt: ts("executed_at"),
  layoverEndsAt: ts("layover_ends_at"),
  relayEndsAt: ts("relay_ends_at"),
  migratedCount: integer("migrated_count").notNull().default(0),
  endedCount: integer("ended_count").notNull().default(0),
  threadsKept: integer("threads_kept").notNull().default(0),
  capacityBefore: integer("capacity_before"),
  capacityAfter: integer("capacity_after"),
  createdAt: createdAt(),
});

export const provisioningOrders = pgTable("provisioning_orders", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"google" | "microsoft">().notNull(),
  domainCount: integer("domain_count").notNull(),
  mailboxesPerDomain: integer("mailboxes_per_domain").notNull(),
  targetPool: text("target_pool").$type<Pool>().notNull().default("reserve"),
  status: text("status").$type<"draft" | "ordered" | "done" | "cancelled">().notNull().default("draft"),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    severity: text("severity").$type<"info" | "warning" | "critical">().notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    actionLabel: text("action_label"),
    actionHref: text("action_href"),
    status: text("status").$type<"open" | "resolved">().notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("alerts_ws_status").on(t.workspaceId, t.status), index("alerts_dedupe").on(t.workspaceId, t.dedupeKey)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorLabel: text("actor_label").notNull().default("system"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_created").on(t.workspaceId, t.createdAt)],
);

export const jobRuns = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastRunAt: ts("last_run_at"),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
});
