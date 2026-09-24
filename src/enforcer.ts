import type { OpenSessionRow } from "./db.js";
import { accruedFor } from "./metering.js";

/**
 * Zero-balance enforcement.
 *
 * A live connection survives only while BOTH hold:
 *   - its owner's derived balance stays above zero, and
 *   - the accrued charge stays below the reserved hold.
 *
 * The second rule is what closes the loop: holds are capped by the balance
 * at creation, so without it a session could outlive its reservation
 * (spendable balance only moves at reconcile time). A mid-session top-up
 * raises the balance but never the hold — the hold stays the kill line.
 */

export type LiveSession = {
  session: OpenSessionRow;
  /** Guacamole active-connection id to remove. */
  activeId: string;
  /** Data source the connection was listed under (kill goes back there). */
  dataSource: string;
  /** Accrual start (portal started_at preferred, Guacamole startDate fallback). */
  startedMs: number;
  ratePerMinute: number;
  holdAmount: number;
};

export type KillDecision = {
  sessionId: string;
  userId: string;
  activeId: string;
  dataSource: string;
  balance: number;
  accrued: number;
  reason: "zero-balance" | "hold-exhausted";
};

export function decideKills(
  live: LiveSession[],
  balances: Map<string, number>,
  nowMs: number,
): KillDecision[] {
  const kills: KillDecision[] = [];
  for (const item of live) {
    const balance = balances.get(item.session.user_id) ?? 0;
    if (balance <= 0) {
      kills.push({ ...baseOf(item), balance, accrued: 0, reason: "zero-balance" });
      continue;
    }
    const accrued = accruedFor(item.ratePerMinute, item.startedMs, nowMs);
    if (accrued >= item.holdAmount) {
      kills.push({ ...baseOf(item), balance, accrued, reason: "hold-exhausted" });
    }
  }
  return kills;
}

function baseOf(item: LiveSession): Omit<KillDecision, "balance" | "accrued" | "reason"> {
  return {
    sessionId: item.session.id,
    userId: item.session.user_id,
    activeId: item.activeId,
    dataSource: item.dataSource,
  };
}
