import { Prisma, type PrismaClient, type User } from "@prisma/client";

/**
 * Maps a verified Keycloak identity onto a Portal `users` row.
 *
 * Keyed on `keycloak_sub`: first sign-in creates the row, later sign-ins
 * refresh email / display name when Google reports a change. A new `sub` whose
 * email already exists (user removed and re-created in Keycloak) is linked to
 * the existing row only when Keycloak vouches for the email — otherwise that
 * would let anyone who can set an arbitrary email take over the account.
 */

export class UserConflictError extends Error {}

export type Identity = {
  keycloakSub: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

export async function resolveUser(
  db: Pick<PrismaClient, "user">,
  identity: Identity,
): Promise<User> {
  const existing = await db.user.findUnique({ where: { keycloakSub: identity.keycloakSub } });
  if (existing !== null) {
    if (existing.email === identity.email && existing.displayName === identity.displayName) {
      return existing;
    }
    return db.user.update({
      where: { id: existing.id },
      data: { email: identity.email, displayName: identity.displayName },
    });
  }

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail !== null) {
    if (!identity.emailVerified) throw new UserConflictError(identity.email);
    return db.user.update({
      where: { id: byEmail.id },
      data: { keycloakSub: identity.keycloakSub, displayName: identity.displayName },
    });
  }

  try {
    return await db.user.create({
      data: {
        keycloakSub: identity.keycloakSub,
        email: identity.email,
        displayName: identity.displayName,
      },
    });
  } catch (err) {
    // Two first requests from the same new user raced; the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await db.user.findUnique({ where: { keycloakSub: identity.keycloakSub } });
      if (raced !== null) return raced;
    }
    throw err;
  }
}
