import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient, type Resource } from "@prisma/client";
import { requireAdmin } from "../plugins/auth.js";
import { getAuthUser } from "../plugins/auth-types.js";
import { errorResponseSchema, healthViewSchema, protocolSchema, sessionStatusSchema } from "../plugins/swagger.js";
import { healthOf, latestHealth } from "../services/metrics.js";
import {
  deleteConnection,
  guacDashboardUrl,
  probe,
  syncIfStale,
  syncNow,
  syncServer,
} from "../services/guacamole.js";
import { removeServer } from "../services/server-removal.js";
import { audit, changedFields } from "../services/audit.js";
import { endSession, liveRegistry } from "../services/live-sessions.js";
import { encryptSecret } from "../services/secrets.js";
import {
  adminView,
  readSecrets,
  readSettings,
  settingsSchema,
  TIERS,
  type AdminServerStats,
    type ServerSettings,
} from "../services/servers.js";
import { issueTicket, revokeTickets } from "../services/tunnel-tickets.js";

/**
 * Admin console: servers and live sessions. Everything under /api/admin/ is
 * already guarded by requireAdmin globally; each route repeats it.
 *
 * Credentials are write-only: they are encrypted on the way in
 * (services/secrets.ts) and responses only report `hasPassword` etc.
 * PATCH semantics for secrets: omitted = keep, null or "" = remove,
 * string = replace.
 */

const MAX_RATE = 100_000;
const STATS_WINDOW_DAYS = 30;

/* ---------------------------------------------------------------- schemas */

const HOSTNAME_PATTERN = "^[A-Za-z0-9._:\\[\\]-]+$";

const serverInputProperties = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  description: { type: ["string", "null"], maxLength: 300 },
  protocol: protocolSchema,
  tier: { type: "string", enum: [...TIERS] },
  hostname: { type: "string", minLength: 1, maxLength: 253, pattern: HOSTNAME_PATTERN },
  port: { type: "integer", minimum: 1, maximum: 65535 },
  username: { type: ["string", "null"], maxLength: 128 },
  password: { type: ["string", "null"], maxLength: 1024 },
  privateKey: { type: ["string", "null"], maxLength: 16384 },
  passphrase: { type: ["string", "null"], maxLength: 1024 },
  settings: settingsSchema,
  ratePerMinute: { type: "number", exclusiveMinimum: 0, maximum: MAX_RATE },
  maxSessionMin: { type: ["integer", "null"], minimum: 1, maximum: 10080 },
  openToAll: { type: "boolean" },
  active: { type: "boolean" },
  /** Replaces the access list (users allowed when openToAll is false). */
  userIds: {
    type: "array",
    maxItems: 5000,
    uniqueItems: true,
    items: { type: "string", format: "uuid" },
  },
} as const;

type ServerInput = {
  name?: string;
  description?: string | null;
  protocol?: "ssh" | "rdp";
  tier?: (typeof TIERS)[number];
  hostname?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  settings?: Partial<ServerSettings>;
  ratePerMinute?: number;
  maxSessionMin?: number | null;
  openToAll?: boolean;
  active?: boolean;
  userIds?: string[];
};

const serverSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "name", "protocol", "hostname", "port", "ratePerMinute", "active", "stats"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    protocol: protocolSchema,
    tier: { type: "string" },
    hostname: { type: "string" },
    port: { type: "integer" },
    username: { type: ["string", "null"] },
    hasPassword: { type: "boolean" },
    hasPrivateKey: { type: "boolean" },
    hasPassphrase: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
    ratePerMinute: { type: "number" },
    maxSessionMin: { type: ["integer", "null"] },
    openToAll: { type: "boolean" },
    active: { type: "boolean" },
    configured: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    userIds: { type: "array", items: { type: "string" } },
    guacConnectionId: { type: ["string", "null"] },
    guacamoleUrl: { type: ["string", "null"] },
    guacImported: { type: "boolean" },
    health: {
      type: ["object", "null"],
      properties: {
        at: { type: "number" },
        cpuPct: { type: ["number", "null"] },
        memUsedPct: { type: ["number", "null"] },
        diskUsedPct: { type: ["number", "null"] },
      },
    },
    stats: {
      type: "object",
      properties: {
        entitledUsers: { type: "integer" },
        liveSessions: { type: "integer" },
        sessions30d: { type: "integer" },
        revenue30d: { type: "number" },
      },
    },
  },
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const adminSessionSchema = {
  type: "object",
  required: ["id", "status", "createdAt", "user", "resource", "live"],
  properties: {
    id: { type: "string" },
    status: sessionStatusSchema,
    live: { type: "boolean" },
    recorded: { type: "boolean" },
    ratePerMinute: { type: "number" },
    holdAmount: { type: "number" },
    finalCharge: { type: ["number", "null"] },
    endReason: { type: ["string", "null"] },
    startedAt: { type: ["string", "null"] },
    endedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    user: {
      type: "object",
      properties: { id: { type: "string" }, email: { type: "string" }, displayName: { type: "string" } },
    },
    resource: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, protocol: protocolSchema },
    },
  },
} as const;

/* ---------------------------------------------------------------- helpers */

class InputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Normalises + validates the cross-field rules JSON-schema cannot express. */
function checkInput(input: ServerInput, protocol: "ssh" | "rdp"): void {
  if (input.ratePerMinute !== undefined && Math.round(input.ratePerMinute * 10000) / 10000 !== input.ratePerMinute) {
    throw new InputError(400, "invalid_rate_precision");
  }
  if (typeof input.privateKey === "string" && input.privateKey.trim() !== "") {
    if (protocol !== "ssh") throw new InputError(400, "private_key_ssh_only");
    if (!PRIVATE_KEY.test(input.privateKey)) throw new InputError(400, "invalid_private_key");
  }
  if (input.name !== undefined && input.name.trim() === "") throw new InputError(400, "name_required");
}

/** omitted → undefined (keep); null/"" → null (clear); text → ciphertext. */
function sealed(value: string | null | undefined, serverId: string, trim = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = trim ? value.trim() : value;
  return text === "" ? null : encryptSecret(text, serverId);
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

async function statsFor(prisma: PrismaClient, ids: string[]): Promise<Map<string, AdminServerStats>> {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);
  const [entitled, recent, live] = await Promise.all([
    prisma.entitlement.groupBy({ by: ["resourceId"], where: { resourceId: { in: ids } }, _count: { _all: true } }),
    prisma.session.groupBy({
      by: ["resourceId"],
      where: { resourceId: { in: ids }, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { finalCharge: true },
    }),
    prisma.session.groupBy({
      by: ["resourceId"],
      where: { resourceId: { in: ids }, status: "active" },
      _count: { _all: true },
    }),
  ]);
  const out = new Map<string, AdminServerStats>();
  for (const id of ids) {
    out.set(id, { entitledUsers: 0, liveSessions: 0, sessions30d: 0, revenue30d: 0 });
  }
  for (const row of entitled) out.get(row.resourceId)!.entitledUsers = row._count._all;
  for (const row of live) out.get(row.resourceId)!.liveSessions = row._count._all;
  for (const row of recent) {
    const s = out.get(row.resourceId)!;
    s.sessions30d = row._count._all;
    s.revenue30d = Math.round(Number(row._sum.finalCharge ?? 0) * 10000) / 10000;
  }
  return out;
}

/** Admin view + a deep link to the mirrored connection in Guacamole. */
function withGuacamole(view: ReturnType<typeof adminView>, server: Resource) {
  const latest = latestHealth(server.id);
  return {
    ...view,
    health: latest
      ? { at: latest.at, cpuPct: latest.cpuPct, memUsedPct: latest.memUsedPct, diskUsedPct: latest.diskUsedPct }
      : null,
    guacImported: server.guacImported,
    guacConnectionId: server.guacConnectionId,
    guacamoleUrl:
      server.guacConnectionId === null
        ? null
        : `${guacDashboardUrl()}/#/manage/postgresql/connections/${server.guacConnectionId}`,
  };
}

async function viewOf(prisma: PrismaClient, server: Resource) {
  const [stats, access] = await Promise.all([
    statsFor(prisma, [server.id]),
    prisma.entitlement.findMany({ where: { resourceId: server.id }, select: { userId: true } }),
  ]);
  return { ...withGuacamole(adminView(server, stats.get(server.id)!), server), userIds: access.map((a) => a.userId) };
}

/** Replaces who may use a server (only matters while openToAll is false). */
async function setAccess(
  tx: Prisma.TransactionClient,
  serverId: string,
  userIds: string[],
  grantedBy: string,
): Promise<void> {
  const valid = await tx.user.findMany({
    where: { id: { in: userIds }, status: { not: "deleted" } },
    select: { id: true },
  });
  const keep = valid.map((u) => u.id);
  await tx.entitlement.deleteMany({ where: { resourceId: serverId, userId: { notIn: keep } } });
  const existing = await tx.entitlement.findMany({
    where: { resourceId: serverId },
    select: { userId: true },
  });
  const have = new Set(existing.map((e) => e.userId));
  const add = keep.filter((id) => !have.has(id));
  if (add.length > 0) {
    await tx.entitlement.createMany({
      data: add.map((userId) => ({ userId, resourceId: serverId, grantedBy })),
      skipDuplicates: true,
    });
  }
}

const AUDITED_FIELDS = [
  "name",
  "description",
  "protocol",
  "tier",
  "hostname",
  "port",
  "username",
  "ratePerMinute",
  "maxSessionMin",
  "openToAll",
  "active",
];

/** Records what an edit changed — values for plain fields, only "changed" for secrets. */
async function auditServerUpdate(
  prisma: PrismaClient,
  actor: { id: string; label: string },
  before: Resource,
  after: Resource,
  input: ServerInput,
  log: import("fastify").FastifyBaseLogger,
) {
  const plain = (r: Resource) => ({ ...r, ratePerMinute: Number(r.ratePerMinute) }) as unknown as Record<string, unknown>;
  const changes: Record<string, unknown> = changedFields(plain(before), plain(after), AUDITED_FIELDS);
  const settings = changedFields(
    readSettings(before.settings) as unknown as Record<string, unknown>,
    readSettings(after.settings) as unknown as Record<string, unknown>,
    Object.keys(readSettings(after.settings)),
  );
  if (Object.keys(settings).length > 0) changes["settings"] = settings;
  for (const secret of ["password", "privateKey", "passphrase"] as const) {
    const value = input[secret];
    if (value !== undefined) changes[secret] = value === null || value === "" ? "removed" : "changed";
  }
  if (input.userIds !== undefined) changes["accessList"] = `${input.userIds.length} user(s)`;
  if (Object.keys(changes).length === 0) return;

  const drained = before.active && !after.active;
  const restored = !before.active && after.active;
  await audit(prisma, {
    actor,
    action: drained ? "server.drained" : restored ? "server.restored" : "server.updated",
    severity: drained ? "warn" : "info",
    target: { type: "server", id: after.id, label: after.name },
    details: changes,
  }, log);
}

function sendInputError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (err instanceof InputError) return reply.code(err.status).send({ error: err.code });
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return reply.code(409).send({ error: "name_taken" });
  }
  throw err;
}

/* ---------------------------------------------------------------- routes */

export async function adminServerRoutes(fastify: FastifyInstance): Promise<void> {
  const prisma = fastify.prisma;

  /** GET /api/admin/servers — every server (drained included, archived not). */
  fastify.get(
    "/api/admin/servers",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "List servers",
        response: {
          200: {
            type: "object",
            required: ["servers", "guacamoleDashboard"],
            properties: {
              servers: { type: "array", items: serverSchema },
              /** Guacamole admin dashboard, as an admin's browser reaches it. */
              guacamoleDashboard: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => {
      // Pick up what admins changed in the Guacamole UI before listing —
      // but never hold the page for long if Guacamole is slow or down.
      await Promise.race([
        syncIfStale(prisma, request.log).catch((err: unknown) =>
          request.log.warn({ err: (err as Error).message }, "guacamole: sync before list failed"),
        ),
        new Promise((resolve) => setTimeout(resolve, 4_000)),
      ]);
      const servers = await prisma.resource.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
      });
      const stats = await statsFor(prisma, servers.map((s) => s.id));
      return {
        servers: servers.map((s) => withGuacamole(adminView(s, stats.get(s.id)!), s)),
        guacamoleDashboard: guacDashboardUrl(),
      };
    },
  );

  /** GET /api/admin/servers/:id — one server + its access list. */
  fastify.get<{ Params: { id: string } }>(
    "/api/admin/servers/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Get one server",
        params: idParams,
        response: {
          200: { type: "object", required: ["server"], properties: { server: serverSchema } },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const server = await prisma.resource.findUnique({ where: { id: request.params.id } });
      if (server === null || server.archivedAt !== null) {
        return reply.code(404).send({ error: "server_not_found" });
      }
      return { server: await viewOf(prisma, server) };
    },
  );

  /** POST /api/admin/servers — add a server. */
  fastify.post<{ Body: ServerInput }>(
    "/api/admin/servers",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Add a server",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "protocol", "tier", "hostname", "port", "ratePerMinute"],
          properties: serverInputProperties,
        },
        response: {
          201: { type: "object", required: ["server"], properties: { server: serverSchema } },
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const admin = getAuthUser(request);
      const input = request.body;
      try {
        checkInput(input, input.protocol!);
        const id = randomUUID();
        const settings = { ...readSettings({}), ...(input.settings ?? {}) };
        const server = await prisma.$transaction(async (tx) => {
          const created = await tx.resource.create({
            data: {
              id,
              name: input.name!.trim(),
              description: emptyToNull(input.description) ?? null,
              protocol: input.protocol!,
              tier: input.tier!,
              hostname: input.hostname!.trim(),
              port: input.port!,
              username: emptyToNull(input.username) ?? null,
              passwordEnc: sealed(input.password, id) ?? null,
              privateKeyEnc: input.protocol === "ssh" ? (sealed(input.privateKey, id, true) ?? null) : null,
              passphraseEnc: input.protocol === "ssh" ? (sealed(input.passphrase, id) ?? null) : null,
              settings,
              ratePerMinute: input.ratePerMinute!.toFixed(4),
              maxSessionMin: input.maxSessionMin ?? null,
              openToAll: input.openToAll ?? false,
              active: input.active ?? true,
            },
          });
          if (input.userIds !== undefined) await setAccess(tx, id, input.userIds, admin.email);
          return created;
        });
        const guacId = await syncServer(prisma, server, request.log);
        request.log.info({ serverId: server.id, admin: admin.email, guacId }, "admin: server created");
        await audit(prisma, {
          actor: { id: admin.id, label: admin.email },
          action: "server.created",
          target: { type: "server", id: server.id, label: server.name },
          details: {
            protocol: server.protocol,
            target: `${server.hostname}:${server.port}`,
            ratePerMinute: Number(server.ratePerMinute),
            access: server.openToAll ? "everyone" : `${input.userIds?.length ?? 0} user(s)`,
            active: server.active,
          },
        }, request.log);
        return reply.code(201).send({ server: await viewOf(prisma, { ...server, guacConnectionId: guacId }) });
      } catch (err) {
        return sendInputError(err, reply);
      }
    },
  );

  /** PATCH /api/admin/servers/:id — edit anything; running sessions keep their rate. */
  fastify.patch<{ Params: { id: string }; Body: ServerInput }>(
    "/api/admin/servers/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Update a server",
        description:
          "Partial update. Secrets: omitted = keep, null/\"\" = remove, string = replace. " +
          "`active: false` drains the server (no new sessions, running ones continue).",
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: serverInputProperties,
        },
        response: {
          200: { type: "object", required: ["server"], properties: { server: serverSchema } },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const admin = getAuthUser(request);
      const input = request.body;
      const current = await prisma.resource.findUnique({ where: { id: request.params.id } });
      if (current === null || current.archivedAt !== null) {
        return reply.code(404).send({ error: "server_not_found" });
      }
      const protocol = input.protocol ?? current.protocol;
      try {
        checkInput(input, protocol);
        const id = current.id;
        const server = await prisma.$transaction(async (tx) => {
          const updated = await tx.resource.update({
            where: { id },
            data: {
              ...(input.name !== undefined ? { name: input.name.trim() } : {}),
              ...(input.description !== undefined ? { description: emptyToNull(input.description) } : {}),
              ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
              ...(input.tier !== undefined ? { tier: input.tier } : {}),
              ...(input.hostname !== undefined ? { hostname: input.hostname.trim() } : {}),
              ...(input.port !== undefined ? { port: input.port } : {}),
              ...(input.username !== undefined ? { username: emptyToNull(input.username) } : {}),
              ...(input.password !== undefined ? { passwordEnc: sealed(input.password, id) } : {}),
              ...(input.privateKey !== undefined ? { privateKeyEnc: sealed(input.privateKey, id, true) } : {}),
              ...(input.passphrase !== undefined ? { passphraseEnc: sealed(input.passphrase, id) } : {}),
              // Keys are meaningless over RDP; switching protocol drops them.
              ...(protocol === "rdp" ? { privateKeyEnc: null, passphraseEnc: null } : {}),
              ...(input.settings !== undefined
                ? { settings: { ...readSettings(current.settings), ...input.settings } }
                : {}),
              ...(input.ratePerMinute !== undefined ? { ratePerMinute: input.ratePerMinute.toFixed(4) } : {}),
              ...(input.maxSessionMin !== undefined ? { maxSessionMin: input.maxSessionMin } : {}),
              ...(input.openToAll !== undefined ? { openToAll: input.openToAll } : {}),
              ...(input.active !== undefined ? { active: input.active } : {}),
            },
          });
          if (input.userIds !== undefined) await setAccess(tx, id, input.userIds, admin.email);
          return updated;
        });
        const guacId = await syncServer(prisma, server, request.log);
        request.log.info({ serverId: server.id, admin: admin.email, fields: Object.keys(input) }, "admin: server updated");
        await auditServerUpdate(prisma, { id: admin.id, label: admin.email }, current, server, input, request.log);
        return { server: await viewOf(prisma, { ...server, guacConnectionId: guacId ?? server.guacConnectionId }) };
      } catch (err) {
        return sendInputError(err, reply);
      }
    },
  );

  /**
   * DELETE /api/admin/servers/:id — ends its live sessions, then deletes it.
   * A server with billing history is archived instead (sessions reference
   * it): hidden everywhere, credentials wiped, name freed for reuse.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/api/admin/servers/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Delete a server",
        params: idParams,
        response: { 204: { type: "null" }, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const admin = getAuthUser(request);
      const server = await prisma.resource.findUnique({ where: { id: request.params.id } });
      if (server === null || server.archivedAt !== null) {
        return reply.code(404).send({ error: "server_not_found" });
      }

      if (server.guacConnectionId !== null) {
        await deleteConnection(server.guacConnectionId).catch((err: unknown) =>
          request.log.warn({ err: (err as Error).message }, "guacamole: delete failed (the next sync retries)"),
        );
      }
      const { archived, endedSessions } = await removeServer(prisma, server);
      await audit(prisma, {
        actor: { id: admin.id, label: admin.email },
        action: "server.deleted",
        severity: "warn",
        target: { type: "server", id: server.id, label: server.name },
        details: { archived, endedSessions },
      }, request.log);
      request.log.info({ serverId: server.id, admin: admin.email, archived }, "admin: server deleted");
      return reply.code(204).send();
    },
  );

  /** GET /api/admin/servers/:id/health — live health samples (last ~30 min). */
  fastify.get<{ Params: { id: string } }>(
    "/api/admin/servers/:id/health",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Server health",
        description:
          "CPU, memory, disk, network, load and uptime, sampled every 10 s while someone looks " +
          "(or a session is live), every 60 s otherwise. Needs monitoring on the server (ssh or exporter).",
        params: idParams,
        response: { 200: healthViewSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const server = await prisma.resource.findUnique({ where: { id: request.params.id } });
      if (server === null || server.archivedAt !== null) return reply.code(404).send({ error: "server_not_found" });
      return healthOf(server);
    },
  );

  /** POST /api/admin/servers/sync — run a two-way sync with Guacamole now. */
  fastify.post(
    "/api/admin/servers/sync",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Sync with Guacamole now",
        description:
          "Imports connections added/edited/deleted in the Guacamole UI and pushes portal changes. " +
          "Also runs every 30 s and on each server list.",
        response: {
          200: {
            type: "object",
            required: ["report"],
            properties: {
              report: {
                type: "object",
                properties: {
                  imported: { type: "integer" },
                  updatedFromGuacamole: { type: "integer" },
                  pushed: { type: "integer" },
                  removed: { type: "integer" },
                  skipped: { type: "integer" },
                },
              },
            },
          },
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return { report: await syncNow(prisma, request.log) };
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, "guacamole: manual sync failed");
        return reply.code(502).send({ error: "guacamole_unavailable" });
      }
    },
  );

  /**
   * POST /api/admin/servers/test — try a connection without saving.
   * With `id`, omitted fields (and secrets) fall back to the stored server,
   * so an admin can test an edit before saving it.
   */
  fastify.post<{ Body: ServerInput & { id?: string } }>(
    "/api/admin/servers/test",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Test a server connection",
        description:
          "Opens a real throwaway connection through Guacamole: checks reachability, protocol " +
          "and credentials. Nothing is saved or billed.",
        body: {
          type: "object",
          additionalProperties: false,
          properties: { ...serverInputProperties, id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            required: ["ok", "elapsedMs", "code"],
            properties: {
              ok: { type: "boolean" },
              elapsedMs: { type: "integer" },
              code: { type: "string" },
              guacStatus: { type: "integer" },
              message: { type: "string" },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const input = request.body;
      let stored: Resource | null = null;
      if (input.id !== undefined) {
        stored = await prisma.resource.findUnique({ where: { id: input.id } });
        if (stored === null || stored.archivedAt !== null) {
          return reply.code(404).send({ error: "server_not_found" });
        }
      }
      const protocol = input.protocol ?? stored?.protocol;
      const hostname = (input.hostname ?? stored?.hostname ?? "").trim();
      const port = input.port ?? stored?.port;
      if (protocol === undefined || hostname === "" || port === undefined) {
        return reply.code(400).send({ error: "target_incomplete" });
      }
      try {
        checkInput(input, protocol);
      } catch (err) {
        return sendInputError(err, reply);
      }

      const storedSecrets = stored !== null ? readSecrets(stored) : { password: null, privateKey: null, passphrase: null };
      const pick = (value: string | null | undefined, fallback: string | null) =>
        value === undefined ? fallback : value === null || value === "" ? null : value;

      const result = await probe({
        protocol,
        hostname,
        port,
        username: pick(input.username, stored?.username ?? null),
        settings: {
          ...readSettings(stored?.settings ?? {}),
          ...(input.settings ?? {}),
        },
        secrets: {
          password: pick(input.password, storedSecrets.password),
          privateKey: protocol === "ssh" ? pick(input.privateKey, storedSecrets.privateKey) : null,
          passphrase: protocol === "ssh" ? pick(input.passphrase, storedSecrets.passphrase) : null,
        },
      });
      request.log.info({ hostname, port, protocol, ok: result.ok, code: result.code }, "admin: connection test");
      return result;
    },
  );

  /** GET /api/admin/sessions — live sessions, or the most recent ones. */
  fastify.get<{ Querystring: { scope?: "live" | "recent"; limit?: number } }>(
    "/api/admin/sessions",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Org-wide sessions",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["live", "recent"], default: "recent" },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["sessions"],
            properties: { sessions: { type: "array", items: adminSessionSchema } },
          },
        },
      },
    },
    async (request) => {
      const live = request.query.scope === "live";
      const sessions = await prisma.session.findMany({
        where: live ? { status: { in: ["pending", "active"] } } : {},
        orderBy: { createdAt: "desc" },
        take: request.query.limit ?? 200,
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          resource: { select: { id: true, name: true, protocol: true, ratePerMinute: true } },
        },
      });
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          live: liveRegistry.has(s.id),
          recorded: s.recorded,
          ratePerMinute: Number(s.ratePerMinute ?? s.resource.ratePerMinute),
          holdAmount: Number(s.holdAmount),
          finalCharge: s.finalCharge === null ? null : Number(s.finalCharge),
          endReason: s.endReason,
          startedAt: s.startedAt?.toISOString() ?? null,
          endedAt: s.endedAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          user: s.user,
          resource: { id: s.resource.id, name: s.resource.name, protocol: s.resource.protocol },
        })),
      };
    },
  );

  /** POST /api/admin/sessions/:id/watch — one-time ticket to watch a live session read-only. */
  fastify.post<{ Params: { id: string } }>(
    "/api/admin/sessions/:id/watch",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Watch a live session (read-only)",
        description:
          "Returns a single-use ticket for GET /api/tunnel/watch. The user sees that an " +
          "administrator is watching; every watch is audited.",
        params: idParams,
        response: {
          201: {
            type: "object",
            required: ["tunnel"],
            properties: {
              tunnel: {
                type: "object",
                properties: { url: { type: "string" }, ticket: { type: "string" }, expiresAt: { type: "string" } },
              },
            },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const admin = getAuthUser(request);
      const session = await prisma.session.findUnique({ where: { id: request.params.id } });
      if (session === null) return reply.code(404).send({ error: "session_not_found" });
      if (session.status !== "active" || !liveRegistry.has(session.id)) {
        return reply.code(409).send({ error: "session_not_live" });
      }
      const { ticket, expiresAt } = issueTicket(session.id, admin.id, "watch");
      const base = process.env["TUNNEL_PUBLIC_URL"] ?? "ws://localhost:4000/api/tunnel";
      return reply.code(201).send({
        tunnel: { url: `${base.replace(/\/$/, "")}/watch`, ticket, expiresAt: expiresAt.toISOString() },
      });
    },
  );

  /** POST /api/admin/sessions/:id/terminate — force-end someone's session. */
  fastify.post<{ Params: { id: string } }>(
    "/api/admin/sessions/:id/terminate",
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ["admin"],
        summary: "Terminate a session",
        description: "Closes the remote display immediately and bills the time used.",
        params: idParams,
        response: { 204: { type: "null" }, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const admin = getAuthUser(request);
      const session = await prisma.session.findUnique({ where: { id: request.params.id } });
      if (session === null) return reply.code(404).send({ error: "session_not_found" });
      if (session.status !== "pending" && session.status !== "active") {
        return reply.code(409).send({ error: "session_not_live" });
      }
      revokeTickets(session.id);
      await endSession(prisma, session.id, "admin_terminated");
      request.log.info({ sessionId: session.id, admin: admin.email }, "admin: session terminated");
      const [who, where] = await Promise.all([
        prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } }),
        prisma.resource.findUnique({ where: { id: session.resourceId }, select: { name: true } }),
      ]);
      await audit(prisma, {
        actor: { id: admin.id, label: admin.email },
        action: "session.terminated",
        severity: "warn",
        target: { type: "session", id: session.id, label: `${who?.email ?? "?"} on ${where?.name ?? "?"}` },
      }, request.log);
      return reply.code(204).send();
    },
  );
}
