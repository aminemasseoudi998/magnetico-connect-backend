import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { AuthUser, PortalRole } from "./auth-types.js";
import { resolveUser, UserConflictError } from "../services/users.js";

/**
 * Step 11 — Keycloak JWT verification.
 *
 * Every /api/* request except /api/health must carry
 * `Authorization: Bearer <access token>` issued by the Keycloak realm that
 * brokers Google. The token is verified against the realm JWKS (RS256,
 * cached by jose), with issuer + audience + expiry checks. The `sub` claim is
 * then upserted into `users` and the row id is attached as `request.user.id`.
 *
 * Roles live in `users.role`, not in the token: the realm role only seeds a
 * brand-new row (see services/users.ts). `requireAdmin` therefore reads the
 * stored role, so a promotion or demotion made in the admin console takes
 * effect on the holder's next request rather than their next sign-in.
 *
 * Contract:
 *   - protected routes declare `preHandler: [requireAuth]`
 *   - admin-only routes live under /api/admin/* (enforced globally below)
 *     or declare `preHandler: [requireAuth, requireAdmin]`
 *   - 401 { error: "unauthorized" } — missing / invalid / expired token
 *   - 403 { error: "forbidden" | "no_role" | "account_suspended" }
 */

const PUBLIC_PATHS = new Set(["/api/health"]);

type KeycloakClaims = JWTPayload & {
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
};

type Verifier = {
  issuer: string;
  audience: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

let verifier: Verifier | undefined;

/** Built lazily so importing this module never requires a configured env. */
function getVerifier(): Verifier {
  if (verifier !== undefined) return verifier;
  const issuer = (process.env["KEYCLOAK_ISSUER"] ?? "").replace(/\/$/, "");
  if (issuer.length === 0) {
    throw new Error(
      "KEYCLOAK_ISSUER is not set (e.g. http://localhost:8180/auth/realms/magnetico)",
    );
  }
  // The issuer must match the token `iss` claim exactly (browser-facing URL),
  // but the JWKS document is fetched server-side — from inside Docker that
  // host:port usually resolves differently, so the certs URL is overridable.
  // Compose default: http://keycloak:8080/auth/realms/magnetico/protocol/openid-connect/certs
  const jwksUrl =
    process.env["KEYCLOAK_JWKS_URL"] ?? `${issuer}/protocol/openid-connect/certs`;
  verifier = {
    issuer,
    audience: process.env["KEYCLOAK_AUDIENCE"] ?? "magnetico-portal",
    jwks: createRemoteJWKSet(new URL(jwksUrl)),
  };
  return verifier;
}

/**
 * Role to give a brand-new `users` row, or null when the token carries no
 * portal realm role at all (-> 403 no_role). Existing rows keep their stored
 * role regardless of what the token says.
 */
export function seedRoleFromClaims(claims: KeycloakClaims): PortalRole | null {
  const roles = claims.realm_access?.roles ?? [];
  if (roles.includes("admin")) return "admin";
  if (roles.includes("user")) return "engineer";
  return null;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function isPublic(request: FastifyRequest): boolean {
  return PUBLIC_PATHS.has(request.url.split("?")[0] ?? "");
}

/**
 * Pre-handler for protected routes. Idempotent: the global hook and the
 * per-route preHandler both call it, the second call is a no-op.
 */
/**
 * NOTE (FST_ERR_REP_ALREADY_SENT post-mortem): denial used to work by
 * `return reply.code(...).send(...)` with callers branching on
 * `denied !== undefined`. That broke in production: the awaited denial
 * resolved `undefined` despite the send having happened (verified with
 * request-scoped debug logging — single execution, `sent=true`, result
 * `undefined`), so execution fell through to a second send. Whatever the
 * underlying cause (send-result / await interaction in this Fastify
 * version), the lesson is structural: denial MUST unwind, never return.
 * Guards below throw AuthError; a single setErrorHandler in server.ts turns
 * those into responses. There is exactly one send site for auth failures.
 */
export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (request.user !== undefined || isPublic(request)) return;

  const token = bearerToken(request);
  if (token === null) {
    throw new AuthError(401, "unauthorized");
  }

  let claims: KeycloakClaims;
  try {
    const { issuer, audience, jwks } = getVerifier();
    ({ payload: claims } = await jwtVerify<KeycloakClaims>(token, jwks, { issuer, audience }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) {
      request.log.info({ code: err.code }, "auth: token rejected");
      throw new AuthError(401, "unauthorized");
    }
    throw err;
  }

  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new AuthError(401, "unauthorized");
  }

  const seedRole = seedRoleFromClaims(claims);
  if (seedRole === null) {
    throw new AuthError(403, "no_role");
  }

  let user;
  try {
    user = await resolveUser(request.server.prisma, {
      keycloakSub: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true,
      displayName: claims.name ?? claims.preferred_username ?? claims.email,
      seedRole,
    });
  } catch (err) {
    if (err instanceof UserConflictError) {
      throw new AuthError(409, "account_conflict");
    }
    throw err;
  }
  if (user.status !== "active") {
    throw new AuthError(403, "account_suspended");
  }

  const authUser: AuthUser = {
    id: user.id,
    keycloakSub: user.keycloakSub,
    email: user.email,
    displayName: user.displayName,
    // Stored role wins over the token — see the module comment.
    role: user.role,
  };
  request.user = authUser;
}

/** Pre-handler for admin-only routes. Must run after requireAuth. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (request.user?.role !== "admin") {
    throw new AuthError(403, "forbidden");
  }
}

/**
 * Registers the auth hooks globally for /api/* (and requireAdmin for
 * /api/admin/*) as a backstop behind each route's own preHandler.
 * Wrapped in fastify-plugin so the hook also covers sibling route plugins.
 */
async function authPluginInner(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/admin/")) return requireAdmin(request);
    if (path.startsWith("/api/")) return requireAuth(request);
  });
}

export const authPlugin = fp(authPluginInner);
