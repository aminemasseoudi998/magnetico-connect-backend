import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  verifier = {
    issuer,
    audience: process.env["KEYCLOAK_AUDIENCE"] ?? "magnetico-portal",
    jwks: createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`)),
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
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (request.user !== undefined || isPublic(request)) return;

  const token = bearerToken(request);
  if (token === null) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  let claims: KeycloakClaims;
  try {
    const { issuer, audience, jwks } = getVerifier();
    ({ payload: claims } = await jwtVerify<KeycloakClaims>(token, jwks, { issuer, audience }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) {
      request.log.info({ code: err.code }, "auth: token rejected");
      return reply.code(401).send({ error: "unauthorized" });
    }
    throw err;
  }

  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const seedRole = seedRoleFromClaims(claims);
  if (seedRole === null) {
    return reply.code(403).send({ error: "no_role" });
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
      return reply.code(409).send({ error: "account_conflict" });
    }
    throw err;
  }
  if (user.status !== "active") {
    return reply.code(403).send({ error: "account_suspended" });
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
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const denied = await requireAuth(request, reply);
  if (denied !== undefined) return denied;
  if (request.user?.role !== "admin") {
    return reply.code(403).send({ error: "forbidden" });
  }
}

/**
 * Registers the auth hooks globally for /api/* (and requireAdmin for
 * /api/admin/*) as a backstop behind each route's own preHandler.
 * Wrapped in fastify-plugin so the hook also covers sibling route plugins.
 */
async function authPluginInner(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/admin/")) return requireAdmin(request, reply);
    if (path.startsWith("/api/")) return requireAuth(request, reply);
  });
}

export const authPlugin = fp(authPluginInner);
