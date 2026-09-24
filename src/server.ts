// Must stay first: loads backend/.env so the server and Prisma see it
// without requiring shell exports. Shell variables still win over the file.
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { authPlugin } from "./plugins/auth.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { openapiOptions, swaggerUiOptions } from "./plugins/swagger.js";
import { adminRoutes } from "./routes/admin.js";
import { resourceRoutes } from "./routes/resources.js";
import { sessionRoutes } from "./routes/sessions.js";
import { systemRoutes } from "./routes/system.js";
import { walletRoutes } from "./routes/wallet.js";

export function buildServer() {
  const fastify = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  void fastify.register(cors, { origin: true });
  void fastify.register(prismaPlugin);
  void fastify.register(authPlugin);
  // Registered on root (both are fastify-plugin wrapped) so the spec
  // collector sees every route. UI at /docs, JSON at /docs/json.
  void fastify.register(swagger, openapiOptions);
  void fastify.register(swaggerUi, swaggerUiOptions);

  // Public — the only /api/* route that skips auth (prompt.md §BACKEND API).
  // NOTE: lives in systemRoutes (a plugin registered after swagger) so the
  // OpenAPI collector sees it — see routes/system.ts.

  // Core endpoints, all protected by requireAuth (each route declares it; the
  // global authPlugin enforces it for /api/* and requireAdmin for
  // /api/admin/* as a backstop).
  void fastify.register(systemRoutes);
  void fastify.register(resourceRoutes);
  void fastify.register(sessionRoutes);
  void fastify.register(walletRoutes);
  void fastify.register(adminRoutes);

  return fastify;
}

const port = Number(process.env["PORT"] ?? 4000);

if (process.argv[1]?.endsWith("server.ts") === true || process.argv[1]?.endsWith("server.js") === true) {
  const server = buildServer();
  server
    .listen({ port, host: "0.0.0.0" })
    .catch((err) => {
      server.log.error(err);
      process.exit(1);
    });
}
