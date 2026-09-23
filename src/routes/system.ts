import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";

/**
 * System routes: public liveness probe + stub-identity echo.
 * Lives in a route plugin (registered after swagger in server.ts) so the
 * OpenAPI collector sees these paths too — root-level fastify.get() calls
 * run before async plugins boot and would be missing from /docs/json.
 */
export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  // Public — the only /api/* route that skips auth (prompt.md §BACKEND API).
  fastify.get(
    "/api/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    },
    async () => ({ ok: true }),
  );

  // Proves the step-4 middleware works; step-5 endpoints follow this pattern:
  //   { preHandler: [requireAuth] } + request.user!.id for Prisma scoping.
  fastify.get(
    "/api/me",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["health"],
        summary: "Stub identity",
        description: "Echoes the attached auth identity. Debug helper while auth is stubbed.",
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  keycloakSub: { type: "string" },
                  email: { type: "string" },
                  displayName: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request) => ({
      user: request.user,
    }),
  );
}
