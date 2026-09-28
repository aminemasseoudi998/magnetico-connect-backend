import type { FastifyRequest } from "fastify";

/**
 * Portal roles = the Keycloak realm roles, nothing else. Keycloak is the
 * source of truth; `users.role` is a copy refreshed on every request, so
 * adding or removing `admin` in Keycloak takes effect as soon as the person's
 * token is refreshed (at most the 5-minute access-token lifetime).
 */
export type PortalRole = "admin" | "user";

/** Identity attached to every authenticated request (verified Keycloak JWT). */
export type AuthUser = {
  /** Portal users.id — what Prisma queries filter on. */
  id: string;
  /** Keycloak `sub` claim. */
  keycloakSub: string;
  email: string;
  displayName: string;
  role: PortalRole;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth plugin for every protected /api/* route. */
    user?: AuthUser;
  }
}

/** Type guard used inside route handlers after the requireAuth pre-handler. */
export function getAuthUser(request: FastifyRequest): AuthUser {
  const user = request.user;
  if (user === undefined) {
    throw new Error("getAuthUser called on an unauthenticated request");
  }
  return user;
}
