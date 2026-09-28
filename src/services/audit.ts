import type { FastifyBaseLogger } from "fastify";
import type { AuditSeverity, Prisma, PrismaClient } from "@prisma/client";

/**
 * Audit trail: who did what, when. Append-only — this module only inserts.
 *
 * Recording must never break the action it describes, so `audit()` swallows
 * its own failures (logged). Details must never contain secrets: record that
 * a password changed, never its value.
 */

export type AuditActor = { id: string | null; label: string };

/** The system as an actor (two-way Guacamole sync, Keycloak role sync). */
export const SYSTEM = {
  guacamole: { id: null, label: "Guacamole sync" },
  keycloak: { id: null, label: "Keycloak" },
} satisfies Record<string, AuditActor>;

export type AuditInput = {
  actor: AuditActor;
  action: string;
  severity?: AuditSeverity;
  target: { type: "server" | "session" | "user" | "system"; id?: string | null; label: string };
  details?: Record<string, unknown>;
};

export async function audit(
  prisma: Pick<PrismaClient, "auditEvent">,
  input: AuditInput,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actorId: input.actor.id,
        actorLabel: input.actor.label,
        action: input.action,
        severity: input.severity ?? "info",
        targetType: input.target.type,
        targetId: input.target.id ?? null,
        targetLabel: input.target.label,
        details: (input.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    log?.error({ err, action: input.action }, "audit: could not record event");
  }
}

/** Fields that changed between two plain objects (for "server.updated"). */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
