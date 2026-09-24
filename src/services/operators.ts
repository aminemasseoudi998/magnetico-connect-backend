import type { Prisma, PrismaClient, User } from "@prisma/client";

/**
 * Org-wide operator views for the admin console.
 *
 * The admin table needs three derived numbers per account — balance, 30-day
 * spend and 30-day session count — for every user at once. Computing them per
 * row would be one query per operator; these helpers aggregate the whole org
 * in three grouped queries instead, then join in memory.
 *
 * Balance follows the same canonical rule as services/wallet.ts:
 *   balance = SUM(topup) + SUM(refund) - SUM(charge), holds excluded.
 */

type OperatorReader = Pick<PrismaClient, "user" | "ledgerEntry" | "session">;

export const SPEND_WINDOW_DAYS = 30;

export type OperatorSummary = {
  id: string;
  email: string;
  displayName: string;
  team: string | null;
  role: User["role"];
  status: User["status"];
  balance: number;
  /** Magneticoin actually charged in the trailing 30 days. */
  spend30d: number;
  sessions30d: number;
  createdAt: string;
};

function toNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** Rounds to the ledger's 4dp so float dust never reaches the JSON response. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Server-side filters for the admin roster. */
export type OperatorFilters = {
  /** Free-text match over display name, email and team. */
  q?: string | undefined;
  status?: "active" | "suspended" | undefined;
};

/** How many accounts each state tab holds for the current search. */
export type OperatorCounts = {
  all: number;
  active: number;
  suspended: number;
};

/**
 * Free-text clause shared by the listing and the counts, so a tab can never
 * advertise a number the table below it would not show.
 */
function searchClause(q: string | undefined) {
  const term = q?.trim();
  if (term === undefined || term.length === 0) return {};
  return {
    OR: [
      { displayName: { contains: term, mode: "insensitive" as const } },
      { email: { contains: term, mode: "insensitive" as const } },
      { team: { contains: term, mode: "insensitive" as const } },
    ],
  };
}

export function windowStart(days = SPEND_WINDOW_DAYS): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Balance for every user that has any ledger row, keyed by user id.
 * Users with an empty ledger are simply absent — callers default them to 0.
 */
async function balancesByUser(db: OperatorReader): Promise<Map<string, number>> {
  const rows = await db.ledgerEntry.groupBy({
    by: ["userId", "type"],
    _sum: { amount: true },
  });
  const out = new Map<string, number>();
  for (const row of rows) {
    // 'hold' rows are reservations, never part of the balance.
    if (row.type === "hold") continue;
    const signed = row.type === "charge" ? -toNumber(row._sum.amount) : toNumber(row._sum.amount);
    out.set(row.userId, (out.get(row.userId) ?? 0) + signed);
  }
  return out;
}

/** SUM(charge) per user inside the trailing window. */
async function spendByUser(db: OperatorReader, since: Date): Promise<Map<string, number>> {
  const rows = await db.ledgerEntry.groupBy({
    by: ["userId"],
    where: { type: "charge", createdAt: { gte: since } },
    _sum: { amount: true },
  });
  return new Map(rows.map((row) => [row.userId, toNumber(row._sum.amount)]));
}

/** Session count per user inside the trailing window. */
async function sessionCountByUser(db: OperatorReader, since: Date): Promise<Map<string, number>> {
  const rows = await db.session.groupBy({
    by: ["userId"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.userId, row._count._all]));
}

function summarize(
  user: User,
  balances: Map<string, number>,
  spend: Map<string, number>,
  sessions: Map<string, number>,
): OperatorSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    team: user.team,
    role: user.role,
    status: user.status,
    balance: round4(balances.get(user.id) ?? 0),
    spend30d: round4(spend.get(user.id) ?? 0),
    sessions30d: sessions.get(user.id) ?? 0,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Every operator matching `filters`, with their derived billing figures,
 * newest account last. `deleted` users are always excluded: they are
 * tombstones, not accounts an admin can act on.
 *
 * Searching and filtering happen in Postgres rather than in the browser so
 * the console behaves the same at 7 accounts and at 7,000 — and so the
 * console never has to hold the whole org in memory to find one person.
 */
export async function listOperators(
  db: OperatorReader,
  filters: OperatorFilters = {},
): Promise<OperatorSummary[]> {
  const since = windowStart();

  const where = {
    status: filters.status ?? { not: "deleted" as const },
    ...searchClause(filters.q),
  };

  const [users, balances, spend, sessions] = await Promise.all([
    db.user.findMany({ where, orderBy: { createdAt: "asc" } }),
    balancesByUser(db),
    spendByUser(db, since),
    sessionCountByUser(db, since),
  ]);
  return users.map((user) => summarize(user, balances, spend, sessions));
}

/** One operator, or null when the id is unknown or the row is a tombstone. */
export async function getOperator(
  db: OperatorReader,
  id: string,
): Promise<OperatorSummary | null> {
  const user = await db.user.findUnique({ where: { id } });
  if (user === null || user.status === "deleted") return null;

  const since = windowStart();
  const [balance, spend, sessions] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ["type"], where: { userId: id }, _sum: { amount: true } }),
    db.ledgerEntry.aggregate({
      where: { userId: id, type: "charge", createdAt: { gte: since } },
      _sum: { amount: true },
    }),
    db.session.count({ where: { userId: id, createdAt: { gte: since } } }),
  ]);

  let net = 0;
  for (const row of balance) {
    if (row.type === "hold") continue;
    net += row.type === "charge" ? -toNumber(row._sum.amount) : toNumber(row._sum.amount);
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    team: user.team,
    role: user.role,
    status: user.status,
    balance: round4(net),
    spend30d: round4(toNumber(spend._sum.amount)),
    sessions30d: sessions,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Per-state totals for the console's state tabs.
 *
 * Deliberately honours `q` but ignores the selected state: the tabs are a
 * facet over the current search, so "Suspended 2" means two of the accounts
 * matching what was typed — not two in the whole org, and not two in the tab
 * that happens to be open.
 */
export async function countOperators(
  db: OperatorReader,
  q?: string | undefined,
): Promise<OperatorCounts> {
  const rows = await db.user.groupBy({
    by: ["status"],
    where: { status: { not: "deleted" }, ...searchClause(q) },
    _count: { _all: true },
  });

  const counts: OperatorCounts = { all: 0, active: 0, suspended: 0 };
  for (const row of rows) {
    if (row.status === "active") counts.active = row._count._all;
    else if (row.status === "suspended") counts.suspended = row._count._all;
    counts.all += row._count._all;
  }
  return counts;
}
