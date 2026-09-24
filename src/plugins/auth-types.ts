import type { FastifyRequest } from "fastify";

/**
 * Portal roles, owned by `users.role`.
 *
 * Keycloak authenticates and seeds the role at first sign-in (its realm role
 * `admin` becomes `admin`, anything else becomes `engineer`); from then on
 * this table is the source of truth and the admin console edits it. A token
 * whose realm role later disagrees does NOT override the stored role —
 * otherwise a demotion made here would be undone at the next sign-in.
 */
export type PortalRole = "admin" | "engineer" | "analyst";

/** Roles allowed to open a metered session (an analyst is read-only). */
export function canOpenSessions(role: PortalRole): boolean {
  return role === "admin" || role === "engineer";
}

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
