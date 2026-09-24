import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Step 5 — wallet helpers over the APPEND-ONLY ledger.
 *
 * Canonical rule (prompt.md data model):
 *   balance = SUM(topup) + SUM(refund) - SUM(charge)
 * `hold` rows are reservations only and are NEVER counted in the balance.
 *
 * Amount convention (enforced at every write site in step 5):
 *   topup/refund/hold/charge rows all store POSITIVE magnitudes; the sign
 *   lives in the `type` column, not the `amount` column. This keeps the
 *   formula above unambiguous. (The frontend mocks use negative charges —
 *   step 6 will map `type` -> display sign instead of reading the raw sign.)
 */

type LedgerReader = Pick<PrismaClient, "ledgerEntry">;

function toNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** Derived spendable balance for a user. Holds are excluded by design. */
export async function getBalance(db: LedgerReader, userId: string): Promise<number> {
  const sums = await db.ledgerEntry.groupBy({
    by: ["type"],
    where: { userId },
    _sum: { amount: true },
  });
  let topup = 0;
  let refund = 0;
  let charge = 0;
  for (const row of sums) {
    const amount = toNumber(row._sum.amount);
    if (row.type === "topup") topup = amount;
    else if (row.type === "refund") refund = amount;
    else if (row.type === "charge") charge = amount;
    // 'hold' intentionally ignored.
  }
  // Round to 4dp (DB precision) to avoid float dust in JSON responses.
  return Math.round((topup + refund - charge) * 10000) / 10000;
}
