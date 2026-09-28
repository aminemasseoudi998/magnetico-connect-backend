import { Prisma, type PrismaClient, type User, type UserRole } from "@prisma/client";
import { audit, SYSTEM } from "./audit.js";

/**
 * Maps a verified Keycloak identity onto a Portal `users` row.
 *
 * Keyed on `keycloak_sub`: first sign-in creates the row, later requests
 * refresh email / display name / role so the row mirrors Keycloak. A new `sub` whose
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
  /** Keycloak realm role on the token — always copied onto the row. */
  role: UserRole;
};

export async function resolveUser(
  db: Pick<PrismaClient, "user" | "auditEvent">,
  identity: Identity,
): Promise<User> {
  const existing = await db.user.findUnique({ where: { keycloakSub: identity.keycloakSub } });
  if (existing !== null && existing.role !== identity.role) {
    await audit(db, {
      actor: SYSTEM.keycloak,
      action: "user.role_changed",
      severity: identity.role === "admin" ? "warn" : "info",
      target: { type: "user", id: existing.id, label: existing.email },
      details: { from: existing.role, to: identity.role },
    });
  }
  if (existing !== null) {
    if (
      existing.email === identity.email &&
      existing.displayName === identity.displayName &&
      existing.role === identity.role
    ) {
      return existing;
    }
    return db.user.update({
      where: { id: existing.id },
      data: { email: identity.email, displayName: identity.displayName, role: identity.role },
    });
  }

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail !== null) {
    if (!identity.emailVerified) throw new UserConflictError(identity.email);
    return db.user.update({
      where: { id: byEmail.id },
      data: {
        keycloakSub: identity.keycloakSub,
        displayName: identity.displayName,
        role: identity.role,
      },
    });
  }

  try {
    const created = await db.user.create({
      data: {
        keycloakSub: identity.keycloakSub,
        email: identity.email,
        displayName: identity.displayName,
        role: identity.role,
      },
    });
    await audit(db, {
      actor: SYSTEM.keycloak,
      action: "user.first_sign_in",
      severity: created.role === "admin" ? "warn" : "info",
      target: { type: "user", id: created.id, label: created.email },
      details: { role: created.role },
    });
    return created;
  } catch (err) {
    // Two first requests from the same new user raced; the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await db.user.findUnique({ where: { keycloakSub: identity.keycloakSub } });
      if (raced !== null) return raced;
    }
    throw err;
  }
}
