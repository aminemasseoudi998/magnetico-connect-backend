import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuthUser } from "./auth-types.js";

/**
 * Step 4 — stub auth middleware.
 *
 * Attaches a FAKE userId to every /api/* request (except /api/health) so the
 * step-5 endpoints can be built and tested without a running Keycloak.
 *
 * Contract (stable across stub -> real):
 *   - protected routes declare `preHandler: [requireAuth]`
 *   - handlers read identity via `request.user` (always defined past requireAuth)
 *   - unauthenticated access fails with 401 { error: "unauthorized" }
 *
 * TODO(keycloak, step 11): replace getStubUser() with real JWT verification:
 *   1. read `Authorization: Bearer <jwt>`
 *   2. verify signature against Keycloak JWKS (RS256, cached), check iss/aud/exp
 *   3. upsert users row on (keycloak_sub) and attach { id: users.id, ... }
 *   4. delete STUB_* env vars, dev header override, and this file's stub path.
 */

const PUBLIC_PATHS = new Set(["/api/health"]);

function getStubUser(): AuthUser {
  return {
    id: process.env["STUB_USER_ID"] ?? "00000000-0000-0000-0000-000000000001",
    keycloakSub: process.env["STUB_KEYCLOAK_SUB"] ?? "stub-sub-dev-only",
    email: process.env["STUB_EMAIL"] ?? "dev@magnetico.local",
    displayName: process.env["STUB_DISPLAY_NAME"] ?? "Dev User",
  };
}

/**
 * Pre-handler for protected routes. Never touches the database on purpose —
 * route handlers own the (stub user) -> Prisma lookup so the middleware stays
 * usable in unit tests without a live portal-db.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Health check stays public (prompt.md: "except /api/health").
  if (request.url === "/api/health" || PUBLIC_PATHS.has(request.url.split("?")[0] ?? "")) {
    return;
  }

  // Dev-only escape hatch: `x-user-id: <uuid>` lets step-5 work be tested with
  // two different users (entitlement isolation) without Keycloak.
  // TODO(keycloak, step 11): DELETE this header override with the stub.
  const override = request.headers["x-user-id"];
  if (typeof override === "string" && override.length > 0) {
    request.log.warn("auth stub: using x-user-id override header (dev only)");
    const stub = getStubUser();
    request.user = { ...stub, id: override };
    return;
  }

  // TODO(keycloak, step 11): verify `Authorization: Bearer` here and 401 on
  // missing/invalid/expired tokens. The stub accepts everything by design.
  request.user = getStubUser();
}

/**
 * Registers requireAuth as a global preHandler hook scoped to /api/* paths.
 * Wrapped in fastify-plugin so the hook also covers sibling route plugins.
 */
async function authPluginInner(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) {
      return;
    }
    await requireAuth(request, reply);
  });
}

export const authPlugin = fp(authPluginInner);
