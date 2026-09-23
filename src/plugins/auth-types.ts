import type { FastifyRequest } from "fastify";

/**
 * Identity attached to every authenticated request.
 * Step 11 will populate this from the verified Keycloak JWT (`sub` claim);
 * until then it comes from STUB_* env vars (step 4).
 */
export type AuthUser = {
  /** Portal users.id — what Prisma queries filter on. */
  id: string;
  /** Keycloak `sub` claim. Stubbed for now, real in step 11. */
  keycloakSub: string;
  email: string;
  displayName: string;
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
