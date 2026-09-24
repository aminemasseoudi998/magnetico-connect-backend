import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import {
  errorResponseSchema,
  protocolSchema,
  sessionStatusSchema,
} from "../plugins/swagger.js";
import { getBalance } from "../services/wallet.js";
import {
  buildGuacPayload,
  getConnectionParams,
  getGuacUrl,
  getJsonSecretKey,
  signGuacToken,
  signGuacTokenStub,
} from "../services/guac-token.js";

/**
 * How many minutes of `rate_per_minute` the POST /api/sessions hold reserves.
 * Capped by the remaining balance, so a low balance yields a smaller hold
 * instead of a rejection (rejection only happens at ~zero). Per-entitlement
 * `max_session_min` narrows it further when set.
 * TODO(tariffs): confirm the default hold window with the real tariff table.
 */
const DEFAULT_HOLD_MINUTES = Number(process.env["HOLD_MINUTES_DEFAULT"] ?? 60);

class InsufficientBalanceError extends Error {
  balance: number;
  constructor(balance: number) {
    super("insufficient balance");
    this.balance = balance;
  }
}

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * 2. POST /api/sessions { resourceId } — entitlement + balance check, insert
   * session (pending), write a 'hold' ledger entry, return a Guacamole token.
   * The token is a real AES JSON-auth token when GUAC_JSON_AUTH_SECRET is set
   * (step 7); without the secret it falls back to the dev stub so endpoint
   * work doesn't block on a Guacamole stack.
   */
  fastify.post<{ Body: { resourceId: string } }>(
    "/api/sessions",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "Open a metered session",
        description:
          "Checks entitlement + balance, inserts a pending session, writes a hold. " +
          "Returns a Guacamole JSON-auth token (real when GUAC_JSON_AUTH_SECRET is set, stub otherwise).",
        body: {
          type: "object",
          required: ["resourceId"],
          additionalProperties: false,
          properties: { resourceId: { type: "string", minLength: 1 } },
        },
        response: {
          201: {
            type: "object",
            required: ["sessionId", "guacToken", "guacUrl"],
            properties: {
              sessionId: { type: "string" },
              guacToken: { type: "string" },
              guacUrl: { type: "string" },
            },
          },
          400: errorResponseSchema,
          402: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);

      const resource = await fastify.prisma.resource.findUnique({
        where: { id: request.body.resourceId },
      });
      if (resource === null) {
        return reply.code(404).send({ error: "resource_not_found" });
      }
      if (!resource.active) {
        return reply.code(403).send({ error: "resource_inactive" });
      }

      const entitlement = await fastify.prisma.entitlement.findUnique({
        where: { userId_resourceId: { userId: user.id, resourceId: resource.id } },
      });
      if (entitlement === null) {
        return reply.code(403).send({ error: "no_entitlement" });
      }

      // NOTE(race, step 14): check-then-write inside one interactive transaction
      // narrows but does not eliminate double-spend under concurrency. The
      // billing daemon (step 9) reconciles against actual usage; a serializable
      // hold with row locking is hardening work, not PoC work.
      try {
        const { session } = await fastify.prisma.$transaction(async (tx) => {
          const balance = await getBalance(tx, user.id);
          const holdMinutes = entitlement.maxSessionMin ?? DEFAULT_HOLD_MINUTES;
          const rate = Number(resource.ratePerMinute);
          const holdAmount =
            Math.round(Math.min(balance, rate * holdMinutes) * 10000) / 10000;
          if (!Number.isFinite(holdAmount) || holdAmount <= 0) {
            throw new InsufficientBalanceError(balance);
          }
          const created = await tx.session.create({
            data: {
              userId: user.id,
              resourceId: resource.id,
              holdAmount: holdAmount.toFixed(4),
              status: "pending",
            },
          });
          await tx.ledgerEntry.create({
            data: {
              userId: user.id,
              sessionId: created.id,
              type: "hold",
              amount: holdAmount.toFixed(4),
            },
          });
          return { session: created, balance };
        });

        let guacToken: string;
        if (process.env["GUAC_JSON_AUTH_SECRET"] === undefined) {
          request.log.warn("sessions: GUAC_JSON_AUTH_SECRET unset — returning stub token (dev only)");
          guacToken = signGuacTokenStub({
            connectionId: resource.guacConnectionId,
            userId: user.id,
            sessionId: session.id,
          });
        } else {
          try {
            const payload = buildGuacPayload({
              sessionId: session.id,
              connectionName: resource.guacConnectionId,
              protocol: resource.protocol,
              parameters: getConnectionParams(resource.guacConnectionId),
            });
            guacToken = signGuacToken(payload, getJsonSecretKey());
          } catch (err) {
            request.log.error({ err }, "sessions: Guacamole token signing failed");
            return reply
              .code(500)
              .send({ error: "guac_token_failed", detail: (err as Error).message });
          }
        }
        return reply.code(201).send({
          sessionId: session.id,
          guacToken,
          guacUrl: getGuacUrl(resource.guacConnectionId, guacToken),
        });
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          return reply
            .code(402)
            .send({ error: "insufficient_balance", balance: err.balance });
        }
        throw err;
      }
    },
  );

  /**
   * 5. GET /api/sessions/history — past sessions with resource + final_charge.
   */
  fastify.get<{ Querystring: { limit?: number } }>(
    "/api/sessions/history",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "Session history",
        description: "Past sessions for the authenticated user, joined with resource + final charge.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        },
        response: {
          200: {
            type: "object",
            required: ["sessions"],
            properties: {
              sessions: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "id",
                    "status",
                    "holdAmount",
                    "createdAt",
                    "resource",
                  ],
                  properties: {
                    id: { type: "string" },
                    status: sessionStatusSchema,
                    holdAmount: { type: "number" },
                    finalCharge: { type: ["number", "null"] },
                    guacHistoryRef: { type: ["string", "null"] },
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
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const user = getAuthUser(request);

      const sessions = await fastify.prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: request.query.limit ?? 50,
        include: { resource: true },
      });

      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          holdAmount: Number(s.holdAmount),
          finalCharge: s.finalCharge === null ? null : Number(s.finalCharge),
          guacHistoryRef: s.guacHistoryRef,
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
