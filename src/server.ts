// Must stay first: loads backend/.env so the server and Prisma see it
// without requiring shell exports. Shell variables still win over the file.
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { authPlugin } from "./plugins/auth.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { openapiOptions, swaggerUiOptions } from "./plugins/swagger.js";
import { adminRoutes } from "./routes/admin.js";
import { adminServerRoutes } from "./routes/admin-servers.js";
import { adminInsightRoutes } from "./routes/admin-insights.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { assertGuacamoleConfigured, syncNow } from "./services/guacamole.js";
import { sweepOrphans } from "./services/live-sessions.js";
import { assertSecretsConfigured } from "./services/secrets.js";
import { startMetrics, stopMetrics } from "./services/metrics.js";
import { resourceRoutes } from "./routes/resources.js";
import { sessionRoutes } from "./routes/sessions.js";
import { systemRoutes } from "./routes/system.js";
import { walletRoutes } from "./routes/wallet.js";

export function buildServer() {
  const fastify = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  void fastify.register(cors, { origin: true });
  // Remote display tunnel (routes/tunnel.ts). Clipboard pastes are the
  // largest client frames; 4 MiB bounds a hostile client.
  void fastify.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
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
  void fastify.register(adminServerRoutes);
  void fastify.register(adminInsightRoutes);
  void fastify.register(tunnelRoutes);

  // Settle sessions whose tunnel is gone (restart, abandoned ticket) at boot
  // and every minute after.
  let sweeper: NodeJS.Timeout | undefined;
  fastify.addHook("onReady", async () => {
    const sweep = () =>
      void sweepOrphans(fastify.prisma, fastify.log).catch((err: unknown) =>
        fastify.log.error({ err }, "sweeper failed"),
      );
    sweep();
    sweeper = setInterval(sweep, 60_000);
  });
  fastify.addHook("onClose", async () => clearInterval(sweeper));

  // Two-way sync with Guacamole: at boot, then every 30 s (also run on each
  // Admin → Servers page load). Retries after 30 s when Guacamole is down.
  let mirror: NodeJS.Timeout | undefined;
  let closing = false;
  const sync = async () => {
    const next = 30_000;
    try {
      const report = await syncNow(fastify.prisma, fastify.log);
      if (report.imported + report.updatedFromGuacamole + report.removed > 0) {
        fastify.log.info(report, "guacamole: two-way sync applied changes");
      }
    } catch (err) {
      fastify.log.warn({ err: (err as Error).message }, "guacamole: sync failed, retrying in 30 s");
    }
    if (!closing) mirror = setTimeout(() => void sync(), next);
  };
  fastify.addHook("onReady", async () => {
    void sync();
    // Live server health (services/metrics.ts).
    startMetrics(fastify.prisma, fastify.log);
  });
  fastify.addHook("onClose", async () => stopMetrics());
  fastify.addHook("onClose", async () => {
    closing = true;
    clearTimeout(mirror);
  });

  return fastify;
}

const port = Number(process.env["PORT"] ?? 4000);

if (process.argv[1]?.endsWith("server.ts") === true || process.argv[1]?.endsWith("server.js") === true) {
  // Refuse to start half-configured: without these keys no server can be
  // saved or connected, and the failure would only surface much later.
  try {
    assertSecretsConfigured();
    assertGuacamoleConfigured();
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    process.exit(1);
  }
  const server = buildServer();
  server
    .listen({ port, host: "0.0.0.0" })
    .catch((err) => {
      server.log.error(err);
      process.exit(1);
    });
}
