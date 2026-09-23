import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

/**
 * Shared PrismaClient for the Portal DB.
 * Guacamole's DB is never accessed here — only via its REST API (step 9).
 *
 * Wrapped in fastify-plugin so the `prisma` decorator is visible to sibling
 * route plugins (plain register() would encapsulate it away).
 */
let prisma: PrismaClient | undefined;

async function prismaPluginInner(fastify: FastifyInstance): Promise<void> {
  if (prisma === undefined) {
    prisma = new PrismaClient();
  }
  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async () => {
    await prisma?.$disconnect();
    prisma = undefined;
  });
}

export const prismaPlugin = fp(prismaPluginInner);

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
