import type { PrismaClient, Resource } from "@prisma/client";
import { endSession } from "./live-sessions.js";
import { revokeTickets } from "./tunnel-tickets.js";

/**
 * Removes a server from the portal — from the admin console, or because the
 * connection was deleted in Guacamole (two-way sync).
 *
 * Live sessions are ended first (reason `server_removed`). A server with no
 * session history is deleted outright; one with history is archived instead
 * (sessions reference it for billing): hidden everywhere, credentials wiped,
 * access grants removed, name freed for reuse.
 */
export async function removeServer(
  prisma: PrismaClient,
  server: Resource,
): Promise<{ archived: boolean; endedSessions: number }> {
  const running = await prisma.session.findMany({
    where: { resourceId: server.id, status: { in: ["pending", "active"] } },
    select: { id: true },
  });
  for (const s of running) {
    revokeTickets(s.id);
    await endSession(prisma, s.id, "server_removed");
  }

  const history = await prisma.session.count({ where: { resourceId: server.id } });
  if (history === 0) {
    await prisma.resource.delete({ where: { id: server.id } });
    return { archived: false, endedSessions: running.length };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  await prisma.$transaction([
    prisma.entitlement.deleteMany({ where: { resourceId: server.id } }),
    prisma.resource.update({
      where: { id: server.id },
      data: {
        archivedAt: new Date(),
        active: false,
        name: `${server.name.slice(0, 40)} (deleted ${stamp} ${server.id.slice(0, 8)})`,
        passwordEnc: null,
        privateKeyEnc: null,
        passphraseEnc: null,
      },
    }),
  ]);
  return { archived: true, endedSessions: running.length };
}
