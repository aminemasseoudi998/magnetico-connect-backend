import type { FastifyInstance } from "fastify";
import type { AuditSeverity, Prisma } from "@prisma/client";
import { requireAdmin } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import { errorResponseSchema } from "../plugins/swagger.js";
import { audit } from "../services/audit.js";
import { openRecording, recordingInfo } from "../services/recordings.js";
import { computeAnalytics, RANGES, type RangeKey } from "../services/analytics.js";

/**
 * Admin console read models: the audit trail and the Operations overview's
 * figures, all computed from real rows (audit_events, sessions).
 */


export async function adminInsightRoutes(fastify: FastifyInstance): Promise<void> {
  const prisma = fastify.prisma;

  /** GET /api/admin/audit — the audit trail, newest first. */
  fastify.get<{
    Querystring: {
      severity?: AuditSeverity | "all";
      q?: string;
      targetType?: string;
      targetId?: string;
      limit?: number;
    };
  }>(
    "/api/admin/audit",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Audit trail",
        description:
          "Admin actions, Guacamole sync changes and Keycloak role changes. `q` matches the " +
          "actor, target or action (case-insensitive). `counts` ignores `severity`.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", enum: ["all", "info", "warn", "crit"], default: "all" },
            q: { type: "string", maxLength: 120 },
            targetType: { type: "string", enum: ["server", "session", "user", "system"] },
            targetId: { type: "string", maxLength: 64 },
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["events", "counts"],
            properties: {
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    at: { type: "string" },
                    actorId: { type: ["string", "null"] },
                    actorLabel: { type: "string" },
                    action: { type: "string" },
                    severity: { type: "string" },
                    targetType: { type: "string" },
                    targetId: { type: ["string", "null"] },
                    targetLabel: { type: "string" },
                    details: { type: "object", additionalProperties: true },
                  },
                },
              },
              counts: {
                type: "object",
                properties: { info: { type: "integer" }, warn: { type: "integer" }, crit: { type: "integer" } },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { severity = "all", q, targetType, targetId, limit = 200 } = request.query;
      const text = q?.trim();
      const base: Prisma.AuditEventWhereInput = {
        ...(targetType ? { targetType } : {}),
        ...(targetId ? { targetId } : {}),
        ...(text
          ? {
              OR: [
                { actorLabel: { contains: text, mode: "insensitive" } },
                { targetLabel: { contains: text, mode: "insensitive" } },
                { action: { contains: text, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [events, grouped] = await Promise.all([
        prisma.auditEvent.findMany({
          where: { ...base, ...(severity !== "all" ? { severity } : {}) },
          orderBy: { at: "desc" },
          take: limit,
        }),
        prisma.auditEvent.groupBy({ by: ["severity"], where: base, _count: { _all: true } }),
      ]);
      const counts = { info: 0, warn: 0, crit: 0 };
      for (const g of grouped) counts[g.severity] = g._count._all;
      return {
        events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
        counts,
      };
    },
  );

  /**
   * GET /api/admin/analytics — everything the Operations overview shows,
   * for a range and the previous range of the same length. `tzOffset` is
   * the admin browser's Date#getTimezoneOffset() (minutes).
   */
  fastify.get<{ Querystring: { range?: RangeKey; tzOffset?: number } }>(
    "/api/admin/analytics",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Overview analytics",
        description:
          "KPIs vs the previous period, revenue/usage timeline (hourly for 24h, daily otherwise), " +
          "session outcomes, duration distribution, top servers/users, protocol split, utilization " +
          "heatmap, credit and fleet health.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            range: { type: "string", enum: Object.keys(RANGES), default: "7d" },
            tzOffset: { type: "integer", minimum: -840, maximum: 840, default: 0 },
          },
        },
      },
    },
    async (request) => computeAnalytics(prisma, request.query.range ?? "7d", request.query.tzOffset ?? 0),
  );

  const idParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  } as const;

  /** GET /api/admin/sessions/:id/recording/info — is there something to replay? */
  fastify.get<{ Params: { id: string } }>(
    "/api/admin/sessions/:id/recording/info",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Session recording status",
        params: idParams,
        response: {
          200: {
            type: "object",
            properties: {
              available: { type: "boolean" },
              sizeBytes: { type: "integer" },
              historyUuid: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => recordingInfo(prisma, request.params.id),
  );

  /**
   * GET /api/admin/sessions/:id/recording — the raw Guacamole recording
   * (played in the browser by guacamole-common-js). Every view is audited.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/admin/sessions/:id/recording",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Download a session recording",
        params: idParams,
        response: { 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await openRecording(prisma, request.params.id);
      if (!("stream" in result)) {
        return reply.code(404).send({ error: result.available ? "not_found" : result.reason });
      }
      const admin = getAuthUser(request);
      const session = await prisma.session.findUnique({
        where: { id: request.params.id },
        include: { user: { select: { email: true } }, resource: { select: { name: true } } },
      });
      await audit(prisma, {
        actor: { id: admin.id, label: admin.email },
        action: "session.recording_viewed",
        target: {
          type: "session",
          id: request.params.id,
          label: `${session?.user.email ?? "?"} on ${session?.resource.name ?? "?"}`,
        },
      }, request.log);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(result.sizeBytes))
        .header("cache-control", "private, no-store")
        .send(result.stream);
    },
  );
}
