import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import {
  errorResponseSchema,
  operatorRoleSchema,
  operatorStatusSchema,
  protocolSchema,
  sessionStatusSchema,
} from "../plugins/swagger.js";
import {
  countOperators,
  getOperator,
  listOperators,
  SPEND_WINDOW_DAYS,
} from "../services/operators.js";

/**
 * Admin console endpoints — org-wide, `admin` role only.
 *
 * Every path here starts with /api/admin/, which the global hook in
 * plugins/auth.ts already guards with requireAdmin; each route repeats it as
 * its own preHandler so the guard survives a change to that matcher.
 *
 * What an admin can change about someone else is deliberately narrow: role,
 * team and status. Balance is never written directly — credit goes through
 * the append-only ledger like every other movement, so the books stay
 * reconcilable.
 */

const MAX_CREDIT = 1_000_000;
const MAX_TEAM_LENGTH = 80;
const MAX_QUERY_LENGTH = 120;

const operatorSchema = {
  type: "object",
  required: [
    "id",
    "email",
    "displayName",
    "team",
    "role",
    "status",
    "balance",
    "spend30d",
    "sessions30d",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string" },
    team: { type: ["string", "null"] },
    role: operatorRoleSchema,
    status: operatorStatusSchema,
    balance: { type: "number" },
    spend30d: { type: "number" },
    sessions30d: { type: "integer" },
    createdAt: { type: "string" },
  },
} as const;

/** Facet counts driving the console's state tabs. */
const operatorCountsSchema = {
  type: "object",
  required: ["all", "active", "suspended"],
  properties: {
    all: { type: "integer" },
    active: { type: "integer" },
    suspended: { type: "integer" },
  },
} as const;

const operatorSessionSchema = {
  type: "object",
  required: ["id", "status", "holdAmount", "createdAt", "resource"],
  properties: {
    id: { type: "string" },
    status: sessionStatusSchema,
    holdAmount: { type: "number" },
    finalCharge: { type: ["number", "null"] },
    startedAt: { type: ["string", "null"] },
    endedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    resource: {
      type: "object",
      required: ["id", "name", "protocol", "tier"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        protocol: protocolSchema,
        tier: { type: "string" },
      },
    },
  },
} as const;

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/operators — accounts with derived billing figures.
   *
   * `q` and `status` filter in Postgres rather than in the console, so the
   * page behaves identically whether the org has seven accounts or seven
   * thousand, and the browser never has to hold them all to find one person.
   */
  fastify.get<{ Querystring: { q?: string; status?: "active" | "suspended" } }>(
    "/api/admin/operators",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "List operators",
        description:
          "Non-deleted accounts with derived balance, " +
          `${SPEND_WINDOW_DAYS}-day spend and session count. ` +
          "`q` matches display name, email or team (case-insensitive substring). " +
          "`counts` is a facet over `q` alone — it ignores `status`, so each tab " +
          "can show how many of the current matches it holds.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: MAX_QUERY_LENGTH },
            status: operatorStatusSchema,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["operators", "counts"],
            properties: {
              operators: { type: "array", items: operatorSchema },
              counts: operatorCountsSchema,
            },
          },
          403: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const [operators, counts] = await Promise.all([
        listOperators(fastify.prisma, { q: request.query.q, status: request.query.status }),
        countOperators(fastify.prisma, request.query.q),
      ]);
      return { operators, counts };
    },
  );

  /** GET /api/admin/operators/:id — one account. */
  fastify.get<{ Params: { id: string } }>(
    "/api/admin/operators/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Get one operator",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            required: ["operator"],
            properties: { operator: operatorSchema },
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await getOperator(fastify.prisma, request.params.id);
      if (operator === null) return reply.code(404).send({ error: "operator_not_found" });
      return { operator };
    },
  );

  /**
   * PATCH /api/admin/operators/:id — role, team and status.
   *
   * An admin cannot demote or suspend themselves: locking the last admin out
   * of the console is not a recoverable mistake from inside the product.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { role?: "admin" | "engineer" | "analyst"; team?: string | null; status?: "active" | "suspended" };
  }>(
    "/api/admin/operators/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Update an operator",
        description:
          "Changes role, team and/or status. Refuses self-demotion and self-suspension " +
          "(403 cannot_modify_self).",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            role: operatorRoleSchema,
            team: { type: ["string", "null"], maxLength: MAX_TEAM_LENGTH },
            status: operatorStatusSchema,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["operator"],
            properties: { operator: operatorSchema },
          },
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = getAuthUser(request);
      const { id } = request.params;
      const { role, team, status } = request.body;

      if (id === actor.id && ((role !== undefined && role !== "admin") || status === "suspended")) {
        return reply.code(403).send({ error: "cannot_modify_self" });
      }

      const target = await fastify.prisma.user.findUnique({ where: { id } });
      if (target === null || target.status === "deleted") {
        return reply.code(404).send({ error: "operator_not_found" });
      }

      await fastify.prisma.user.update({
        where: { id },
        data: {
          ...(role !== undefined ? { role } : {}),
          // An empty string means "no team" rather than a team literally named "".
          ...(team !== undefined ? { team: team === null || team.trim() === "" ? null : team.trim() } : {}),
          ...(status !== undefined ? { status } : {}),
        },
      });

      const operator = await getOperator(fastify.prisma, id);
      if (operator === null) return reply.code(404).send({ error: "operator_not_found" });
      return { operator };
    },
  );

  /**
   * POST /api/admin/operators/:id/credit { amount } — grant credit.
   *
   * Appends a `topup` row to the ledger rather than writing a balance: the
   * ledger is append-only and the balance is always derived from it.
   */
  fastify.post<{ Params: { id: string }; Body: { amount: number } }>(
    "/api/admin/operators/:id/credit",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Grant credit",
        description: "Appends a topup ledger entry to another operator's account.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["amount"],
          additionalProperties: false,
          properties: { amount: { type: "number", exclusiveMinimum: 0, maximum: MAX_CREDIT } },
        },
        response: {
          201: {
            type: "object",
            required: ["operator"],
            properties: { operator: operatorSchema },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { amount } = request.body;

      // Same 4dp guard as the self-service top-up: the column is Decimal(12,4)
      // and silently rounding someone's credit is worse than refusing it.
      if (!Number.isFinite(amount) || Math.round(amount * 10000) / 10000 !== amount) {
        return reply.code(400).send({ error: "invalid_amount_precision" });
      }

      const target = await fastify.prisma.user.findUnique({ where: { id } });
      if (target === null || target.status === "deleted") {
        return reply.code(404).send({ error: "operator_not_found" });
      }

      await fastify.prisma.ledgerEntry.create({
        data: { userId: id, type: "topup", amount: amount.toFixed(4) },
      });

      const operator = await getOperator(fastify.prisma, id);
      if (operator === null) return reply.code(404).send({ error: "operator_not_found" });
      return reply.code(201).send({ operator });
    },
  );

  /** GET /api/admin/operators/:id/sessions — that operator's session history. */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    "/api/admin/operators/:id/sessions",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Operator session history",
        description: "Sessions run by one operator, newest first, joined with the resource.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
        },
        response: {
          200: {
            type: "object",
            required: ["sessions"],
            properties: { sessions: { type: "array", items: operatorSessionSchema } },
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const target = await fastify.prisma.user.findUnique({ where: { id } });
      if (target === null || target.status === "deleted") {
        return reply.code(404).send({ error: "operator_not_found" });
      }

      const sessions = await fastify.prisma.session.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: request.query.limit ?? 100,
        include: { resource: true },
      });

      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          holdAmount: Number(s.holdAmount),
          finalCharge: s.finalCharge === null ? null : Number(s.finalCharge),
          startedAt: s.startedAt?.toISOString() ?? null,
          endedAt: s.endedAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          resource: {
            id: s.resource.id,
            name: s.resource.name,
            protocol: s.resource.protocol,
            tier: s.resource.tier,
          },
        })),
      };
    },
  );
}
