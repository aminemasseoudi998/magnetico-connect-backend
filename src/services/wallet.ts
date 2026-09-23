import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthUser } from "../plugins/auth-types.js";

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

/**
 * The step-4 stub auth attaches a fake identity that may not exist in the DB
 * yet (fresh clone, no seed). Every write/read path calls this first so
 * endpoints work out of the box. Step 11 keeps the same call — the real JWT
 * path will upsert on keycloak_sub instead of the stub id.
 */
export async function ensureUser(
  db: Pick<PrismaClient, "user">,
  user: AuthUser,
): Promise<void> {
  try {
    await db.user.upsert({
      where: { id: user.id },
      update: {},
      create: {
        id: user.id,
        keycloakSub: user.keycloakSub,
        email: user.email,
        displayName: user.displayName,
      },
    });
  } catch (err) {
    // Same email/keycloak_sub already registered under a different row id
    // (e.g. reseeded DB). Fall back to the existing row instead of 500ing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.user.findFirst({
        where: { OR: [{ keycloakSub: user.keycloakSub }, { email: user.email }] },
        select: { id: true },
      });
      if (existing !== null) return;
    }
    throw err;
  }
}
