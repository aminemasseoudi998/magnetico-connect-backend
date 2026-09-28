import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import {
  errorResponseSchema,
  healthViewSchema,
  protocolSchema,
  sessionStatusSchema,
} from "../plugins/swagger.js";
import { healthOf } from "../services/metrics.js";
import {
  availableCredit,
  endSession,
  finalizeSession,
  liveRegistry,
  sessionRate,
  watchRegistry,
} from "../services/live-sessions.js";
import { isConfigured, minCap, readSettings } from "../services/servers.js";
import { issueTicket, revokeTickets } from "../services/tunnel-tickets.js";
import { HOLD_CHUNK_MINUTES, MIN_CREDIT_SECONDS } from "./tunnel.js";

/** Public URL of the display WebSocket (routes/tunnel.ts), as browsers reach it. */
function tunnelUrl(): string {
  return process.env["TUNNEL_PUBLIC_URL"] ?? "ws://localhost:4000/api/tunnel";
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

class OpenRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const liveSessionSchema = {
  type: "object",
  required: ["id", "status", "ratePerMinute", "holdAmount", "createdAt", "resource"],
  properties: {
    id: { type: "string" },
    status: sessionStatusSchema,
    ratePerMinute: { type: "number" },
    holdAmount: { type: "number" },
    maxSessionMin: { type: ["integer", "null"] },
    startedAt: { type: ["string", "null"] },
    endedAt: { type: ["string", "null"] },
    finalCharge: { type: ["number", "null"] },
    endReason: { type: ["string", "null"] },
    /** Seconds of connection the user can still afford (credit + time cap). */
    runwaySeconds: { type: ["number", "null"] },
    /** Administrators watching this session right now (read-only). */
    watchers: { type: "integer" },
    createdAt: { type: "string" },
    resource: {
      type: "object",
      required: ["id", "name", "protocol"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        protocol: protocolSchema,
      },
    },
  },
} as const;

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/sessions { resourceId } — open a metered session.
   *
   * Checks access and credit, reserves a hold (a chunk of credit, topped up
   * while the session runs), and returns a one-time ticket for the display
   * tunnel. Nothing Guacamole-related leaves the backend.
   */
  fastify.post<{ Body: { resourceId: string } }>(
    "/api/sessions",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "Open a metered session",
        description:
          "Checks access + credit, inserts a pending session with a hold, and returns a " +
          "single-use ticket (60 s) for the display WebSocket at `tunnel.url`.",
        body: {
          type: "object",
          required: ["resourceId"],
          additionalProperties: false,
          properties: { resourceId: { type: "string", format: "uuid" } },
        },
        response: {
          201: {
            type: "object",
            required: ["session", "tunnel"],
            properties: {
              session: liveSessionSchema,
              tunnel: {
                type: "object",
                required: ["url", "ticket", "expiresAt"],
                properties: {
                  url: { type: "string" },
                  ticket: { type: "string" },
                  expiresAt: { type: "string" },
                },
              },
            },
          },
          402: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);
      const prisma = fastify.prisma;

      const server = await prisma.resource.findUnique({ where: { id: request.body.resourceId } });
      if (server === null || server.archivedAt !== null) {
        return reply.code(404).send({ error: "resource_not_found" });
      }
      if (!server.active) return reply.code(403).send({ error: "resource_inactive" });
      if (!isConfigured(server)) return reply.code(409).send({ error: "server_not_configured" });

      const entitlement = await prisma.entitlement.findUnique({
        where: { userId_resourceId: { userId: user.id, resourceId: server.id } },
      });
      if (!server.openToAll && entitlement === null) {
        return reply.code(403).send({ error: "no_entitlement" });
      }

      // One live session per user per server. A pending one whose ticket was
      // never used (reload, double click) is replaced; a connected one is not.
      const existing = await prisma.session.findMany({
        where: { userId: user.id, resourceId: server.id, status: { in: ["pending", "active"] } },
      });
      for (const s of existing) {
        if (s.status === "active" || liveRegistry.has(s.id)) {
          return reply.code(409).send({ error: "session_already_open", sessionId: s.id });
        }
        revokeTickets(s.id);
        await finalizeSession(prisma, s.id, "never_connected");
      }

      const rate = Number(server.ratePerMinute);
      const capMinutes = minCap(server.maxSessionMin, entitlement?.maxSessionMin ?? null);

      try {
        // NOTE(race, step 14): check-then-write; a serializable transaction
        // with row locks would close the double-spend window completely.
        const session = await prisma.$transaction(async (tx) => {
          const free = await availableCredit(tx, user.id);
          if (free < (rate * MIN_CREDIT_SECONDS) / 60) {
            throw new OpenRefusal(402, "insufficient_balance", { balance: free });
          }
          const minutes = Math.min(HOLD_CHUNK_MINUTES, capMinutes ?? Infinity);
          const hold = round4(Math.min(free, rate * minutes));
          const created = await tx.session.create({
            data: {
              userId: user.id,
              resourceId: server.id,
              holdAmount: hold.toFixed(4),
              ratePerMinute: server.ratePerMinute,
              recorded: readSettings(server.settings).recording,
              status: "pending",
            },
          });
          await tx.ledgerEntry.create({
            data: { userId: user.id, sessionId: created.id, type: "hold", amount: hold.toFixed(4) },
          });
          return created;
        });

        const { ticket, expiresAt } = issueTicket(session.id, user.id);
        return reply.code(201).send({
          session: {
            id: session.id,
            status: session.status,
            ratePerMinute: rate,
            holdAmount: Number(session.holdAmount),
            maxSessionMin: capMinutes,
            startedAt: null,
            endedAt: null,
            finalCharge: null,
            endReason: null,
            runwaySeconds: null,
            createdAt: session.createdAt.toISOString(),
            resource: { id: server.id, name: server.name, protocol: server.protocol },
          },
          tunnel: { url: tunnelUrl(), ticket, expiresAt: expiresAt.toISOString() },
        });
      } catch (err) {
        if (err instanceof OpenRefusal) {
          return reply.code(err.status).send({ error: err.code, ...err.extra });
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/sessions/:id — live status for the session page's meter, which
   * polls it: holds grow when credit is topped up, and the server may end a
   * session (credit, time cap, admin) at any moment.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "One session (live status)",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "object", required: ["session"], properties: { session: liveSessionSchema } },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);
      const session = await fastify.prisma.session.findUnique({
        where: { id: request.params.id },
        include: { resource: true },
      });
      if (session === null || session.userId !== user.id) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const rate = sessionRate(session, session.resource.ratePerMinute);
      const entitlement = await fastify.prisma.entitlement.findUnique({
        where: { userId_resourceId: { userId: user.id, resourceId: session.resourceId } },
      });
      const capMinutes = minCap(session.resource.maxSessionMin, entitlement?.maxSessionMin ?? null);

      let runwaySeconds: number | null = null;
      if (session.status === "active" && session.startedAt !== null) {
        const elapsed = (Date.now() - session.startedAt.getTime()) / 1000;
        const free = await availableCredit(fastify.prisma, user.id);
        const creditSeconds = ((Number(session.holdAmount) + Math.max(0, free)) / rate) * 60 - elapsed;
        const capSeconds = capMinutes === null ? Infinity : capMinutes * 60 - elapsed;
        runwaySeconds = Math.max(0, Math.round(Math.min(creditSeconds, capSeconds)));
      }

      return {
        session: {
          id: session.id,
          status: session.status,
          ratePerMinute: rate,
          holdAmount: Number(session.holdAmount),
          maxSessionMin: capMinutes,
          startedAt: session.startedAt?.toISOString() ?? null,
          endedAt: session.endedAt?.toISOString() ?? null,
          finalCharge: session.finalCharge === null ? null : Number(session.finalCharge),
          endReason: session.endReason,
          runwaySeconds,
          watchers: watchRegistry.count(session.id),
          createdAt: session.createdAt.toISOString(),
          resource: {
            id: session.resource.id,
            name: session.resource.name,
            protocol: session.resource.protocol,
          },
        },
      };
    },
  );

  /**
   * GET /api/sessions/:id/health — health of the server behind my session
   * (only while it is open, and only if the admin enabled monitoring).
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/sessions/:id/health",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "Health of my session's server",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: { 200: healthViewSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);
      const session = await fastify.prisma.session.findUnique({
        where: { id: request.params.id },
        include: { resource: true },
      });
      if (session === null || session.userId !== user.id) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (session.status !== "pending" && session.status !== "active") {
        return { mode: "off", samples: [], latest: null, lastError: null };
      }
      return healthOf(session.resource, 60);
    },
  );

  /** POST /api/sessions/:id/close — the user ends their own session. */
  fastify.post<{ Params: { id: string } }>(
    "/api/sessions/:id/close",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "End my session",
        description: "Closes the display tunnel and bills the connected time.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          204: { type: "null" },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = getAuthUser(request);
      const session = await fastify.prisma.session.findUnique({ where: { id: request.params.id } });
      if (session === null || session.userId !== user.id) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      revokeTickets(session.id);
      await endSession(fastify.prisma, session.id, "user_closed");
      return reply.code(204).send();
    },
  );

  /**
   * GET /api/sessions/history — past sessions with resource + final_charge.
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
                    endReason: { type: ["string", "null"] },
                    ratePerMinute: { type: "number" },
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
          endReason: s.endReason,
          ratePerMinute: sessionRate(s, s.resource.ratePerMinute),
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
