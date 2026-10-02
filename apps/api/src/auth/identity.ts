import type { FastifyRequest } from "fastify";
import { authRequired } from "../security/errors";
import type { Auth } from "./auth";

/**
 * The only identity the Verity service trusts: a valid, unexpired session
 * proven by a bearer token. User ids, roles, Maypop ids or names sent by the
 * browser are never read for authorization.
 */
export interface VerityIdentity {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,512})$/;

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  return BEARER.exec(header)?.[1] ?? null;
}

export async function resolveIdentity(auth: Auth, request: FastifyRequest): Promise<VerityIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  // Only the Authorization header is forwarded: cookies are never accepted.
  const result = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  if (!result) return null;
  return {
    userId: result.user.id,
    sessionId: result.session.id,
    sessionExpiresAt: new Date(result.session.expiresAt),
  };
}

export async function requireIdentity(auth: Auth, request: FastifyRequest): Promise<VerityIdentity> {
  const identity = await resolveIdentity(auth, request);
  if (!identity) throw authRequired();
  return identity;
}
