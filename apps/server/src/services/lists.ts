/**
 * List hygiene pipeline (SPEC §6.7, playbook rule 8):
 * import → normalize/dedupe → MX classify (free) → SEG removal → suppression →
 * paid validation only for survivors (with a 30-day cache) → buckets → report.
 */
import Papa from "papaparse";
import { and, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { ProspectBucket, RecipientProvider, Seg, ValidationStatus } from "@cold/core";
import {
  bucketFor,
  classifyMx,
  emailDomain,
  emailKey,
  guessColumnMapping,
  isDisposableDomain,
  isRoleAddress,
  isValidEmailSyntax,
  normalizeEmail,
} from "@cold/core";
import { getDb, schema } from "../db/client";
import { badRequest, mapLimit, notFound } from "../lib/http";
import { resolveMx, simulatedMx } from "../adapters/dns";
import { millionVerifier, simulatedValidator, zeroBounce, type Validator } from "../adapters/validation";
import type { Actor } from "./common";
import { audit, getPolicies, getSecret, getWorkspace, raiseAlert } from "./common";

const { listImports, prospects, mxCache, validationCache, suppressions, enrollments, campaigns } = schema;

const FIELDS = ["email", "firstName", "lastName", "company", "title", "timezone", "country", "state", "segment", "website"] as const;

export async function createImport(workspaceId: string, actor: Actor, input: { name: string; csv: string; mapping?: Record<string, string>; segments?: string[] }) {
  const db = getDb();
  const parsed = Papa.parse<Record<string, string>>(input.csv, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const headers = parsed.meta.fields ?? [];
  const mapping = input.mapping && Object.keys(input.mapping).length ? input.mapping : guessColumnMapping(headers);
  const emailCol = Object.entries(mapping).find(([, f]) => f === "email")?.[0];
  if (!emailCol) throw badRequest("Couldn't find an email column. Map one of your columns to Email.", { headers });
  if (parsed.data.length > 200_000) throw badRequest("Import at most 200,000 rows at a time.");

  const [imp] = await db.insert(listImports).values({ workspaceId, name: input.name || "Import", total: parsed.data.length, stage: "parsing" }).returning();

  const seen = new Set<string>();
  const rows: (typeof prospects.$inferInsert)[] = [];
  let duplicates = 0;
  let invalidSyntax = 0;
  for (const raw of parsed.data) {
    const rec: Record<string, string> = {};
    const custom: Record<string, string> = {};
    for (const [col, val] of Object.entries(raw)) {
      const f = mapping[col];
      if (f && (FIELDS as readonly string[]).includes(f)) rec[f] = String(val ?? "").trim();
      else if (val) custom[col] = String(val).trim();
    }
    const email = normalizeEmail(rec.email ?? "");
    if (!email) continue;
    const key = emailKey(email);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const valid = isValidEmailSyntax(email);
    if (!valid) invalidSyntax++;
    const segs = [...(input.segments ?? []), ...(rec.segment ? rec.segment.split(/[;,|]/).map((s) => s.trim().toLowerCase().replace(/[\s-]+/g, "_")) : [])].filter(Boolean);
    rows.push({
      workspaceId,
      importId: imp.id,
      email: key,
      firstName: rec.firstName || null,
      lastName: rec.lastName || null,
      company: rec.company || null,
      title: rec.title || null,
      timezone: rec.timezone || null,
      country: rec.country || null,
      state: rec.state || null,
      companyDomain: emailDomain(key),
      segments: [...new Set(segs)],
      customFields: custom,
      isRole: isRoleAddress(key),
      bucket: valid ? "unknown" : "invalid",
    });
  }

  // Skip prospects that already exist in the workspace (one record per address).
  const existing = new Set<string>();
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000).map((r) => r.email);
    const found = await db.select({ email: prospects.email }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.email, chunk)));
    for (const f of found) existing.add(f.email);
  }
  const fresh = rows.filter((r) => !existing.has(r.email));
  duplicates += rows.length - fresh.length;
  for (let i = 0; i < fresh.length; i += 1000) await db.insert(prospects).values(fresh.slice(i, i + 1000)).onConflictDoNothing();

  await db
    .update(listImports)
    .set({ stage: "queued", counts: { duplicate: duplicates }, total: fresh.length + duplicates })
    .where(eq(listImports.id, imp.id));
  await audit(workspaceId, actor, "list.imported", { type: "import", id: imp.id }, { rows: parsed.data.length, new: fresh.length, duplicates, invalidSyntax });
  void processImport(imp.id).catch(async (e) => {
    await db.update(listImports).set({ status: "failed", error: String(e?.message ?? e) }).where(eq(listImports.id, imp.id));
  });
  return { ...imp, mapping };
}

async function validatorFor(workspaceId: string): Promise<{ v: Validator | null; price: number }> {
  const ws = await getWorkspace(workspaceId);
  const price = Number((ws.settings.prices as any)?.validationPerEmail ?? 0.002);
  if (ws.settings.simulation) return { v: simulatedValidator, price: 0 };
  const provider = ws.settings.validationProvider ?? "none";
  if (provider === "millionverifier") {
    const key = await getSecret(workspaceId, "validation.apiKey");
    return { v: key ? millionVerifier(key) : null, price };
  }
  if (provider === "zerobounce") {
    const key = await getSecret(workspaceId, "validation.apiKey");
    return { v: key ? zeroBounce(key) : null, price };
  }
  if (provider === "simulated") return { v: simulatedValidator, price: 0 };
  return { v: null, price };
}

async function mxFor(domainsList: string[], simulated: boolean): Promise<Map<string, { hosts: string[]; provider: RecipientProvider; seg: Seg | null }>> {
  const db = getDb();
  const out = new Map<string, { hosts: string[]; provider: RecipientProvider; seg: Seg | null }>();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  for (let i = 0; i < domainsList.length; i += 1000) {
    const chunk = domainsList.slice(i, i + 1000);
    const cached = await db.select().from(mxCache).where(and(inArray(mxCache.domain, chunk), gte(mxCache.checkedAt, weekAgo)));
    for (const c of cached) out.set(c.domain, { hosts: c.hosts, provider: c.provider, seg: c.seg });
  }
  const missing = domainsList.filter((d) => !out.has(d));
  await mapLimit(missing, 24, async (d) => {
    const hosts = simulated ? simulatedMx(d) : (await resolveMx(d)).map((m) => m.exchange);
    const c = classifyMx(hosts);
    out.set(d, { hosts, provider: c.provider, seg: c.seg });
    await db
      .insert(mxCache)
      .values({ domain: d, hosts, provider: c.provider, seg: c.seg, checkedAt: new Date() })
      .onConflictDoUpdate({ target: mxCache.domain, set: { hosts, provider: c.provider, seg: c.seg, checkedAt: new Date() } });
  });
  return out;
}

export async function processImport(importId: string) {
  const db = getDb();
  const [imp] = await db.select().from(listImports).where(eq(listImports.id, importId));
  if (!imp || imp.status !== "processing") return;
  const workspaceId = imp.workspaceId;
  const ws = await getWorkspace(workspaceId);
  const policies = await getPolicies(workspaceId);
  const simulated = !!ws.settings.simulation;
  const setStage = (stage: string, extra: Partial<typeof listImports.$inferInsert> = {}) => db.update(listImports).set({ stage, ...extra }).where(eq(listImports.id, importId));

  const rows = await db
    .select({ id: prospects.id, email: prospects.email, companyDomain: prospects.companyDomain, bucket: prospects.bucket })
    .from(prospects)
    .where(eq(prospects.importId, importId));

  // 1. MX classification (free, in-house DNS)
  await setStage("Checking mail servers (MX)");
  const domainsList = [...new Set(rows.map((r) => r.companyDomain))];
  const mx = await mxFor(domainsList, simulated);
  for (const [domain, info] of mx) {
    await db
      .update(prospects)
      .set({ recipientProvider: info.provider, mxHost: info.hosts[0] ?? null, seg: info.seg })
      .where(and(eq(prospects.importId, importId), eq(prospects.companyDomain, domain)));
  }

  // 2. Suppression (global, survives domain rotation)
  await setStage("Applying suppression list");
  const sup = await db.select({ email: suppressions.email, domain: suppressions.domain }).from(suppressions).where(eq(suppressions.workspaceId, workspaceId));
  const supEmails = new Set(sup.map((s) => s.email).filter(Boolean) as string[]);
  const supDomains = new Set(sup.map((s) => s.domain).filter(Boolean) as string[]);

  // 3. Decide who needs paid validation
  const ttl = new Date(Date.now() - policies.lists.validationTtlDays * 86_400_000);
  type Row = (typeof rows)[number] & { provider: RecipientProvider; seg: Seg | null; suppressed: boolean; syntax: boolean };
  const enriched: Row[] = rows.map((r) => {
    const info = mx.get(r.companyDomain);
    return {
      ...r,
      provider: info?.provider ?? "none",
      seg: info?.seg ?? null,
      suppressed: supEmails.has(r.email) || supDomains.has(r.companyDomain),
      syntax: r.bucket !== "invalid",
    };
  });
  const candidates = enriched.filter(
    (r) => r.syntax && !r.suppressed && r.provider !== "none" && !(r.seg && policies.lists.blockedSegs.includes(r.seg)) && !isDisposableDomain(r.companyDomain),
  );
  const status = new Map<string, ValidationStatus>();
  for (let i = 0; i < candidates.length; i += 1000) {
    const chunk = candidates.slice(i, i + 1000).map((c) => c.email);
    const cached = await db
      .select()
      .from(validationCache)
      .where(and(eq(validationCache.workspaceId, workspaceId), inArray(validationCache.email, chunk), gte(validationCache.checkedAt, ttl)));
    for (const c of cached) status.set(c.email, c.status);
  }
  const need = candidates.filter((c) => !status.has(c.email)).map((c) => c.email);
  const { v, price } = await validatorFor(workspaceId);
  await setStage(v ? `Validating ${need.length.toLocaleString()} addresses` : "Waiting for a validation provider", { processed: 0 });
  let validatedNow = 0;
  if (v && need.length) {
    for (let i = 0; i < need.length; i += 250) {
      const chunk = need.slice(i, i + 250);
      const res = await v.validate(chunk);
      const now = new Date();
      const cacheRows = [...res].map(([email, s]) => ({ workspaceId, email, status: s, provider: v.name, checkedAt: now }));
      if (cacheRows.length)
        await db
          .insert(validationCache)
          .values(cacheRows)
          .onConflictDoUpdate({ target: [validationCache.workspaceId, validationCache.email], set: { status: sql`excluded.status`, provider: sql`excluded.provider`, checkedAt: sql`excluded.checked_at` } });
      for (const [email, s] of res) status.set(email, s);
      validatedNow += chunk.length;
      await db.update(listImports).set({ processed: validatedNow }).where(eq(listImports.id, importId));
    }
  }

  // 4. Buckets
  await setStage("Sorting into buckets");
  const counts: Partial<Record<ProspectBucket, number>> = { ...(imp.counts ?? {}) };
  const mix: Partial<Record<RecipientProvider, number>> = {};
  const segBreakdown: Partial<Record<Seg, number>> = {};
  const byBucket = new Map<ProspectBucket, string[]>();
  const validatedAt = new Map<string, Date>();
  const now = new Date();
  for (const r of enriched) {
    const vs = isDisposableDomain(r.companyDomain) ? ("disposable" as const) : (status.get(r.email) ?? null);
    const bucket = bucketFor({
      suppressed: r.suppressed,
      syntaxValid: r.syntax,
      seg: r.seg,
      blockedSegs: policies.lists.blockedSegs,
      provider: r.provider,
      validation: vs,
      unknownWithCatchAll: policies.lists.unknownWithCatchAll,
    });
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if (bucket === "ready" || bucket === "catch_all") mix[r.provider] = (mix[r.provider] ?? 0) + 1;
    if (r.seg) segBreakdown[r.seg] = (segBreakdown[r.seg] ?? 0) + 1;
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), r.id]);
    if (vs) validatedAt.set(r.id, now);
  }
  for (const [bucket, ids] of byBucket) {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await db.update(prospects).set({ bucket }).where(inArray(prospects.id, chunk));
    }
  }
  // validation status per prospect
  const statusGroups = new Map<ValidationStatus, string[]>();
  for (const r of enriched) {
    const s = isDisposableDomain(r.companyDomain) ? "disposable" : status.get(r.email);
    if (s) statusGroups.set(s, [...(statusGroups.get(s) ?? []), r.id]);
  }
  for (const [s, ids] of statusGroups) {
    for (let i = 0; i < ids.length; i += 1000) await db.update(prospects).set({ validationStatus: s, validatedAt: now }).where(inArray(prospects.id, ids.slice(i, i + 1000)));
  }

  await db
    .update(listImports)
    .set({
      status: "done",
      stage: v || need.length === 0 ? "Done" : "Done (no validation provider: addresses left unvalidated)",
      counts,
      providerMix: mix,
      segBreakdown,
      validationCost: Math.round(validatedNow * price * 100) / 100,
      validationsSaved: rows.length - validatedNow,
      completedAt: new Date(),
    })
    .where(eq(listImports.id, importId));

  if (!v && need.length)
    await raiseAlert(workspaceId, {
      severity: "warning",
      kind: "validation_missing",
      key: "validation_missing",
      title: "Connect an email validation provider",
      body: `${need.length.toLocaleString()} addresses from "${imp.name}" are unvalidated and won't be sent to. Playbook rule 8: validate every address.`,
      action: { label: "Connect", href: "/settings/integrations" },
    });
}

export async function resumeStuckImports() {
  const db = getDb();
  const stuck = await db.select({ id: listImports.id }).from(listImports).where(eq(listImports.status, "processing"));
  for (const s of stuck) await processImport(s.id).catch(() => undefined);
}

export async function listImportsFor(workspaceId: string) {
  return getDb().select().from(listImports).where(eq(listImports.workspaceId, workspaceId)).orderBy(sql`${listImports.createdAt} desc`);
}

export async function getImport(workspaceId: string, id: string) {
  const [imp] = await getDb().select().from(listImports).where(and(eq(listImports.workspaceId, workspaceId), eq(listImports.id, id)));
  if (!imp) throw notFound("List not found");
  return imp;
}

export async function listProspects(workspaceId: string, q: { importId?: string; bucket?: string; search?: string; limit?: number; offset?: number }) {
  const conds = [eq(prospects.workspaceId, workspaceId)];
  if (q.importId) conds.push(eq(prospects.importId, q.importId));
  if (q.bucket) conds.push(eq(prospects.bucket, q.bucket as ProspectBucket));
  if (q.search) conds.push(or(sql`${prospects.email} ilike ${"%" + q.search + "%"}`, sql`${prospects.company} ilike ${"%" + q.search + "%"}`)!);
  const db = getDb();
  const rows = await db
    .select()
    .from(prospects)
    .where(and(...conds))
    .orderBy(prospects.email)
    .limit(Math.min(q.limit ?? 100, 500))
    .offset(q.offset ?? 0);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(prospects).where(and(...conds));
  return { rows, total: n };
}

export async function exportProspectsCsv(workspaceId: string, importId: string, bucket: string) {
  const rows = await getDb()
    .select()
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.importId, importId), eq(prospects.bucket, bucket as ProspectBucket)));
  return Papa.unparse(
    rows.map((r) => ({ email: r.email, first_name: r.firstName ?? "", last_name: r.lastName ?? "", company: r.company ?? "", title: r.title ?? "", provider: r.recipientProvider ?? "", gateway: r.seg ?? "", validation: r.validationStatus ?? "" })),
  );
}

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const key = emailKey(email);
  const [row] = await getDb()
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), or(eq(suppressions.email, key), eq(suppressions.domain, emailDomain(key)))))
    .limit(1);
  return !!row;
}

export async function suppress(workspaceId: string, entry: { email?: string | null; domain?: string | null; reason: (typeof suppressions.$inferInsert)["reason"]; source?: string }) {
  const db = getDb();
  const email = entry.email ? emailKey(entry.email) : null;
  const domain = entry.domain ? entry.domain.toLowerCase() : null;
  if (!email && !domain) throw badRequest("Email or domain required");
  const [exists] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, workspaceId), email ? eq(suppressions.email, email) : and(isNull(suppressions.email), eq(suppressions.domain, domain!))))
    .limit(1);
  if (exists) return;
  await db.insert(suppressions).values({ workspaceId, email, domain: email ? null : domain, reason: entry.reason, source: entry.source });
  // Stop any active sequences right away (I-9).
  const targets = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), email ? eq(prospects.email, email) : eq(prospects.companyDomain, domain!)));
  if (targets.length) {
    await db
      .update(prospects)
      .set({ bucket: "suppressed" })
      .where(inArray(prospects.id, targets.map((t) => t.id)));
    await db
      .update(enrollments)
      .set({ status: "opted_out" })
      .where(and(inArray(enrollments.prospectId, targets.map((t) => t.id)), inArray(enrollments.status, ["active", "paused"])));
  }
}

/** Enroll sendable prospects (ready, or catch-all for catch-all campaigns) into a campaign (LST-5, I-6). */
export async function enrollProspects(workspaceId: string, actor: Actor, campaignId: string, filter: { importIds?: string[]; segment?: string; limit?: number }) {
  const db = getDb();
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)));
  if (!c) throw notFound("Campaign not found");
  const bucket: ProspectBucket = c.isCatchAll ? "catch_all" : "ready";
  const conds = [eq(prospects.workspaceId, workspaceId), eq(prospects.bucket, bucket)];
  if (filter.importIds?.length) conds.push(inArray(prospects.importId, filter.importIds));
  if (filter.segment) conds.push(sql`${prospects.segments} @> ${JSON.stringify([filter.segment])}::jsonb`);
  const busy = db
    .select({ id: enrollments.prospectId })
    .from(enrollments)
    .where(or(eq(enrollments.campaignId, campaignId), inArray(enrollments.status, ["active", "paused"])));
  conds.push(notInArray(prospects.id, busy));
  const candidates = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(...conds))
    .limit(Math.min(filter.limit ?? 100_000, 100_000));
  for (let i = 0; i < candidates.length; i += 1000) {
    await db
      .insert(enrollments)
      .values(candidates.slice(i, i + 1000).map((p) => ({ workspaceId, campaignId, prospectId: p.id })))
      .onConflictDoNothing();
  }
  await audit(workspaceId, actor, "campaign.enrolled", { type: "campaign", id: campaignId }, { count: candidates.length, bucket, ...filter });
  return { enrolled: candidates.length, bucket };
}
