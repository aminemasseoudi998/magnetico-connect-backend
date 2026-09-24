import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import { protocolSchema } from "../plugins/swagger.js";

/**
 * 1. GET /api/resources — resources the authenticated user is entitled to.
 * Only active resources are returned; entitlement rows pointing at a
 * deactivated resource are hidden (not deleted) so reactivation restores them.
 */
export async function resourceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/resources",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["resources"],
        summary: "List entitled resources",
        description: "Resources the authenticated user is entitled to (active only).",
        response: {
          200: {
            type: "object",
            required: ["resources"],
            properties: {
              resources: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "id",
                    "name",
                    "protocol",
                    "tier",
                    "guacConnectionId",
                    "ratePerMinute",
                  ],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    protocol: protocolSchema,
                    tier: { type: "string" },
                    guacConnectionId: { type: "string" },
                    ratePerMinute: { type: "number" },
                    maxSessionMin: { type: ["integer", "null"] },
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

    const entitlements = await fastify.prisma.entitlement.findMany({
      where: { userId: user.id },
      include: { resource: true },
      orderBy: { resource: { name: "asc" } },
    });

    return {
      resources: entitlements
        .filter((e) => e.resource.active)
        .map((e) => ({
          id: e.resource.id,
          name: e.resource.name,
          protocol: e.resource.protocol,
          tier: e.resource.tier,
          guacConnectionId: e.resource.guacConnectionId,
          ratePerMinute: Number(e.resource.ratePerMinute),
          maxSessionMin: e.maxSessionMin,
        })),
    };
  });
}
