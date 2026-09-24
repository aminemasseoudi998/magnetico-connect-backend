import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import { errorResponseSchema, ledgerTypeSchema } from "../plugins/swagger.js";
import { getBalance } from "../services/wallet.js";

const MAX_TOPUP = 1_000_000;

const ledgerEntrySchema = {
  type: "object",
  required: ["id", "type", "amount", "createdAt"],
  properties: {
    id: { type: "string" },
    type: ledgerTypeSchema,
    amount: { type: "number" },
    sessionId: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
} as const;

export async function walletRoutes(fastify: FastifyInstance): Promise<void> {
  /** 3. GET /api/wallet/balance — derived balance for the authenticated user. */
  fastify.get(
    "/api/wallet/balance",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["wallet"],
        summary: "Current balance",
        description: "Derived balance: SUM(topup) + SUM(refund) - SUM(charge). Holds excluded.",
        response: {
          200: {
            type: "object",
            required: ["balance"],
            properties: { balance: { type: "number" } },
          },
        },
      },
    },
    async (request) => {
    const user = getAuthUser(request);
    return { balance: await getBalance(fastify.prisma, user.id) };
  });

  /**
   * 4. POST /api/wallet/topup { amount } — inserts a 'topup' ledger entry.
   * Amounts are positive magnitudes (see services/wallet.ts convention).
   * TODO(payments): this is a stub credit — replace with a real PSP webhook
   * before any real money moves.
   */
  fastify.post<{ Body: { amount: number } }>(
    "/api/wallet/topup",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["wallet"],
        summary: "Top up credit",
        description: "Inserts a topup ledger entry (stub credit — real PSP webhook later).",
        body: {
          type: "object",
          required: ["amount"],
          additionalProperties: false,
          properties: { amount: { type: "number", exclusiveMinimum: 0, maximum: MAX_TOPUP } },
        },
        response: {
          201: {
            type: "object",
            required: ["balance", "entry"],
            properties: {
              balance: { type: "number" },
              entry: ledgerEntrySchema,
            },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);
      const { amount } = request.body;
      if (!Number.isFinite(amount) || Math.round(amount * 10000) / 10000 !== amount) {
        return reply.code(400).send({ error: "invalid_amount_precision" });
      }
      const entry = await fastify.prisma.ledgerEntry.create({
        data: { userId: user.id, type: "topup", amount: amount.toFixed(4) },
      });
      return reply.code(201).send({
        balance: await getBalance(fastify.prisma, user.id),
        entry: {
          id: entry.id,
          type: entry.type,
          amount: Number(entry.amount),
          sessionId: entry.sessionId,
          createdAt: entry.createdAt.toISOString(),
        },
      });
    },
  );

  /** 6. GET /api/wallet/transactions — full ledger entry list for the wallet page. */
  fastify.get<{ Querystring: { limit?: number } }>(
    "/api/wallet/transactions",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["wallet"],
        summary: "Ledger transactions",
        description: "Full ledger entry list for the wallet page, plus current balance.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        },
        response: {
          200: {
            type: "object",
            required: ["balance", "entries"],
            properties: {
              balance: { type: "number" },
              entries: { type: "array", items: ledgerEntrySchema },
            },
          },
        },
      },
    },
    async (request) => {
      const user = getAuthUser(request);
      const [entries, balance] = await Promise.all([
        fastify.prisma.ledgerEntry.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: request.query.limit ?? 100,
        }),
        getBalance(fastify.prisma, user.id),
      ]);
      return {
        balance,
        entries: entries.map((e) => ({
          id: e.id,
          type: e.type,
          amount: Number(e.amount),
          sessionId: e.sessionId,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );
}
