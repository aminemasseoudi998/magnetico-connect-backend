import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import { protocolSchema } from "../plugins/swagger.js";
import { isConfigured, userView } from "../services/servers.js";

/**
 * GET /api/resources — servers the authenticated user may connect to.
 *
 * Visible = active, configured, not archived, and either open to everyone
 * or granted to this user. The response is the user view: name, protocol,
 * price and limits — never the hostname, port, username or credentials.
 */
export async function resourceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/resources",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["resources"],
        summary: "List servers I can use",
        description:
          "Active servers open to everyone or granted to the caller. Connection details " +
          "(host, port, credentials) are never included.",
        response: {
          200: {
            type: "object",
            required: ["resources"],
            properties: {
              resources: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "name", "protocol", "tier", "ratePerMinute"],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: ["string", "null"] },
                    protocol: protocolSchema,
                    tier: { type: "string" },
                    ratePerMinute: { type: "number" },
                    maxSessionMin: { type: ["integer", "null"] },
                    recorded: { type: "boolean" },
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

      const servers = await fastify.prisma.resource.findMany({
        where: {
          active: true,
          archivedAt: null,
          OR: [{ openToAll: true }, { entitlements: { some: { userId: user.id } } }],
        },
        include: { entitlements: { where: { userId: user.id } } },
        orderBy: { name: "asc" },
      });

      return {
        resources: servers
          .filter(isConfigured)
          .map((s) => userView(s, s.entitlements[0]?.maxSessionMin ?? null)),
      };
    },
  );
}
