/**
 * Demo workspace: simulated Microsoft + Google tenants, active and reserve domains, a list,
 * a running campaign, 30 days of history, and one domain that is burning, so the full
 * detect → diagnose → rotate loop can be explored without real mailboxes.
 */
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { seededRandom } from "@cold/core";
import { getDb, schema } from "../db/client";
import { hashPassword } from "../lib/crypto";
import { newMessageId } from "../lib/mime";
import { createWorkspace } from "../services/auth";
import { SYSTEM } from "../services/common";
import { addMailboxes } from "../services/domains";
import { createImport } from "../services/lists";
import { createCampaign, sequence } from "../services/campaigns";
import { enrollProspects } from "../services/lists";
import { evaluateWorkspaceHealth } from "../services/health";

export const DEMO_LOGIN = { email: "demo@cold.local", password: "cold-demo-2026" };

const { users, memberships, protectedDomains, tenants, domains, mailboxes, sends, threads, messages, campaigns, variants, prospects, listImports, enrollments } = schema;

const FIRST = ["Ava", "Liam", "Noah", "Emma", "Mia", "Lucas", "Ethan", "Zoe", "Maya", "Owen", "Ella", "Leo", "Nora", "Eli", "Ivy", "Jack", "Ruby", "Finn", "Lena", "Omar", "Priya", "Diego", "Hana", "Marco", "Sofia", "Tariq", "Grace", "Kenji", "Amara", "Jonas"];
const LAST = ["Patel", "Nguyen", "Garcia", "Smith", "Johnson", "Kim", "Chen", "Lopez", "Brown", "Davis", "Miller", "Wilson", "Moore", "Taylor", "Clark", "Hall", "Young", "King", "Wright", "Scott"];
const CO = ["Northwind", "Bluepeak", "Ridgeline", "Harbor", "Lumen", "Copperleaf", "Brightwave", "Summit", "Evergreen", "Ironclad", "Keystone", "Clearwater", "Redwood", "Silverline", "Oakmont", "Pinecrest", "Starboard", "Trailhead", "Wavecrest", "Granite"];
const SUFFIX = ["logistics", "health", "labs", "systems", "group", "partners", "foods", "dental", "realty", "freight", "clinics", "solar", "capital", "studio", "works"];
const TITLES = ["Head of Operations", "VP Operations", "COO", "Operations Manager", "Director of Ops", "Founder", "General Manager"];
const STATES = ["NY", "CA", "TX", "FL", "IL", "WA", "MA", "CO", "GA", "NC"];

const REPLIES: { body: string; intent: string }[] = [
  { body: "Interested. Can you send over a bit more detail on how this works?", intent: "positive" },
  { body: "Sounds interesting, tell me more. What does pricing look like for a team of 20?", intent: "positive" },
  { body: "Happy to chat next week, Tuesday afternoon works.", intent: "positive" },
  { body: "Not interested, thanks.", intent: "not_interested" },
  { body: "We're all set for now.", intent: "not_interested" },
  { body: "What would this look like for a company our size?", intent: "question" },
  { body: "You should talk to Dana on our ops team, the right person is dana@{domain}", intent: "referral" },
];

export async function seedDemo() {
  const db = getDb();
  const rand = seededRandom("cold-demo");
  const ws = await createWorkspace("Demo Co", "America/New_York", {
    simulation: true,
    postalAddress: "Demo Co, 100 Main St, Austin, TX 78701",
    validationProvider: "simulated",
    simProfiles: {
      "getdemoco.com": { replyRate: 0.004, bounceRate: 0.045, placement: "burned" },
    },
  });
  const [user] = await db.insert(users).values({ email: DEMO_LOGIN.email, name: "Demo Owner", passwordHash: await hashPassword(DEMO_LOGIN.password) }).returning();
  await db.insert(memberships).values({ userId: user.id, workspaceId: ws.id, role: "owner" });
  await db.insert(protectedDomains).values({ workspaceId: ws.id, domain: "democo.com" });

  const [ms] = await db.insert(tenants).values({ workspaceId: ws.id, name: "Hypertide Microsoft (simulated)", provider: "microsoft", transport: "simulated", vendor: "hypertide", status: "ok" }).returning();
  const [gw] = await db.insert(tenants).values({ workspaceId: ws.id, name: "Google Workspace (simulated)", provider: "google", transport: "simulated", vendor: "direct", status: "ok" }).returning();
  const pool = (await db.select().from(schema.mailboxPools).where(eq(schema.mailboxPools.workspaceId, ws.id))).find((p) => !p.isCatchAll)!;
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  const plan: { name: string; provider: "microsoft" | "google"; pool: "active" | "reserve"; state: any; warm: number | null; boxes: number }[] = [
    { name: "getdemoco.com", provider: "microsoft", pool: "active", state: "active", warm: 62, boxes: 25 },
    { name: "trydemoco.com", provider: "microsoft", pool: "active", state: "active", warm: 62, boxes: 25 },
    { name: "usedemoco.com", provider: "microsoft", pool: "active", state: "active", warm: 48, boxes: 25 },
    { name: "democohq.com", provider: "google", pool: "active", state: "active", warm: 40, boxes: 3 },
    { name: "democoteam.com", provider: "microsoft", pool: "reserve", state: "ready", warm: 33, boxes: 25 },
    { name: "meetdemoco.com", provider: "microsoft", pool: "reserve", state: "warming", warm: 9, boxes: 25 },
    { name: "hellodemoco.com", provider: "microsoft", pool: "reserve", state: "pending_dns", warm: null, boxes: 0 },
    { name: "seedcheck.net", provider: "google", pool: "reserve", state: "auth_verified", warm: null, boxes: 0 },
  ];
  const domainIds = new Map<string, string>();
  for (const p of plan) {
    const verified = p.state !== "pending_dns";
    const [d] = await db
      .insert(domains)
      .values({
        workspaceId: ws.id,
        name: p.name,
        provider: p.provider,
        tenantId: p.provider === "microsoft" ? ms.id : gw.id,
        poolId: pool.id,
        pool: p.pool,
        state: p.state,
        vendor: p.provider === "microsoft" ? "hypertide" : "direct",
        billingStatus: p.pool === "reserve" && p.provider === "microsoft" ? "recovery_pool" : "active",
        authVerifiedAt: verified ? now : null,
        headerTestPassedAt: verified ? daysAgo((p.warm ?? 1) + 1) : null,
        lastDnsCheckAt: verified ? now : null,
        activatedAt: p.state === "active" ? daysAgo((p.warm ?? 30) - 14) : null,
        registrar: "Porkbun",
        expiresAt: daysAgo(-300),
      })
      .returning();
    domainIds.set(p.name, d.id);
    if (p.boxes) {
      const personas = Array.from({ length: p.boxes }, (_, i) => ({ firstName: FIRST[i % FIRST.length], lastName: LAST[(i * 7) % LAST.length], localPart: `${FIRST[i % FIRST.length]}.${LAST[(i * 7) % LAST.length]}`.toLowerCase() }));
      await addMailboxes(ws.id, SYSTEM, d.id, personas);
      await db
        .update(mailboxes)
        .set({
          state: p.state === "active" ? "active" : p.state === "ready" ? "ready" : p.state === "warming" ? "warming" : "provisioning",
          connection: "connected",
          warmupStartedAt: p.warm !== null ? daysAgo(p.warm) : null,
          warmupInboxRate: p.warm !== null ? 0.94 + rand() * 0.05 : null,
        })
        .where(eq(mailboxes.domainId, d.id));
    }
  }
  // Seed inboxes for header and placement tests.
  const seedDomain = domainIds.get("seedcheck.net")!;
  await db.insert(mailboxes).values([
    { workspaceId: ws.id, domainId: seedDomain, tenantId: gw.id, address: "seed.gmail@seedcheck.net", firstName: "Seed", lastName: "Gmail", state: "ready", connection: "connected", isSeed: true, seedFamily: "gmail" },
    { workspaceId: ws.id, domainId: seedDomain, tenantId: gw.id, address: "seed.workspace@seedcheck.net", firstName: "Seed", lastName: "Workspace", state: "ready", connection: "connected", isSeed: true, seedFamily: "google_workspace" },
    { workspaceId: ws.id, domainId: seedDomain, tenantId: ms.id, address: "seed.outlook@seedcheck.net", firstName: "Seed", lastName: "Outlook", state: "ready", connection: "connected", isSeed: true, seedFamily: "outlook" },
    { workspaceId: ws.id, domainId: seedDomain, tenantId: ms.id, address: "seed.m365@seedcheck.net", firstName: "Seed", lastName: "M365", state: "ready", connection: "connected", isSeed: true, seedFamily: "microsoft365" },
  ]);

  // A list of synthetic prospects (processed through the real pipeline with simulated MX + validation).
  const rows = ["email,first_name,last_name,company,title,state,segment"];
  const used = new Set<string>();
  for (let i = 0; rows.length < 10_000 && i < 40_000; i++) {
    const f = FIRST[Math.floor(rand() * FIRST.length)];
    const l = LAST[Math.floor(rand() * LAST.length)];
    const co = `${CO[Math.floor(rand() * CO.length)]} ${SUFFIX[Math.floor(rand() * SUFFIX.length)]}`;
    const dom = co.toLowerCase().replace(/\s+/g, "") + Math.floor(rand() * 60) + (rand() < 0.1 ? "catchall" : "") + ".com";
    const email = `${f}.${l}@${dom}`.toLowerCase();
    if (used.has(email)) continue;
    used.add(email);
    rows.push([email, f, l, co.replace(/\b\w/g, (c) => c.toUpperCase()), TITLES[Math.floor(rand() * TITLES.length)], STATES[Math.floor(rand() * STATES.length)], rand() < 0.7 ? "smb" : "mid_market"].join(","));
  }
  const imp = await createImport(ws.id, SYSTEM, { name: "Ops leaders – US SMB (demo)", csv: rows.join("\n") });
  for (let i = 0; i < 200; i++) {
    const [r] = await db.select().from(listImports).where(eq(listImports.id, imp.id));
    if (r.status !== "processing") break;
    await new Promise((res) => setTimeout(res, 100));
  }

  // Campaign with clean copy, launched.
  const c = await createCampaign(ws.id, SYSTEM, { name: "Q4 – Ops leaders, US SMB", jurisdiction: "us" });
  const seq = await sequence(c.id);
  const copy = [
    {
      subject: "{{company|your team}} scheduling",
      body: "Hi {{firstName|there}},\n\nNoticed {{company|your team}} is hiring dispatchers. We help ops teams cut scheduling time in half without adding headcount.\n\nNot relevant? Just reply 'no' and I won't follow up.\n\nInterested?",
      standalone: null,
    },
    {
      subject: "",
      body: "Hi {{firstName|there}}, one more thought: a 30-person crew in Austin got back 12 hours a week in their first month.\n\nNot relevant? Just reply 'no'.\n\nWorth a chat?",
      standalone: "Hi {{firstName|there}},\n\nA 30-person crew in Austin got back 12 hours a week of scheduling in their first month with us.\n\nNot relevant? Reply 'no' and I won't follow up.\n\nWorth a chat?",
    },
    {
      subject: "",
      body: "Hi {{firstName|there}}, should I close the loop on this? If it's not a priority, reply 'no' and I won't follow up.\n\nOpen to it?",
      standalone: null,
    },
  ];
  for (const [i, s] of seq.entries()) {
    await db
      .update(variants)
      .set({ subject: copy[i].subject, body: copy[i].body, standaloneBody: copy[i].standalone, acknowledgedWarnings: ["merge_fallback", "subject_length"] })
      .where(eq(variants.stepId, s.id));
  }
  await db.update(campaigns).set({ status: "active", launchedAt: daysAgo(30) }).where(eq(campaigns.id, c.id));
  await enrollProspects(ws.id, SYSTEM, c.id, { importIds: [imp.id] });

  // 30 days of history for active domains.
  const ready = await db.select().from(prospects).where(eq(prospects.workspaceId, ws.id));
  const pros = ready.filter((p) => p.bucket === "ready");
  let pi = 0;
  const profiles: Record<string, { reply: number; bounce: number; spam: number }> = {
    "getdemoco.com": { reply: 0.004, bounce: 0.046, spam: 0.6 },
    "trydemoco.com": { reply: 0.031, bounce: 0.011, spam: 0.05 },
    "usedemoco.com": { reply: 0.026, bounce: 0.014, spam: 0.05 },
    "democohq.com": { reply: 0.034, bounce: 0.009, spam: 0.05 },
  };
  const step0 = seq[0];
  for (const [name, prof] of Object.entries(profiles)) {
    const dId = domainIds.get(name)!;
    const mbs = await db.select().from(mailboxes).where(eq(mailboxes.domainId, dId));
    const perDay = Math.round((name === "democohq.com" ? 45 : 75) * 0.7);
    const batch: (typeof sends.$inferInsert)[] = [];
    // Burning domain: healthy for the first weeks, then degrades (shows the drift in charts).
    for (let day = 32; day >= 1; day--) {
      const dt = DateTime.fromJSDate(daysAgo(day)).setZone("America/New_York");
      if (dt.weekday > 5) continue;
      const degrade = name === "getdemoco.com" ? Math.min(1, Math.max(0, (28 - day) / 6)) : 0;
      const replyRate = name === "getdemoco.com" ? 0.03 * (1 - degrade) + prof.reply * degrade : prof.reply;
      const bounceRate = name === "getdemoco.com" ? 0.01 * (1 - degrade) + prof.bounce * degrade : prof.bounce;
      for (let k = 0; k < perDay; k++) {
        const p = pros[pi++ % pros.length];
        const mb = mbs[k % mbs.length];
        const sentAt = dt.set({ hour: 8 + Math.floor((k / perDay) * 8), minute: Math.floor(rand() * 60) }).toJSDate();
        const r = rand();
        const bounced = r < bounceRate;
        const replied = !bounced && rand() < replyRate;
        const spamBlock = bounced && rand() < prof.spam * degrade;
        batch.push({
          workspaceId: ws.id,
          kind: "first_touch",
          campaignId: c.id,
          stepId: step0.id,
          stepIndex: 0,
          variantId: step0.variants[0].id,
          mailboxId: mb.id,
          domainId: dId,
          prospectId: p.id,
          importId: imp.id,
          toAddress: p.email,
          recipientProvider: p.recipientProvider,
          scheduledAt: sentAt,
          localDate: dt.toISODate()!,
          status: "sent",
          sentAt,
          subject: `${p.company} scheduling`,
          rfcMessageId: newMessageId(name),
          repliedAt: replied ? new Date(sentAt.getTime() + 3 * 3_600_000) : null,
          replyKind: replied ? "human" : null,
          bouncedAt: bounced ? new Date(sentAt.getTime() + 60_000) : null,
          bounceType: bounced ? "hard" : null,
          bounceCategory: bounced ? (spamBlock ? "policy_or_spam_block" : "user_unknown") : null,
        });
      }
    }
    for (let i = 0; i < batch.length; i += 500) await db.insert(sends).values(batch.slice(i, i + 500));

    // Conversations for a few of the replies (the unified inbox).
    const replied = batch.filter((b) => b.replyKind === "human").slice(-6);
    for (const [ri, b] of replied.entries()) {
      const p = pros.find((x) => x.id === b.prospectId)!;
      const rep = REPLIES[(ri + name.length) % REPLIES.length];
      const mb = mbs.find((m) => m.id === b.mailboxId)!;
      const [t] = await db
        .insert(threads)
        .values({ workspaceId: ws.id, mailboxId: mb.id, prospectId: p.id, campaignId: c.id, subject: b.subject!, counterpart: p.email, lastMessageAt: b.repliedAt!, lastInboundAt: b.repliedAt!, classification: "human", intent: rep.intent, unread: ri % 2 === 0 })
        .returning();
      await db.insert(messages).values([
        { workspaceId: ws.id, threadId: t.id, mailboxId: mb.id, direction: "out", fromAddr: mb.address, toAddr: p.email, subject: b.subject!, bodyText: copy[0].body.replace(/\{\{firstName\|there\}\}/g, p.firstName ?? "there").replace(/\{\{company\|your team\}\}/g, p.company ?? "your team"), rfcMessageId: b.rfcMessageId, createdAt: b.sentAt! },
        { workspaceId: ws.id, threadId: t.id, mailboxId: mb.id, direction: "in", fromAddr: p.email, toAddr: mb.address, subject: `Re: ${b.subject}`, bodyText: rep.body.replace("{domain}", p.companyDomain), classification: "human", intent: rep.intent, createdAt: b.repliedAt! },
      ]);
      await db.update(enrollments).set({ status: "replied", mailboxId: mb.id, threadId: t.id }).where(eq(enrollments.prospectId, p.id));
    }
  }
  // Prospects already contacted in history shouldn't be re-sent step 1.
  const contacted = new Set<string>();
  for (let i = 0; i < Math.min(pi, pros.length); i++) contacted.add(pros[i].id);
  const all = await db.select().from(enrollments).where(eq(enrollments.campaignId, c.id));
  for (const e of all) if (contacted.has(e.prospectId) && e.status === "active") await db.update(enrollments).set({ status: "completed", nextStep: 3 }).where(eq(enrollments.id, e.id));

  await evaluateWorkspaceHealth(ws.id, now);
  return ws;
}
