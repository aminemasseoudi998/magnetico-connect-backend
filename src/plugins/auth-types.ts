import type { FastifyRequest } from "fastify";

/**
 * Portal roles, sourced from Keycloak realm roles (`realm_access.roles`).
 * Every Google sign-in gets `user` through the realm's default roles; `admin`
 * is granted by hand in the Keycloak admin console. `admin` wins when a token
 * carries both.
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
