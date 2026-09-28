import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient, Session } from "@prisma/client";
import { getBalance } from "./wallet.js";

/**
 * Session lifecycle and metering.
 *
 * The backend proxies every remote-display stream itself (routes/tunnel.ts),
 * so it knows to the second when a session starts and ends — metering needs
 * no polling of Guacamole. This module owns:
 *
 *   - the registry of tunnels open in THIS process (terminate, drain),
 *   - credit maths: what a user may still reserve,
 *   - finalisation: one idempotent place that stops the meter and bills,
 *   - the sweeper that settles sessions whose tunnel no longer exists.
 *
 * Billing model: a session reserves a hold (never counted in the balance,
 * see services/wallet.ts). At the end ONE `charge` row is written for the
 * time actually connected, capped at the hold — no refund row is needed
 * because the hold itself was never debited.
 *
 * NOTE(scale): the registry is in-process. Running several backend replicas
 * needs a shared registry + sticky tunnels (hardening, step 14).
 */

export type EndReason =
  | "user_closed"
  | "balance_exhausted"
  | "time_limit"
  | "admin_terminated"
  | "account_suspended"
  | "server_removed"
  | "server_closed"
  | "connection_failed"
  | "never_connected"
  | "interrupted";

/** Reasons that end a session against the user's will → status `killed`. */
const KILLED: ReadonlySet<EndReason> = new Set([
  "balance_exhausted",
  "time_limit",
  "admin_terminated",
  "account_suspended",
  "server_removed",
]);

const LIVE_STATUSES = ["pending", "active"] as const;

/* ------------------------------------------------------------ registry */

export type LiveHandle = {
  sessionId: string;
  userId: string;
  resourceId: string;
  /** Closes the tunnel and settles the session. Safe to call twice. */
  terminate: (reason: EndReason) => void;
};

const live = new Map<string, LiveHandle>();

export const liveRegistry = {
  add(handle: LiveHandle) {
    live.set(handle.sessionId, handle);
  },
  remove(sessionId: string) {
    live.delete(sessionId);
  },
  get(sessionId: string) {
    return live.get(sessionId);
  },
  has(sessionId: string) {
    return live.has(sessionId);
  },
  forUser(userId: string) {
    return [...live.values()].filter((h) => h.userId === userId);
  },
  forResource(resourceId: string) {
    return [...live.values()].filter((h) => h.resourceId === resourceId);
  },
  count() {
    return live.size;
  },
};

/* ------------------------------------------------------------ watchers */

/**
 * Admins watching a live session read-only (routes/tunnel.ts). The count is
 * shown to the user; every watcher is closed when the session ends.
 */
const watchers = new Map<string, Set<() => void>>();

export const watchRegistry = {
  add(sessionId: string, close: () => void) {
    const set = watchers.get(sessionId) ?? new Set();
    set.add(close);
    watchers.set(sessionId, set);
  },
  remove(sessionId: string, close: () => void) {
    const set = watchers.get(sessionId);
    set?.delete(close);
    if (set?.size === 0) watchers.delete(sessionId);
  },
  count(sessionId: string): number {
    return watchers.get(sessionId)?.size ?? 0;
  },
  closeAll(sessionId: string) {
    for (const close of [...(watchers.get(sessionId) ?? [])]) close();
    watchers.delete(sessionId);
  },
};

/* ------------------------------------------------------------ credit */

type Db = Pick<PrismaClient, "ledgerEntry" | "session">;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Credit the user can still reserve: balance minus the holds of every
 * session that is not settled yet (optionally excluding one).
 */
export async function availableCredit(db: Db, userId: string, excludeSessionId?: string): Promise<number> {
  const [balance, held] = await Promise.all([
    getBalance(db, userId),
    db.session.aggregate({
      where: {
        userId,
        status: { in: [...LIVE_STATUSES] },
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      _sum: { holdAmount: true },
    }),
  ]);
  return round4(balance - Number(held._sum.holdAmount ?? 0));
}

/** Rate a session is billed at (locked at open; resource rate for legacy rows). */
export function sessionRate(session: Pick<Session, "ratePerMinute">, fallback: Prisma.Decimal | number): number {
  return Number(session.ratePerMinute ?? fallback);
}

/* ------------------------------------------------------------ settle */

/**
 * Stops the meter and bills. Idempotent: only the first call for a session
 * that is still pending/active does anything; later calls return null.
 *
 * `chargeUntil` bills up to an earlier instant than now — used for sessions
 * found orphaned after a restart, billed to their last heartbeat.
 */
export async function finalizeSession(
  prisma: PrismaClient,
  sessionId: string,
  reason: EndReason,
  chargeUntil?: Date,
): Promise<{ status: "closed" | "killed"; charge: number } | null> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      include: { resource: { select: { ratePerMinute: true } } },
    });
    if (session === null || (session.status !== "pending" && session.status !== "active")) {
      return null;
    }

    const endedAt = new Date();
    const billedUntil = chargeUntil ?? endedAt;
    const seconds =
      session.startedAt === null
        ? 0
        : Math.max(0, (billedUntil.getTime() - session.startedAt.getTime()) / 1000);
    const rate = sessionRate(session, session.resource.ratePerMinute);
    const charge = round4(Math.min(Number(session.holdAmount), (rate * seconds) / 60));
    const status = KILLED.has(reason) ? "killed" : "closed";

    // Guarded update: a concurrent finaliser loses here and bills nothing.
    const updated = await tx.session.updateMany({
      where: { id: sessionId, status: { in: [...LIVE_STATUSES] } },
      data: {
        status,
        endedAt: session.startedAt === null ? endedAt : billedUntil,
        finalCharge: charge.toFixed(4),
        endReason: reason,
      },
    });
    if (updated.count === 0) return null;

    if (charge > 0) {
      await tx.ledgerEntry.create({
        data: { userId: session.userId, sessionId, type: "charge", amount: charge.toFixed(4) },
      });
    }
    return { status, charge };
  });
}

/**
 * Ends a session wherever it is: through its live tunnel when this process
 * holds one (so the user sees why), otherwise directly in the database.
 */
export async function endSession(
  prisma: PrismaClient,
  sessionId: string,
  reason: EndReason,
): Promise<void> {
  const handle = liveRegistry.get(sessionId);
  if (handle !== undefined) {
    handle.terminate(reason);
    return;
  }
  await finalizeSession(prisma, sessionId, reason);
}

/* ------------------------------------------------------------ sweeper */

/** A pending session whose ticket was never used is abandoned after this. */
const PENDING_GRACE_MS = 3 * 60_000;

/**
 * Settles sessions that have no tunnel in this process:
 *   - pending and older than the grace period → never_connected (no charge)
 *   - active (the process holding it restarted) → interrupted, billed up to
 *     its last heartbeat rather than to now.
 */
export async function sweepOrphans(prisma: PrismaClient, log: FastifyBaseLogger): Promise<void> {
  const stale = await prisma.session.findMany({
    where: {
      OR: [
        { status: "pending", createdAt: { lt: new Date(Date.now() - PENDING_GRACE_MS) } },
        { status: "active" },
      ],
    },
    select: { id: true, status: true, startedAt: true, lastSeenAt: true },
  });

  for (const session of stale) {
    if (liveRegistry.has(session.id)) continue;
    try {
      if (session.status === "pending") {
        await finalizeSession(prisma, session.id, "never_connected");
      } else {
        await finalizeSession(
          prisma,
          session.id,
          "interrupted",
          session.lastSeenAt ?? session.startedAt ?? undefined,
        );
      }
      log.info({ sessionId: session.id, was: session.status }, "sweeper: settled orphaned session");
    } catch (err) {
      log.error({ err, sessionId: session.id }, "sweeper: could not settle session");
    }
  }
}
