CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"severity" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"action_label" text,
	"action_href" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text,
	"actor_label" text DEFAULT 'system' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"pool_id" text,
	"is_catch_all" boolean DEFAULT false NOT NULL,
	"schedule" jsonb NOT NULL,
	"jurisdiction" text DEFAULT 'us' NOT NULL,
	"daily_new_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cap_counters" (
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"local_date" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cap_counters_scope_scope_id_local_date_pk" PRIMARY KEY("scope","scope_id","local_date")
);
--> statement-breakpoint
CREATE TABLE "control_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"campaign_id" text,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"prechecks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"control_result" jsonb,
	"campaign_result" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"verdict" text,
	"action" text,
	"headline" text,
	"explanation" text,
	"decided_by" text,
	"override_reason" text,
	"test_started_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dns_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"pass" boolean NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"tenant_id" text,
	"pool_id" text,
	"pool" text DEFAULT 'reserve' NOT NULL,
	"state" text DEFAULT 'pending_dns' NOT NULL,
	"previous_state" text,
	"billing_status" text DEFAULT 'active' NOT NULL,
	"vendor" text DEFAULT 'direct' NOT NULL,
	"registrar" text,
	"expires_at" timestamp with time zone,
	"dns_managed" text DEFAULT 'manual' NOT NULL,
	"dns_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_verified_at" timestamp with time zone,
	"last_dns_check_at" timestamp with time zone,
	"last_dns_result" jsonb,
	"header_test_passed_at" timestamp with time zone,
	"blocklisted" boolean DEFAULT false NOT NULL,
	"cap_override" integer,
	"health_verdict" text DEFAULT 'insufficient_data' NOT NULL,
	"activated_at" timestamp with time zone,
	"last_resume_at" timestamp with time zone,
	"layover_ends_at" timestamp with time zone,
	"relay_ends_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"prospect_id" text NOT NULL,
	"mailbox_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"next_step" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone,
	"thread_id" text,
	"last_message_id" text,
	"references" text,
	"provider_thread_id" text,
	"first_subject" text,
	"standalone_next" boolean DEFAULT false NOT NULL,
	"reenroll_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "header_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"mailbox_id" text,
	"source" text NOT NULL,
	"raw_headers" text NOT NULL,
	"spf" text NOT NULL,
	"dkim" text NOT NULL,
	"dkim_domain" text,
	"dkim_aligned" boolean NOT NULL,
	"dmarc" text NOT NULL,
	"pass" boolean NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"sends" integer NOT NULL,
	"hard_bounces" integer NOT NULL,
	"human_replies" integer NOT NULL,
	"reply_rate" double precision NOT NULL,
	"bounce_rate" double precision NOT NULL,
	"baseline_reply_rate" double precision,
	"baseline_bounce_rate" double precision,
	"baseline_source" text,
	"verdict" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_send_at" timestamp with time zone,
	"last_send_at" timestamp with time zone,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "list_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_mix" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seg_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_cost" double precision DEFAULT 0 NOT NULL,
	"validations_saved" integer DEFAULT 0 NOT NULL,
	"error" text,
	"breaker_tripped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mailbox_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"is_catch_all" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain_id" text,
	"tenant_id" text,
	"address" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"connection" text DEFAULT 'unknown' NOT NULL,
	"connection_detail" text,
	"warmup_started_at" timestamp with time zone,
	"warmup_paused_days" integer DEFAULT 0 NOT NULL,
	"warmup_paused_at" timestamp with time zone,
	"warmup_inbox_rate" double precision,
	"cap_override" integer,
	"is_seed" boolean DEFAULT false NOT NULL,
	"seed_family" text,
	"sync_cursor" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"direction" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rfc_message_id" text,
	"provider_message_id" text,
	"classification" text,
	"intent" text,
	"send_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mx_cache" (
	"domain" text PRIMARY KEY NOT NULL,
	"hosts" jsonb NOT NULL,
	"provider" text NOT NULL,
	"seg" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"import_id" text,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"company" text,
	"title" text,
	"company_domain" text NOT NULL,
	"timezone" text,
	"country" text,
	"state" text,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_provider" text,
	"mx_host" text,
	"seg" text,
	"validation_status" text,
	"validated_at" timestamp with time zone,
	"is_role" boolean DEFAULT false NOT NULL,
	"bucket" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"domain_count" integer NOT NULL,
	"mailboxes_per_domain" integer NOT NULL,
	"target_pool" text DEFAULT 'reserve' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"outgoing_domain_id" text NOT NULL,
	"replacement_domain_id" text,
	"diagnosis_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text,
	"executed_at" timestamp with time zone,
	"layover_ends_at" timestamp with time zone,
	"relay_ends_at" timestamp with time zone,
	"migrated_count" integer DEFAULT 0 NOT NULL,
	"ended_count" integer DEFAULT 0 NOT NULL,
	"threads_kept" integer DEFAULT 0 NOT NULL,
	"capacity_before" integer,
	"capacity_after" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "sends" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"enrollment_id" text,
	"campaign_id" text,
	"step_id" text,
	"step_index" integer,
	"variant_id" text,
	"mailbox_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"prospect_id" text,
	"import_id" text,
	"diagnosis_id" text,
	"arm" text,
	"to_address" text NOT NULL,
	"recipient_provider" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"local_date" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"skip_reasons" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"subject" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"rfc_message_id" text,
	"provider_message_id" text,
	"provider_thread_id" text,
	"replied_at" timestamp with time zone,
	"reply_kind" text,
	"bounced_at" timestamp with time zone,
	"bounce_type" text,
	"bounce_category" text,
	"placement" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"position" integer NOT NULL,
	"delay_days" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text,
	"domain" text,
	"reason" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"transport" text DEFAULT 'api' NOT NULL,
	"vendor" text DEFAULT 'direct' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"status_detail" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"prospect_id" text,
	"enrollment_id" text,
	"campaign_id" text,
	"provider_thread_id" text,
	"subject" text DEFAULT '' NOT NULL,
	"counterpart" text NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"classification" text,
	"intent" text,
	"unread" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "validation_cache" (
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_cache_workspace_id_email_pk" PRIMARY KEY("workspace_id","email")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"step_id" text NOT NULL,
	"label" text DEFAULT 'A' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"standalone_body" text,
	"active" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"acknowledged_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_pool_id_mailbox_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."mailbox_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_messages" ADD CONSTRAINT "control_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_checks" ADD CONSTRAINT "dns_checks_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_pool_id_mailbox_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."mailbox_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "header_tests" ADD CONSTRAINT "header_tests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "header_tests" ADD CONSTRAINT "header_tests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "header_tests" ADD CONSTRAINT "header_tests_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_windows" ADD CONSTRAINT "health_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_imports" ADD CONSTRAINT "list_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_pools" ADD CONSTRAINT "mailbox_pools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_import_id_list_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."list_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_domains" ADD CONSTRAINT "protected_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_orders" ADD CONSTRAINT "provisioning_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_outgoing_domain_id_domains_id_fk" FOREIGN KEY ("outgoing_domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotations" ADD CONSTRAINT "rotations_replacement_domain_id_domains_id_fk" FOREIGN KEY ("replacement_domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cache" ADD CONSTRAINT "validation_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_ws_status" ON "alerts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "alerts_dedupe" ON "alerts" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "audit_ws_created" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_ws_name" ON "domains" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "domains_ws_state" ON "domains" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_campaign_prospect" ON "enrollments" USING btree ("campaign_id","prospect_id");--> statement-breakpoint
CREATE INDEX "enrollments_ws_status" ON "enrollments" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "enrollments_mailbox" ON "enrollments" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "health_scope" ON "health_windows" USING btree ("scope_type","scope_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_ws_address" ON "mailboxes" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "mailboxes_domain" ON "mailboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_provider" ON "messages" USING btree ("mailbox_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_ws_email" ON "prospects" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "prospects_ws_bucket" ON "prospects" USING btree ("workspace_id","bucket");--> statement-breakpoint
CREATE INDEX "prospects_import" ON "prospects" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protected_domains_ws_domain" ON "protected_domains" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "sends_domain_sent" ON "sends" USING btree ("domain_id","sent_at");--> statement-breakpoint
CREATE INDEX "sends_mailbox_date" ON "sends" USING btree ("mailbox_id","local_date");--> statement-breakpoint
CREATE INDEX "sends_status_sched" ON "sends" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "sends_rfc" ON "sends" USING btree ("rfc_message_id");--> statement-breakpoint
CREATE INDEX "sends_enrollment" ON "sends" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "sends_campaign_sent" ON "sends" USING btree ("campaign_id","sent_at");--> statement-breakpoint
CREATE INDEX "suppressions_ws_email" ON "suppressions" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "suppressions_ws_domain" ON "suppressions" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "threads_ws_last" ON "threads" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE INDEX "threads_provider" ON "threads" USING btree ("mailbox_id","provider_thread_id");