/** Workspace context, secrets, audit log, alerts and notifications. */
import { and, eq } from "drizzle-orm";
import type { Policies, Role } from "@cold/core";
import { resolvePolicies, warmupDays } from "@cold/core";
import { getDb, schema } from "../db/client";
import { decrypt, encrypt } from "../lib/crypto";
import { notifySlack } from "../adapters/external";
import type { MailboxCtx, SimProfile } from "../adapters/transport";

const { workspaces, secrets, auditEvents, alerts, protectedDomains, tenants } = schema;

export interface Actor {
  id: string | null;
  label: string;
  role: Role;
}

export const SYSTEM: Actor = { id: null, label: "system", role: "owner" };

export type Workspace = typeof workspaces.$inferSelect;

export async function getWorkspace(id: string): Promise<Workspace> {
  const [ws] = await getDb().select().from(workspaces).where(eq(workspaces.id, id));
  if (!ws) throw new Error(`Workspace ${id} not found`);
  return ws;
}

export async function getPolicies(workspaceId: string): Promise<Policies> {
  const ws = await getWorkspace(workspaceId);
  return resolvePolicies(ws.policies);
}

export async function listWorkspaceIds(): Promise<string[]> {
  return (await getDb().select({ id: workspaces.id }).from(workspaces)).map((w) => w.id);
}

export async function getProtectedDomains(workspaceId: string): Promise<string[]> {
  return (await getDb().select({ d: protectedDomains.domain }).from(protectedDomains).where(eq(protectedDomains.workspaceId, workspaceId))).map((r) => r.d);
}

// ───────────── Secrets ─────────────

export async function setSecret(workspaceId: string, key: string, value: string | null) {
  const db = getDb();
  if (value === null || value === "") {
    await db.delete(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.key, key)));
    return;
  }
  await db
    .insert(secrets)
    .values({ workspaceId, key, value: encrypt(value) })
    .onConflictDoUpdate({ target: [secrets.workspaceId, secrets.key], set: { value: encrypt(value), updatedAt: new Date() } });
}

export async function getSecret(workspaceId: string, key: string): Promise<string | null> {
  const [row] = await getDb().select().from(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.key, key)));
  if (!row) return null;
  try {
    return decrypt(row.value);
  } catch {
    return null;
  }
}

export async function hasSecret(workspaceId: string, key: string): Promise<boolean> {
  const [row] = await getDb().select({ k: secrets.key }).from(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.key, key)));
  return !!row;
}

// ───────────── Audit ─────────────

export async function audit(workspaceId: string, actor: Actor, action: string, entity?: { type: string; id: string } | null, detail: Record<string, unknown> = {}, reason?: string | null) {
  await getDb()
    .insert(auditEvents)
    .values({ workspaceId, actorId: actor.id, actorLabel: actor.label, action, entityType: entity?.type, entityId: entity?.id, detail, reason: reason ?? null });
}

// ───────────── Alerts ─────────────

export interface AlertInput {
  severity: "info" | "warning" | "critical";
  kind: string;
  key: string;
  title: string;
  body?: string;
  entity?: { type: string; id: string };
  action?: { label: string; href: string };
  notify?: boolean;
}

/** Open (or refresh) an alert. Deduplicated by key while open. */
export async function raiseAlert(workspaceId: string, a: AlertInput) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.dedupeKey, a.key), eq(alerts.status, "open")));
  if (existing) {
    await db.update(alerts).set({ title: a.title, body: a.body ?? "", severity: a.severity }).where(eq(alerts.id, existing.id));
    return existing.id;
  }
  const [row] = await db
    .insert(alerts)
    .values({
      workspaceId,
      severity: a.severity,
      kind: a.kind,
      dedupeKey: a.key,
      title: a.title,
      body: a.body ?? "",
      entityType: a.entity?.type,
      entityId: a.entity?.id,
      actionLabel: a.action?.label,
      actionHref: a.action?.href,
    })
    .returning();
  if (a.notify ?? a.severity !== "info") await notify(workspaceId, `${a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟠" : "🔵"} ${a.title}${a.body ? `\n${a.body}` : ""}`);
  return row.id;
}

export async function resolveAlert(workspaceId: string, key: string) {
  await getDb()
    .update(alerts)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(alerts.workspaceId, workspaceId), eq(alerts.dedupeKey, key), eq(alerts.status, "open")));
}

export async function notify(workspaceId: string, text: string) {
  const url = await getSecret(workspaceId, "slack.webhookUrl");
  if (url) await notifySlack(url, text);
}

// ───────────── Mailbox context ─────────────

type MailboxRow = typeof schema.mailboxes.$inferSelect;
type DomainRow = typeof schema.domains.$inferSelect;
type TenantRow = typeof schema.tenants.$inferSelect;

const tenantSecretKey = (tenant: TenantRow) => (tenant.provider === "microsoft" ? `tenant:${tenant.id}:clientSecret` : `tenant:${tenant.id}:serviceAccountKey`);

export async function setTenantSecret(workspaceId: string, tenant: TenantRow, value: string | null) {
  await setSecret(workspaceId, tenantSecretKey(tenant), value);
}

export async function tenantHasSecret(workspaceId: string, tenant: TenantRow) {
  return hasSecret(workspaceId, tenantSecretKey(tenant));
}

export async function mailboxCtx(mb: MailboxRow, domainName: string, tenant: TenantRow | null): Promise<MailboxCtx> {
  const t = tenant ?? { id: "none", provider: "google", transport: "simulated", config: {} as Record<string, string> };
  const secret = tenant && tenant.transport === "api" ? await getSecret(mb.workspaceId, tenantSecretKey(tenant)) : null;
  return {
    id: mb.id,
    address: mb.address,
    displayName: [mb.firstName, mb.lastName].filter(Boolean).join(" ") || mb.address,
    domainName,
    tenant: { id: t.id, provider: t.provider as "google" | "microsoft", transport: t.transport as "api" | "simulated", config: t.config, secret },
  };
}

export async function loadTenant(id: string | null): Promise<TenantRow | null> {
  if (!id) return null;
  const [t] = await getDb().select().from(tenants).where(eq(tenants.id, id));
  return t ?? null;
}

/** Simulation profile for a domain (demo mode only). Stored in workspace settings. */
export function simProfile(ws: Workspace, domain: DomainRow): SimProfile | null {
  const profiles = (ws.settings as any).simProfiles as Record<string, SimProfile> | undefined;
  return profiles?.[domain.name] ?? null;
}

export function mailboxWarmupDays(mb: MailboxRow, now = new Date()) {
  return warmupDays(mb, now);
}
