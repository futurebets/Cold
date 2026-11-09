/** Users, sessions, workspace bootstrap and team management. */
import { and, eq, gt, sql } from "drizzle-orm";
import type { Role } from "@cold/core";
import { DEFAULT_CONTROL_MESSAGES, isValidDomainName, normalizeDomain } from "@cold/core";
import { getDb, schema } from "../db/client";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/http";
import type { Actor } from "./common";
import { audit } from "./common";
import { defaultPool } from "./domains";

const { users, memberships, sessions, workspaces, protectedDomains, controlMessages } = schema;
const SESSION_DAYS = 30;

export async function needsSetup(): Promise<boolean> {
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users);
  return n === 0;
}

export async function createWorkspace(name: string, timezone = "America/New_York", settings: Record<string, unknown> = {}) {
  const db = getDb();
  const [ws] = await db.insert(workspaces).values({ name, timezone, settings }).returning();
  await defaultPool(ws.id, false);
  await defaultPool(ws.id, true);
  for (const m of DEFAULT_CONTROL_MESSAGES) await db.insert(controlMessages).values({ workspaceId: ws.id, subject: m.subject, body: m.body });
  return ws;
}

export function setupTokenRequired(): boolean {
  return !!config.setupToken || config.production;
}

export async function setup(input: { name: string; email: string; password: string; workspaceName: string; primaryDomain: string; timezone?: string; setupToken?: string }) {
  if (!(await needsSetup())) throw forbidden("Setup has already been completed");
  // On a public URL, whoever finishes setup first becomes the owner, so require a secret token.
  if (setupTokenRequired()) {
    if (!config.setupToken) throw forbidden("Set the SETUP_TOKEN secret on the server to finish setup.");
    const given = Buffer.from(input.setupToken ?? "");
    const expected = Buffer.from(config.setupToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden("Wrong setup token");
  }
  validatePassword(input.password);
  const primary = normalizeDomain(input.primaryDomain);
  if (!isValidDomainName(primary)) throw badRequest("Enter your primary domain, e.g. acme.com");
  const db = getDb();
  const ws = await createWorkspace(input.workspaceName || "My company", input.timezone);
  const [user] = await db.insert(users).values({ email: input.email.trim().toLowerCase(), name: input.name.trim(), passwordHash: await hashPassword(input.password) }).returning();
  await db.insert(memberships).values({ userId: user.id, workspaceId: ws.id, role: "owner" });
  await db.insert(protectedDomains).values({ workspaceId: ws.id, domain: primary });
  await audit(ws.id, { id: user.id, label: user.email, role: "owner" }, "workspace.created", null, { primaryDomain: primary });
  return createSession(user.id, ws.id);
}

function validatePassword(pw: string) {
  if (!pw || pw.length < 10) throw badRequest("Use a password of at least 10 characters");
}

export async function createSession(userId: string, workspaceId: string) {
  const token = randomToken();
  await getDb()
    .insert(sessions)
    .values({ id: sha256(token), userId, workspaceId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
  return { token, maxAge: SESSION_DAYS * 86_400 };
}

export async function login(email: string, password: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Wrong email or password");
  const [m] = await db.select().from(memberships).where(eq(memberships.userId, user.id)).limit(1);
  if (!m) throw forbidden("You're not a member of any workspace");
  return createSession(user.id, m.workspaceId);
}

export async function logout(token: string) {
  await getDb().delete(sessions).where(eq(sessions.id, sha256(token)));
}

export interface AuthContext {
  user: { id: string; email: string; name: string };
  workspaceId: string;
  role: Role;
  actor: Actor;
}

export async function authenticate(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select({ session: sessions, user: users, role: memberships.role })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.workspaceId, sessions.workspaceId)))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  return {
    user: { id: row.user.id, email: row.user.email, name: row.user.name },
    workspaceId: row.session.workspaceId,
    role: row.role,
    actor: { id: row.user.id, label: row.user.email, role: row.role },
  };
}

export async function listTeam(workspaceId: string) {
  return getDb()
    .select({ id: users.id, email: users.email, name: users.name, role: memberships.role, since: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspaceId));
}

export async function addMember(workspaceId: string, actor: Actor, input: { email: string; name: string; role: Role }) {
  const db = getDb();
  const email = input.email.trim().toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.email, email));
  let tempPassword: string | null = null;
  if (!user) {
    tempPassword = randomToken(9);
    [user] = await db.insert(users).values({ email, name: input.name || email, passwordHash: await hashPassword(tempPassword) }).returning();
  }
  const [existing] = await db.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.workspaceId, workspaceId)));
  if (existing) throw conflict("Already a member");
  await db.insert(memberships).values({ userId: user.id, workspaceId, role: input.role });
  await audit(workspaceId, actor, "team.added", { type: "user", id: user.id }, { email, role: input.role });
  return { user: { id: user.id, email }, tempPassword };
}

export async function setMemberRole(workspaceId: string, actor: Actor, userId: string, role: Role) {
  const db = getDb();
  if (userId === actor.id && role !== "owner") {
    const owners = (await listTeam(workspaceId)).filter((m) => m.role === "owner");
    if (owners.length <= 1) throw badRequest("A workspace needs at least one owner");
  }
  const res = await db.update(memberships).set({ role }).where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId))).returning();
  if (!res.length) throw notFound("Member not found");
  await audit(workspaceId, actor, "team.role", { type: "user", id: userId }, { role });
}

export async function removeMember(workspaceId: string, actor: Actor, userId: string) {
  if (userId === actor.id) throw badRequest("You can't remove yourself");
  await getDb().delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  await audit(workspaceId, actor, "team.removed", { type: "user", id: userId });
}

export async function changePassword(userId: string, current: string, next: string) {
  const db = getDb();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw badRequest("Current password is wrong");
  validatePassword(next);
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, userId));
}
