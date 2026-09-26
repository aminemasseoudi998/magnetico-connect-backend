import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import {
  errorResponseSchema,
  protocolSchema,
  sessionStatusSchema,
} from "../plugins/swagger.js";
import { getBalance } from "../services/wallet.js";
import {
  clientUrl,
  deleteUser,
  ensureConnection,
  ensureSessionUser,
  grantConnection,
  guacAdminConfig,
  guacAdminLogin,
  GuacAdminError,
  loginAs,
  randomPassword,
} from "../services/guac-admin.js";
import {
  getConnectionParams,
  getGuacUrl,
  signGuacTokenStub,
} from "../services/guac-token.js";

/**
 * How many minutes of `rate_per_minute` the POST /api/sessions hold reserves.
 * Capped by the remaining balance, so a low balance yields a smaller hold
 * instead of a rejection (rejection only happens at ~zero). Per-entitlement
 * `max_session_min` narrows it further when set.
 * TODO(tariffs): confirm the default hold window with the real tariff table.
 */
import type { PrismaClient } from "@prisma/client";

const DEFAULT_HOLD_MINUTES = Number(process.env["HOLD_MINUTES_DEFAULT"] ?? 60);

type Provision =
  | { stub: true }
  | { guacUrl: string }
  | { error: "guac_provision_failed" | "connection_unconfigured"; detail: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** node-fetch errors (ECONNREFUSED etc.) surface as TypeError: fetch failed. */
function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Provision the Guacamole side of a session: ensure the JDBC connection,
 * create a throwaway user named = session id, grant it that one connection,
 * log in as it. Returns the browser handoff URL, a stub fallback, or a
 * 500-class error descriptor (never throws for expected failures).
 */
async function provisionGuacamole(
  request: FastifyRequest,
  prisma: PrismaClient,
  resource: { id: string; name: string; protocol: "ssh" | "rdp"; guacConnectionId: string },
  sessionId: string,
): Promise<Provision> {
  const cfg = guacAdminConfig();
  let adminToken: string;
  try {
    adminToken = await guacAdminLogin(cfg);
  } catch (err) {
    if (isUnreachable(err)) {
      request.log.warn("sessions: Guacamole unreachable — stub token (dev only)");
      return { stub: true };
    }
    return { error: "guac_provision_failed", detail: messageOf(err) };
  }

  let parameters: Record<string, string>;
  try {
    parameters = getConnectionParams(resource.guacConnectionId);
  } catch (err) {
    return { error: "connection_unconfigured", detail: messageOf(err) };
  }

  const sessionPassword = randomPassword();
  try {
    const connectionId = await ensureConnection(cfg, adminToken, {
      name: resource.name,
      protocol: resource.protocol,
      parameters,
    });
    if (connectionId !== resource.guacConnectionId) {
      await prisma.resource.update({
        where: { id: resource.id },
        data: { guacConnectionId: connectionId },
      });
    }
    await ensureSessionUser(cfg, adminToken, sessionId, sessionPassword);
    await grantConnection(cfg, adminToken, sessionId, connectionId);
    const authToken = await loginAs(cfg, sessionId, sessionPassword);
    return { guacUrl: clientUrl(cfg, connectionId, authToken) };
  } catch (err) {
    await deleteUser(cfg, adminToken, sessionId).catch(() => undefined);
    if (isUnreachable(err)) {
      request.log.warn("sessions: Guacamole unreachable mid-provision — stub token (dev only)");
      return { stub: true };
    }
    return { error: "guac_provision_failed", detail: messageOf(err) };
  }
}

/** Remove a provisioned session user when the portal write fails afterwards. */
async function provisionedCleanup(request: FastifyRequest, sessionId: string): Promise<void> {
  try {
    const cfg = guacAdminConfig();
    const adminToken = await guacAdminLogin(cfg);
    await deleteUser(cfg, adminToken, sessionId);
  } catch (err) {
    request.log.warn({ err }, "sessions: orphan Guacamole user cleanup failed");
  }
}

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * 2. POST /api/sessions { resourceId } — entitlement + balance check, reserve
   * a hold, provision the session in Guacamole, return the client handoff.
   *
   * Provisioning (step 7b): the JDBC connection is ensured by resource name,
   * a throwaway JDBC user named = session id is created with a fresh random
   * password, granted READ on that one connection, and logged in server-side;
   * the returned `guacUrl` carries the resulting auth token (`?token=`), so
   * the browser never touches Guacamole credentials or CORS. JDBC-backed
   * tunnels are visible to the admin REST, which is what the billing daemon
   * meters (pure JSON-auth tunnels are invisible to every Guacamole
   * observability surface — verified live, see services/guac-token.ts).
   *
   * Without GUAC_JSON_AUTH_SECRET the endpoint falls back to the dev stub so
   * endpoint work doesn't block on a Guacamole stack.
   */
  fastify.post<{ Body: { resourceId: string } }>(
    "/api/sessions",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["sessions"],
        summary: "Open a metered session",
        description:
          "Checks entitlement + balance, reserves a hold, provisions a " +
          "per-session Guacamole user, and returns the client handoff URL " +
          "(stub token when GUAC_JSON_AUTH_SECRET is unset).",
        body: {
          type: "object",
          required: ["resourceId"],
          additionalProperties: false,
          properties: { resourceId: { type: "string", minLength: 1 } },
        },
        response: {
          201: {
            type: "object",
            required: ["sessionId", "guacUrl"],
            properties: {
              sessionId: { type: "string" },
              guacUrl: { type: "string" },
              guacToken: { type: "string" },
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

      // Balance is read before provisioning so a broke request never creates
      // Guacamole accounts. NOTE(race, step 14): check-then-write is not
      // serializable; the billing daemon reconciles against actual usage.
      const balance = await getBalance(fastify.prisma, user.id);
      const holdMinutes = entitlement.maxSessionMin ?? DEFAULT_HOLD_MINUTES;
      const rate = Number(resource.ratePerMinute);
      const holdAmount = Math.round(Math.min(balance, rate * holdMinutes) * 10000) / 10000;
      if (!Number.isFinite(holdAmount) || holdAmount <= 0) {
        return reply.code(402).send({ error: "insufficient_balance", balance });
      }

      // Session id doubles as the Guacamole username (step-7 correlation for
      // the billing daemon), so it is minted before anything is persisted.
      const sessionId = randomUUID();

      // Provision Guacamole. Unreachable stack in dev -> stub fallback (same
      // shape as the secret-unset path); real misconfiguration -> 500.
      let guacUrl: string;
      let stubToken: string | undefined;
      if (process.env["GUAC_JSON_AUTH_SECRET"] === undefined) {
        request.log.warn("sessions: GUAC_JSON_AUTH_SECRET unset — returning stub token (dev only)");
        stubToken = signGuacTokenStub({
          connectionId: resource.guacConnectionId,
          userId: user.id,
          sessionId,
        });
        guacUrl = getGuacUrl(resource.guacConnectionId, stubToken);
      } else {
        const provision = await provisionGuacamole(request, fastify.prisma, resource, sessionId);
        if ("stub" in provision) {
          stubToken = signGuacTokenStub({
            connectionId: resource.guacConnectionId,
            userId: user.id,
            sessionId,
          });
          guacUrl = getGuacUrl(resource.guacConnectionId, stubToken);
        } else if ("error" in provision) {
          return reply.code(500).send({ error: provision.error, detail: provision.detail });
        } else {
          guacUrl = provision.guacUrl;
        }
      }

      try {
        await fastify.prisma.$transaction([
          fastify.prisma.session.create({
            data: {
              id: sessionId,
              userId: user.id,
              resourceId: resource.id,
              holdAmount: holdAmount.toFixed(4),
              status: "pending",
            },
          }),
          fastify.prisma.ledgerEntry.create({
            data: {
              userId: user.id,
              sessionId,
              type: "hold",
              amount: holdAmount.toFixed(4),
            },
          }),
        ]);
      } catch (err) {
        // A provisioned Guacamole user with no portal session must not linger.
        await provisionedCleanup(request, sessionId).catch(() => undefined);
        throw err;
      }

      return reply.code(201).send(
        stubToken === undefined
          ? { sessionId, guacUrl }
          : { sessionId, guacUrl, guacToken: stubToken },
      );
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
