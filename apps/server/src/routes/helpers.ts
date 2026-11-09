import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Role } from "@cold/core";
import { roleAtLeast } from "@cold/core";
import { forbidden, HttpError } from "../lib/http";
import type { AuthContext } from "../services/auth";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function ctx(req: FastifyRequest, min: Role = "viewer"): AuthContext {
  if (!req.auth) throw new HttpError(401, "Sign in to continue");
  if (!roleAtLeast(req.auth.role, min)) throw forbidden(`This needs the ${min} role or higher`);
  return req.auth;
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join(".") || "input"}: ${first.message}`, { issues: r.error.issues });
  }
  return r.data;
}

export const idParam = z.object({ id: z.string().min(1) });

export type Req = FastifyRequest;
export type Res = FastifyReply;
export { z };
