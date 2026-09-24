import type { OpenSessionRow } from "./db.js";
import type { GuacHistoryEntry } from "./guac.js";
import { finalChargeFor } from "./metering.js";

/**
 * Settlement for sessions that are no longer live.
 *
 * For each open (non-reconciled) session absent from the active set:
 *   - never seen live AND younger than the token grace window -> skip (the
 *     operator may still be on their way from POST /api/sessions).
 *   - otherwise settle: prefer the Guacamole history row (username ==
 *     session id, step-7 correlation) for real start/end; fall back to the
 *     portal timestamps when Guacamole has no record (never connected).
 *   - abandoned tickets (no Guacamole activity at all) settle at zero charge
 *     with a full hold refund, so holds can never lock funds forever.
 */

export type ReconcilePlan = {
  session: OpenSessionRow;
  endedAt: Date;
  finalCharge: number;
  historyRef: string | null;
};

export function planReconciliations(args: {
  open: OpenSessionRow[];
  activeSessionIds: Set<string>;
  seenActive: Set<string>;
  history: GuacHistoryEntry[];
  nowMs: number;
  tokenGraceMs: number;
}): ReconcilePlan[] {
  const { open, activeSessionIds, seenActive, history, nowMs, tokenGraceMs } = args;
  const plans: ReconcilePlan[] = [];

  const historyByUser = new Map<string, GuacHistoryEntry[]>();
  for (const entry of history) {
    const list = historyByUser.get(entry.username) ?? [];
    list.push(entry);
    historyByUser.set(entry.username, list);
  }

  for (const session of open) {
    if (activeSessionIds.has(session.id)) continue;

    const candidates = (historyByUser.get(session.id) ?? [])
      .filter((e) => e.endDate !== null || e.startDate <= nowMs)
      .sort((a, b) => (b.endDate ?? b.startDate) - (a.endDate ?? a.startDate));
    const record = candidates[0];

    if (record === undefined && !seenActive.has(session.id)) {
      // Never touched Guacamole. Give fresh tickets the grace window, then
      // release the hold untouched.
      const createdMs = Date.parse(session.created_at);
      if (Number.isFinite(createdMs) && nowMs - createdMs < tokenGraceMs) continue;
      plans.push({
        session,
        endedAt: new Date(nowMs),
        finalCharge: 0,
        historyRef: null,
      });
      continue;
    }

    const rate = Number(session.rate_per_minute);
    if (record !== undefined) {
      const startMs = record.startDate;
      const endMs = record.endDate ?? nowMs;
      plans.push({
        session,
        endedAt: new Date(endMs),
        finalCharge: finalChargeFor(rate, Math.max(0, endMs - startMs)),
        historyRef: record.identifier,
      });
    } else {
      // Was live, now gone, but Guacamole kept no history row: bill the
      // portal-observed window.
      const startMs = session.started_at !== null ? Date.parse(session.started_at) : nowMs;
      const endMs = session.ended_at !== null ? Date.parse(session.ended_at) : nowMs;
      plans.push({
        session,
        endedAt: new Date(Number.isFinite(endMs) ? endMs : nowMs),
        finalCharge: finalChargeFor(rate, Math.max(0, (Number.isFinite(endMs) ? endMs : nowMs) - (Number.isFinite(startMs) ? startMs : nowMs))),
        historyRef: null,
      });
    }
  }

  return plans;
}
