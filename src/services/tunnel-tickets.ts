import { randomBytes } from "node:crypto";

/**
 * One-time tickets that authorise a browser to open the display WebSocket.
 *
 * Browsers cannot put an `Authorization` header on a WebSocket, and the
 * Keycloak token lives in an httpOnly cookie on the frontend's origin anyway.
 * So POST /api/sessions (Bearer-authenticated) issues a ticket, and the
 * tunnel accepts it exactly once, within 60 seconds, for that one session.
 * 256 random bits; only the holder of the POST response ever sees it.
 *
 * NOTE(scale): in-process store — same caveat as the live registry.
 */

const TTL_MS = 60_000;

/** "session" opens the user's own display; "watch" lets an admin join it read-only. */
export type TicketKind = "session" | "watch";

type Ticket = { sessionId: string; userId: string; kind: TicketKind; expiresAt: number };

const tickets = new Map<string, Ticket>();

export function issueTicket(
  sessionId: string,
  userId: string,
  kind: TicketKind = "session",
): { ticket: string; expiresAt: Date } {
  purgeExpired();
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + TTL_MS;
  tickets.set(ticket, { sessionId, userId, kind, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt) };
}

/** Returns and burns the ticket; null when unknown, used, expired or of another kind. */
export function consumeTicket(ticket: string, kind: TicketKind = "session"): Ticket | null {
  const entry = tickets.get(ticket);
  if (entry === undefined) return null;
  tickets.delete(ticket);
  return entry.expiresAt >= Date.now() && entry.kind === kind ? entry : null;
}

/** Drops every outstanding ticket for a session (it was closed or replaced). */
export function revokeTickets(sessionId: string): void {
  for (const [ticket, entry] of tickets) {
    if (entry.sessionId === sessionId) tickets.delete(ticket);
  }
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(ticket);
  }
}
