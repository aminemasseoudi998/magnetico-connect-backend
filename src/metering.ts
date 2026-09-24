/**
 * Pure metering math (easily unit-tested, no I/O).
 *
 * Billing basis matches the product rule everywhere else (frontend meter,
 * backend hold sizing): rate_per_minute prorated to the second, 4dp ledger
 * precision. Holds are reservations; the final charge is computed from
 * actually elapsed time, and any unspent hold is refunded by the reconciler.
 */

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Elapsed whole-fraction minutes between two epoch-ms timestamps. */
export function elapsedMinutes(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / 60000);
}

/** Metered charge for a connection alive `elapsedMs` at the given rate. */
export function finalChargeFor(ratePerMinute: number, elapsedMs: number): number {
  if (!Number.isFinite(ratePerMinute) || ratePerMinute < 0) return 0;
  return round4((ratePerMinute * Math.max(0, elapsedMs)) / 60000);
}

/** Live accrued spend for a session started at `startedMs`, seen at `nowMs`. */
export function accruedFor(ratePerMinute: number, startedMs: number, nowMs: number): number {
  if (!Number.isFinite(startedMs)) return 0;
  return finalChargeFor(ratePerMinute, Math.max(0, nowMs - startedMs));
}

/** Split a hold into its settled legs. Refund is never negative. */
export function splitHold(
  holdAmount: number,
  finalCharge: number,
): { charge: number; refund: number } {
  const charge = Math.max(0, finalCharge);
  return { charge, refund: round4(Math.max(0, holdAmount - charge)) };
}
