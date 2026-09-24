import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";
import type { FastifySwaggerUiOptions } from "@fastify/swagger-ui";

/**
 * OpenAPI config. Registered directly on the root instance in server.ts —
 * both @fastify/swagger and @fastify/swagger-ui are fastify-plugin wrapped,
 * so the onRoute collector sees every route (a nested wrapper of our own
 * would hide sibling routes from the spec — same encapsulation trap as the
 * prisma decorator, see plugins/prisma.ts).
 *
 * Auth: every /api/* route except /api/health requires a Keycloak access
 * token (`bearerAuth`, applied globally below). /api/admin/* additionally
 * requires the `admin` realm role.
 */
export const openapiOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Magnetico Portal API",
      version: "0.1.0",
      description:
        "Metered remote-access portal. Billing: balance = SUM(topup) + SUM(refund) - SUM(charge); " +
        "`hold` rows are reservations and never count toward the balance. " +
        "Auth: Keycloak access token as `Authorization: Bearer <jwt>` on every /api/* route except /api/health. " +
        "/api/admin/* additionally requires the `admin` realm role.",
    },
    servers: [{ url: "http://localhost:4000", description: "Local dev" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "health", description: "Public liveness probe" },
      { name: "resources", description: "Entitled servers for the authenticated user" },
      { name: "sessions", description: "Create metered sessions, read history" },
      { name: "wallet", description: "Balance, top-ups, ledger" },
    ],
  },
  hideUntagged: true,
};

export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: true },
};

/** Shared shape for { error } responses (402 adds `balance`). */
export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    balance: { type: "number" },
  },
} as const;

export const protocolSchema = { type: "string", enum: ["ssh", "rdp"] } as const;

export const ledgerTypeSchema = {
  type: "string",
  enum: ["topup", "hold", "charge", "refund"],
} as const;

export const sessionStatusSchema = {
  type: "string",
  enum: ["pending", "active", "closed", "killed", "reconciled"],
} as const;
