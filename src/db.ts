import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Portal DB access over raw SQL (`pg`, no ORM).
 *
 * The backend owns the schema (backend/prisma + its migrations); this daemon
 * only reads sessions/entitlements-adjacent rows and appends ledger entries.
 * Column names mirror the Prisma field mappings (snake_case); amounts come
 * back as NUMERIC strings and are converted at the edges.
 */

const { Pool } = pg;

export type PoolLike = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  end: () => Promise<void>;
};

let pool: PoolLike | undefined;

export function getPool(databaseUrl: string): PoolLike {
  if (pool === undefined) {
    pool = new Pool({ connectionString: databaseUrl }) as unknown as PoolLike;
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export type OpenSessionRow = {
  id: string;
  user_id: string;
  resource_id: string;
  hold_amount: string;
  status: "pending" | "active" | "closed" | "killed";
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  rate_per_minute: string;
  guac_connection_id: string;
  resource_name: string;
};

/** Every session that still needs daemon attention (anything not reconciled). */
export async function listOpenSessions(db: PoolLike): Promise<OpenSessionRow[]> {
  const res = await db.query<OpenSessionRow>(
    `SELECT s.id, s.user_id, s.resource_id, s.hold_amount::text AS hold_amount,
            s.status, s.started_at::text AS started_at, s.ended_at::text AS ended_at,
            s.created_at::text AS created_at,
            r.rate_per_minute::text AS rate_per_minute,
            r.guac_connection_id, r.name AS resource_name
       FROM sessions s
       JOIN resources r ON r.id = s.resource_id
      WHERE s.status <> 'reconciled'
      ORDER BY s.created_at ASC`,
  );
  return res.rows;
}

/** Derived spendable balance per user (holds excluded — same formula as the backend). */
export async function getBalances(db: PoolLike, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  type Row = { user_id: string; credits: string; charges: string };
  const res = await db.query<Row>(
    `SELECT user_id,
            COALESCE(SUM(CASE WHEN type IN ('topup', 'refund') THEN amount ELSE 0 END), 0)::text AS credits,
            COALESCE(SUM(CASE WHEN type = 'charge' THEN amount ELSE 0 END), 0)::text AS charges
       FROM ledger_entries
      WHERE user_id = ANY($1)
      GROUP BY user_id`,
    [userIds],
  );
  for (const row of res.rows) {
    out.set(row.user_id, Number(row.credits) - Number(row.charges));
  }
  for (const id of userIds) {
    if (!out.has(id)) out.set(id, 0);
  }
  return out;
}

export async function markActive(db: PoolLike, sessionId: string, startedAt: Date): Promise<void> {
  await db.query(
    `UPDATE sessions SET status = 'active', started_at = $2
      WHERE id = $1 AND status = 'pending'`,
    [sessionId, startedAt.toISOString()],
  );
}

export async function markKilled(db: PoolLike, sessionIds: string[], endedAt: Date): Promise<void> {
  if (sessionIds.length === 0) return;
  await db.query(
    `UPDATE sessions SET status = 'killed', ended_at = $2
      WHERE id = ANY($1) AND status IN ('pending', 'active')`,
    [sessionIds, endedAt.toISOString()],
  );
}

export type ReconcileWrite = {
  sessionId: string;
  userId: string;
  endedAt: Date;
  finalCharge: number;
  historyRef: string | null;
};

/**
 * Atomic reconcile: session -> reconciled + append-only charge/refund rows.
 * Zero-amount legs are skipped (no zero rows in the ledger, ever).
 */
export async function reconcileSession(
  db: PoolLike,
  write: ReconcileWrite,
  holdAmount: number,
): Promise<void> {
  const refund = Math.round(Math.max(0, holdAmount - write.finalCharge) * 10000) / 10000;
  // One statement batch inside an explicit transaction.
  await db.query("BEGIN");
  try {
    await db.query(
      `UPDATE sessions
          SET status = 'reconciled', ended_at = $2,
              final_charge = $3, guac_history_ref = $4
        WHERE id = $1`,
      [write.sessionId, write.endedAt.toISOString(), write.finalCharge.toFixed(4), write.historyRef],
    );
    if (write.finalCharge > 0) {
      await db.query(
        `INSERT INTO ledger_entries (id, user_id, session_id, type, amount)
         VALUES ($1, $2, $3, 'charge', $4)`,
        [randomUUID(), write.userId, write.sessionId, write.finalCharge.toFixed(4)],
      );
    }
    if (refund > 0) {
      await db.query(
        `INSERT INTO ledger_entries (id, user_id, session_id, type, amount)
         VALUES ($1, $2, $3, 'refund', $4)`,
        [randomUUID(), write.userId, write.sessionId, refund.toFixed(4)],
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}
