import { createHash, createHmac, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, Resource } from "@prisma/client";
import WebSocket from "ws";
import { audit, changedFields, SYSTEM } from "./audit.js";
import { encryptSecret } from "./secrets.js";
import { removeServer } from "./server-removal.js";
import {
  fromGuacamoleParameters,
  guacParameters,
  isConfigured,
  readSettings,
  targetOf,
  type ConnectionTarget,
} from "./servers.js";

/**
 * Backend ↔ Guacamole (database-backed, PostgreSQL auth).
 *
 * Servers and Guacamole connections are kept in TWO-WAY sync:
 *
 *   - Servers  ↔ Guacamole connections. Portal edits are pushed at once
 *                (portal servers live in the "Magnetico" group); a sync pass
 *                every 30 s — and on every Admin → Servers page load — pulls
 *                what admins added, edited or deleted in the Guacamole UI.
 *                See syncAll().
 *   - Users    → one Guacamole account per portal user (username = email),
 *                with a password derived from SERVER_CREDENTIALS_KEY that
 *                nobody is ever shown. It holds NO permission at rest: READ on
 *                a connection is granted when a portal session opens and
 *                removed when it ends. Guacamole's "Active sessions" and
 *                "History" therefore show who used what.
 *   - Sessions → the backend logs in as that user, opens the display
 *                WebSocket itself and proxies it (routes/tunnel.ts). The
 *                browser never receives a Guacamole token.
 *
 * All management calls use a dedicated service account (GUAC_SERVICE_USER),
 * created with the database (infra/guacamole-db/002-accounts.sh).
 *
 * GUAC_INTERNAL_URL — Guacamole as this process reaches it:
 *   backend on the host → http://127.0.0.1:8085/guacamole (default)
 *   backend in compose  → http://guacamole:8080/guacamole
 */

export const GROUP_NAME = "Magnetico";

export class GuacamoleUnavailableError extends Error {}

export class GuacamoleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function guacBaseUrl(): string {
  return (process.env["GUAC_INTERNAL_URL"] ?? "http://127.0.0.1:8085/guacamole").replace(/\/$/, "");
}

/** Where an admin's browser opens the Guacamole dashboard. */
export function guacDashboardUrl(): string {
  return (process.env["GUAC_DASHBOARD_URL"] ?? "http://localhost:8085/guacamole").replace(/\/$/, "");
}

function serviceCredentials(): { username: string; password: string } {
  const username = process.env["GUAC_SERVICE_USER"] ?? "";
  const password = process.env["GUAC_SERVICE_PASSWORD"] ?? "";
  if (username === "" || password === "") {
    throw new Error("GUAC_SERVICE_USER / GUAC_SERVICE_PASSWORD are not set (see infra/.env)");
  }
  return { username, password };
}

/** Fails fast at boot rather than at the first connection. */
export function assertGuacamoleConfigured(): void {
  serviceCredentials();
}

/* ------------------------------------------------------------ raw HTTP */

async function http(
  method: string,
  path: string,
  options: { token?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${guacBaseUrl()}${path}`);
  if (options.token) url.searchParams.set("token", options.token);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: options.form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : options.json !== undefined
          ? { "content-type": "application/json" }
          : {},
      body: options.form
        ? new URLSearchParams(options.form)
        : options.json !== undefined
          ? JSON.stringify(options.json)
          : undefined,
      // Generous: Guacamole's first call after it starts warms up its pool.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GuacamoleUnavailableError(`Guacamole unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON (HTML error page) — keep the text.
  }
  return { status: res.status, body };
}

function messageOf(body: unknown): string {
  return typeof body === "object" && body !== null && "message" in body
    ? String((body as { message: unknown }).message)
    : String(body).slice(0, 200);
}

/** Session token + data source for a username/password; null on bad credentials. */
async function login(username: string, password: string): Promise<{ token: string; dataSource: string } | null> {
  const res = await http("POST", "/api/tokens", { form: { username, password } });
  if (res.status === 403 || res.status === 401) return null;
  if (res.status !== 200) throw new GuacamoleApiError(res.status, messageOf(res.body));
  const body = res.body as { authToken: string; dataSource: string };
  return { token: body.authToken, dataSource: body.dataSource };
}

async function logout(token: string): Promise<void> {
  try {
    await http("DELETE", `/api/tokens/${encodeURIComponent(token)}`);
  } catch {
    // Guacamole expires idle sessions on its own.
  }
}

/* ------------------------------------------------------ service account */

let service: { token: string; dataSource: string; at: number } | null = null;
const SERVICE_TOKEN_MAX_AGE_MS = 20 * 60_000;

async function serviceSession(): Promise<{ token: string; dataSource: string }> {
  if (service !== null && Date.now() - service.at < SERVICE_TOKEN_MAX_AGE_MS) return service;
  const { username, password } = serviceCredentials();
  const session = await login(username, password);
  if (session === null) {
    throw new GuacamoleApiError(403, `Guacamole refused the service account "${username}" — check GUAC_SERVICE_* in backend/.env and infra/.env`);
  }
  if (service !== null) void logout(service.token);
  service = { ...session, at: Date.now() };
  return service;
}

/** Management call as the service account; re-logs in once on an expired token. */
async function admin(method: string, path: string, json?: unknown): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { token, dataSource } = await serviceSession();
    const res = await http(method, `/api/session/data/${dataSource}${path}`, {
      token,
      ...(json !== undefined ? { json } : {}),
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      service = null; // token expired or revoked — log in again
      continue;
    }
    return res;
  }
  throw new GuacamoleApiError(403, "Guacamole kept refusing the service account");
}

async function adminOk(method: string, path: string, json?: unknown): Promise<unknown> {
  const res = await admin(method, path, json);
  if (res.status >= 300) throw new GuacamoleApiError(res.status, messageOf(res.body));
  return res.body;
}

/* ------------------------------------------------------------- the group */

type TreeNode = {
  identifier: string;
  name: string;
  childConnections?: { identifier: string; name: string }[];
  childConnectionGroups?: TreeNode[];
};

let groupId: string | null = null;

/** The "Magnetico" connection group every portal server lives in. */
async function ensureGroup(): Promise<string> {
  if (groupId !== null) return groupId;
  const root = (await adminOk("GET", "/connectionGroups/ROOT/tree")) as TreeNode;
  const existing = root.childConnectionGroups?.find((g) => g.name === GROUP_NAME);
  if (existing) {
    groupId = existing.identifier;
    return groupId;
  }
  const created = (await adminOk("POST", "/connectionGroups", {
    parentIdentifier: "ROOT",
    name: GROUP_NAME,
    type: "ORGANIZATIONAL",
    attributes: {},
  })) as { identifier: string };
  groupId = created.identifier;
  return groupId;
}

/* ---------------------------------------------------------- connections */

/** Names of the admin "Test connection" throwaways — never imported. */
const PROBE_PREFIX = "connection test ";

type GuacConnection = { identifier: string; name: string; protocol: string; parentIdentifier: string };

type TreeConnection = { identifier: string; name: string; protocol?: string; parentIdentifier?: string };
type Tree = TreeNode & { childConnections?: TreeConnection[]; childConnectionGroups?: Tree[] };

/** Every connection in Guacamole, wherever it sits in the group tree. */
async function allConnections(): Promise<GuacConnection[]> {
  const root = (await adminOk("GET", "/connectionGroups/ROOT/tree")) as Tree;
  const out: GuacConnection[] = [];
  const walk = (node: Tree) => {
    for (const c of node.childConnections ?? []) {
      out.push({
        identifier: c.identifier,
        name: c.name,
        protocol: c.protocol ?? "",
        parentIdentifier: c.parentIdentifier ?? node.identifier,
      });
    }
    for (const g of node.childConnectionGroups ?? []) walk(g);
  };
  walk(root);
  return out;
}

async function connectionParameters(identifier: string): Promise<Record<string, string>> {
  return ((await adminOk("GET", `/connections/${identifier}/parameters`)) ?? {}) as Record<string, string>;
}

function connectionBody(parent: string, name: string, target: ConnectionTarget) {
  return {
    parentIdentifier: parent,
    name,
    protocol: target.protocol,
    parameters: guacParameters(target),
    attributes: { "max-connections": "", "max-connections-per-user": "" },
  };
}

/**
 * Identity of a connection's content: name, protocol and parameters. Stored
 * after every sync, it tells on the next pass which side changed since.
 */
function fingerprint(name: string, protocol: string, params: Record<string, string>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([name, protocol, entries])).digest("hex");
}

function desiredOf(server: Resource) {
  const target = targetOf(server);
  const params = guacParameters(target);
  return { target, fp: fingerprint(server.name, server.protocol, params) };
}

export async function deleteConnection(identifier: string): Promise<void> {
  const res = await admin("DELETE", `/connections/${identifier}`);
  if (res.status >= 300 && res.status !== 404) throw new GuacamoleApiError(res.status, messageOf(res.body));
}

/**
 * Portal → Guacamole: writes the server's connection (creating it in the
 * "Magnetico" group when missing, keeping its current group otherwise) and
 * records the id + fingerprint. Throws when Guacamole is unreachable.
 */
async function pushServer(prisma: PrismaClient, server: Resource, parent?: string): Promise<string> {
  const { target, fp } = desiredOf(server);
  let identifier = server.guacConnectionId;

  if (identifier !== null) {
    let where = parent;
    if (where === undefined) {
      const current = await admin("GET", `/connections/${identifier}`);
      where = current.status === 200 ? (current.body as { parentIdentifier: string }).parentIdentifier : undefined;
    }
    if (where !== undefined) {
      const res = await admin("PUT", `/connections/${identifier}`, {
        ...connectionBody(where, server.name, target),
        identifier,
      });
      if (res.status >= 300 && res.status !== 404) throw new GuacamoleApiError(res.status, messageOf(res.body));
      if (res.status === 404) identifier = null;
    } else {
      identifier = null;
    }
  }
  if (identifier === null) {
    const created = (await adminOk("POST", "/connections", connectionBody(await ensureGroup(), server.name, target))) as {
      identifier: string;
    };
    identifier = created.identifier;
  }
  await prisma.resource.update({
    where: { id: server.id },
    data: { guacConnectionId: identifier, guacFingerprint: fp },
  });
  return identifier;
}

/**
 * Pushes one server right after an admin saved it in the portal. Never
 * throws: a failed push is logged and redone by the next sync pass; the
 * tunnel also pushes just in time before a session.
 */
export async function syncServer(
  prisma: PrismaClient,
  server: Resource,
  log: FastifyBaseLogger,
): Promise<string | null> {
  try {
    if (!isConfigured(server) && server.guacConnectionId === null) return null;
    return await pushServer(prisma, server);
  } catch (err) {
    log.warn({ err: (err as Error).message, serverId: server.id }, "guacamole: push failed (will retry)");
    return null;
  }
}

/** Portal name for an imported connection: unique, ≤ 80 chars. */
async function freeName(prisma: PrismaClient, wanted: string, exceptId?: string): Promise<string> {
  const base = (wanted.trim() || "Guacamole connection").slice(0, 70);
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    const taken = await prisma.resource.findFirst({
      where: { name: candidate, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (taken === null) return candidate;
  }
  return `${base} ${randomUUID().slice(0, 6)}`;
}

function sealOrNull(value: string | null, serverId: string): string | null {
  return value === null ? null : encryptSecret(value, serverId);
}

export type SyncReport = {
  /** Connections added in Guacamole, now portal servers (drained). */
  imported: number;
  /** Servers updated from edits made in Guacamole. */
  updatedFromGuacamole: number;
  /** Servers written to Guacamole (portal edits, missing connections). */
  pushed: number;
  /** Servers removed because their connection was deleted in Guacamole. */
  removed: number;
  /** Connections left alone (protocol the portal does not support). */
  skipped: number;
};

/** Rate given to connections imported from Guacamole (MGC/min). */
function importRate(): string {
  const rate = Number(process.env["GUAC_IMPORT_RATE"] ?? 1);
  return (Number.isFinite(rate) && rate > 0 ? rate : 1).toFixed(4);
}

/**
 * Two-way sync between the portal's servers and Guacamole's connections.
 *
 * For each linked pair, the stored fingerprint (content as last synced)
 * tells what changed since:
 *   Guacamole changed → its values are imported into the portal
 *                       (secrets re-encrypted); Guacamole wins a tie.
 *   portal changed    → the portal's values are pushed to Guacamole.
 *   connection gone   → deleted in Guacamole → the server is removed.
 * Connections Guacamole has that the portal does not (added in the Guacamole
 * UI) are imported as new servers, **drained**: an admin sets the price and
 * access before users see them. Only SSH and RDP are imported.
 */
async function syncAll(prisma: PrismaClient, log: FastifyBaseLogger): Promise<SyncReport> {
  const report: SyncReport = { imported: 0, updatedFromGuacamole: 0, pushed: 0, removed: 0, skipped: 0 };
  const connections = await allConnections(); // throws if Guacamole is down: nothing is touched
  const byId = new Map(connections.map((c) => [c.identifier, c]));
  const linked = new Set<string>();

  // Deleted in the portal while Guacamole was unreachable: finish the job.
  const archived = await prisma.resource.findMany({
    where: { archivedAt: { not: null }, guacConnectionId: { not: null } },
  });
  for (const server of archived) {
    if (byId.has(server.guacConnectionId!)) await deleteConnection(server.guacConnectionId!);
    byId.delete(server.guacConnectionId!);
    await prisma.resource.update({ where: { id: server.id }, data: { guacConnectionId: null } });
  }

  const servers = await prisma.resource.findMany({ where: { archivedAt: null } });
  for (let server of servers) {
    const id = server.guacConnectionId;
    if (id === null) {
      if (isConfigured(server)) {
        await pushServer(prisma, server);
        report.pushed += 1;
      }
      continue;
    }
    linked.add(id);
    const conn = byId.get(id);

    if (conn === undefined) {
      if (server.guacFingerprint !== null) {
        // Existed in Guacamole, now gone: deleted there.
        const removed = await removeServer(prisma, server);
        report.removed += 1;
        await audit(prisma, {
          actor: SYSTEM.guacamole,
          action: "server.deleted_in_guacamole",
          severity: "warn",
          target: { type: "server", id: server.id, label: server.name },
          details: removed,
        }, log);
        log.info({ server: server.name }, "guacamole sync: server removed (deleted in Guacamole)");
      } else {
        await pushServer(prisma, server);
        report.pushed += 1;
      }
      continue;
    }

    if (conn.protocol !== "ssh" && conn.protocol !== "rdp") {
      report.skipped += 1;
      continue;
    }
    const params = await connectionParameters(id);
    const guacFp = fingerprint(conn.name, conn.protocol, params);

    if (server.guacFingerprint !== null && guacFp !== server.guacFingerprint) {
      // Edited in Guacamole → bring it into the portal.
      const parsed = fromGuacamoleParameters(conn.protocol, params, readSettings(server.settings));
      const before = server;
      server = await prisma.resource.update({
        where: { id: server.id },
        data: {
          name: await freeName(prisma, conn.name, server.id),
          protocol: conn.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          username: parsed.username,
          passwordEnc: sealOrNull(parsed.password, server.id),
          privateKeyEnc: sealOrNull(parsed.privateKey, server.id),
          passphraseEnc: sealOrNull(parsed.passphrase, server.id),
          settings: parsed.settings,
          guacFingerprint: guacFp,
        },
      });
      report.updatedFromGuacamole += 1;
      log.info({ server: server.name }, "guacamole sync: server updated from Guacamole");
      const changes: Record<string, unknown> = changedFields(
        before as unknown as Record<string, unknown>,
        server as unknown as Record<string, unknown>,
        ["name", "protocol", "hostname", "port", "username"],
      );
      for (const [key, col] of [["password", "passwordEnc"], ["privateKey", "privateKeyEnc"], ["passphrase", "passphraseEnc"]] as const) {
        const had = before[col] !== null;
        const has = server[col] !== null;
        // Ciphertexts differ on every write; compare presence, and flag a
        // possible change when both sides have one.
        if (had !== has) changes[key] = has ? "set" : "removed";
      }
      await audit(prisma, {
        actor: SYSTEM.guacamole,
        action: "server.updated_in_guacamole",
        target: { type: "server", id: server.id, label: server.name },
        details: changes,
      }, log);
    }

    const desired = desiredOf(server);
    if (desired.fp !== guacFp) {
      await pushServer(prisma, server, conn.parentIdentifier);
      report.pushed += 1;
    } else if (server.guacFingerprint !== guacFp) {
      await prisma.resource.update({ where: { id: server.id }, data: { guacFingerprint: guacFp } });
    }
  }

  // Added in Guacamole → new portal servers.
  for (const conn of byId.values()) {
    if (linked.has(conn.identifier) || conn.name.startsWith(PROBE_PREFIX)) continue;
    if (conn.protocol !== "ssh" && conn.protocol !== "rdp") {
      report.skipped += 1;
      continue;
    }
    const params = await connectionParameters(conn.identifier);
    const parsed = fromGuacamoleParameters(conn.protocol, params);
    const id = randomUUID();
    const created = await prisma.resource.create({
      data: {
        id,
        name: await freeName(prisma, conn.name),
        description: "Imported from Guacamole — set the price and access, then put it in service",
        protocol: conn.protocol,
        tier: "standard",
        hostname: parsed.hostname,
        port: parsed.port,
        username: parsed.username,
        passwordEnc: sealOrNull(parsed.password, id),
        privateKeyEnc: sealOrNull(parsed.privateKey, id),
        passphraseEnc: sealOrNull(parsed.passphrase, id),
        settings: parsed.settings,
        ratePerMinute: importRate(),
        openToAll: false,
        active: false,
        guacImported: true,
        guacConnectionId: conn.identifier,
        guacFingerprint: fingerprint(conn.name, conn.protocol, params),
      },
    });
    report.imported += 1;
    log.info({ connection: conn.name, server: created.name }, "guacamole sync: imported new connection");
    await audit(prisma, {
      actor: SYSTEM.guacamole,
      action: "server.imported_from_guacamole",
      target: { type: "server", id: created.id, label: created.name },
      details: { protocol: created.protocol, target: `${created.hostname}:${created.port}`, status: "drained" },
    }, log);
    // Normalise the connection to what the portal would write (defaults,
    // name if it had to be made unique), keeping its group.
    if (desiredOf(created).fp !== created.guacFingerprint) {
      await pushServer(prisma, created, conn.parentIdentifier);
    }
  }

  return report;
}

let running: Promise<SyncReport> | null = null;
let lastRun = 0;

/** One sync at a time; concurrent callers share the pass in flight. */
export function syncNow(prisma: PrismaClient, log: FastifyBaseLogger): Promise<SyncReport> {
  if (running !== null) return running;
  running = syncAll(prisma, log).finally(() => {
    running = null;
    lastRun = Date.now();
  });
  return running;
}

/** A fresh pass unless one finished within `maxAgeMs` (page loads). */
export async function syncIfStale(prisma: PrismaClient, log: FastifyBaseLogger, maxAgeMs = 5_000): Promise<void> {
  if (running === null && Date.now() - lastRun < maxAgeMs) return;
  await syncNow(prisma, log);
}

/* ---------------------------------------------------- per-user accounts */

export type PortalIdentity = { id: string; email: string; displayName: string };

function usernameOf(user: PortalIdentity): string {
  return user.email.trim().toLowerCase();
}

/** Deterministic, never stored, never shown: HMAC of the portal user id. */
function passwordOf(user: PortalIdentity): string {
  const key = Buffer.from(process.env["SERVER_CREDENTIALS_KEY"] ?? "", "hex");
  return createHmac("sha256", key).update(`guacamole-user:${user.id}`).digest("base64url");
}

async function putUser(user: PortalIdentity, create: boolean): Promise<void> {
  const body = {
    username: usernameOf(user),
    password: passwordOf(user),
    attributes: { "guac-full-name": user.displayName, "guac-email-address": user.email, disabled: "", expired: "" },
  };
  const res = create
    ? await admin("POST", "/users", body)
    : await admin("PUT", `/users/${encodeURIComponent(usernameOf(user))}`, body);
  const exists = res.status === 400 && /already exists/i.test(messageOf(res.body));
  if (res.status >= 300 && !exists) throw new GuacamoleApiError(res.status, messageOf(res.body));
}

async function setConnectionPermission(user: PortalIdentity, connectionId: string, op: "add" | "remove") {
  await adminOk("PATCH", `/users/${encodeURIComponent(usernameOf(user))}/permissions`, [
    { op, path: `/connectionPermissions/${connectionId}`, value: "READ" },
  ]);
}

export type UserGrant = {
  user: PortalIdentity;
  connectionId: string;
  token: string;
  dataSource: string;
};

/**
 * Just-in-time access for one portal session: make sure the user's
 * Guacamole account exists, grant READ on this one connection, and log in
 * as them. Undo with closeUserGrant().
 */
export async function openUserGrant(user: PortalIdentity, connectionId: string): Promise<UserGrant> {
  await putUser(user, true);
  await setConnectionPermission(user, connectionId, "add");
  let session = await login(usernameOf(user), passwordOf(user));
  if (session === null) {
    // Password changed by hand in the Guacamole UI — put ours back.
    await putUser(user, false);
    session = await login(usernameOf(user), passwordOf(user));
  }
  if (session === null) {
    await setConnectionPermission(user, connectionId, "remove").catch(() => undefined);
    throw new GuacamoleApiError(403, `Guacamole refused the account for ${usernameOf(user)}`);
  }
  return { user, connectionId, token: session.token, dataSource: session.dataSource };
}

/** Ends the Guacamole session and withdraws the permission. Best effort. */
export async function closeUserGrant(grant: UserGrant): Promise<void> {
  await logout(grant.token);
  await setConnectionPermission(grant.user, grant.connectionId, "remove").catch(() => undefined);
}

/* ------------------------------------------------------ live watching */

/** Read-only sharing profile added to every portal connection (admin "Watch"). */
export const MONITOR_PROFILE = "Magnetico monitor (read-only)";

const monitorProfiles = new Map<string, string>();

type TreeWithProfiles = {
  identifier: string;
  childConnections?: { identifier: string; sharingProfiles?: { identifier: string; name: string }[] }[];
  childConnectionGroups?: TreeWithProfiles[];
};

/** The connection's read-only sharing profile id, created on first use. */
async function ensureMonitorProfile(connectionId: string): Promise<string> {
  const cached = monitorProfiles.get(connectionId);
  if (cached !== undefined) return cached;
  const root = (await adminOk("GET", "/connectionGroups/ROOT/tree")) as TreeWithProfiles;
  const find = (node: TreeWithProfiles): string | undefined => {
    for (const c of node.childConnections ?? []) {
      if (c.identifier === connectionId) return c.sharingProfiles?.find((p) => p.name === MONITOR_PROFILE)?.identifier;
    }
    for (const g of node.childConnectionGroups ?? []) {
      const hit = find(g);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  let id = find(root);
  if (id === undefined) {
    const created = (await adminOk("POST", "/sharingProfiles", {
      primaryConnectionIdentifier: connectionId,
      name: MONITOR_PROFILE,
      // Enforced by guacd: the watcher's keyboard, mouse and clipboard are ignored.
      parameters: { "read-only": "true" },
      attributes: {},
    })) as { identifier: string };
    id = created.identifier;
  }
  monitorProfiles.set(connectionId, id);
  return id;
}

export type WatchGrant = { token: string; dataSource: string; connectionId: string };

/**
 * Joins a user's live connection read-only: finds their active Guacamole
 * connection, asks Guacamole for a share key on the monitor profile and logs
 * in with it. guacd sends the joiner the full current screen, so watching can
 * start mid-session. Close with closeWatchGrant().
 */
export async function openWatchGrant(user: { email: string }, connectionId: string): Promise<WatchGrant> {
  const profile = await ensureMonitorProfile(connectionId);
  const username = user.email.trim().toLowerCase();
  const active = (await adminOk("GET", "/activeConnections")) as Record<
    string,
    { identifier: string; connectionIdentifier: string; username: string; startDate: number }
  >;
  const mine = Object.values(active ?? {})
    .filter((a) => a.connectionIdentifier === connectionId && a.username === username)
    .sort((a, b) => b.startDate - a.startDate)[0];
  if (mine === undefined) throw new GuacamoleApiError(404, "the user has no active Guacamole connection");

  const credentials = (await adminOk(
    "GET",
    `/activeConnections/${encodeURIComponent(mine.identifier)}/sharingCredentials/${profile}`,
  )) as { values?: Record<string, string> };
  const values = credentials.values ?? {};
  const key = values["key"];
  if (!key) throw new GuacamoleApiError(502, "Guacamole returned no share key");

  const res = await http("POST", "/api/tokens", { form: values });
  if (res.status !== 200) throw new GuacamoleApiError(res.status, messageOf(res.body));
  const body = res.body as { authToken: string; dataSource: string };
  // A shared connection is addressed by its share key.
  return { token: body.authToken, dataSource: body.dataSource, connectionId: key };
}

export async function closeWatchGrant(grant: WatchGrant): Promise<void> {
  await logout(grant.token);
}

/* -------------------------------------------------------------- history */

export type HistoryEntry = {
  uuid: string | null;
  username: string;
  connectionIdentifier: string;
  startDate: number;
  endDate: number | null;
};

/** Guacamole's connection history for one Guacamole username, newest first. */
export async function connectionHistory(username: string): Promise<HistoryEntry[]> {
  const rows = (await adminOk(
    "GET",
    `/history/connections?contains=${encodeURIComponent(username)}&order=-startDate`,
  )) as {
    uuid?: string;
    identifier?: string;
    username: string;
    connectionIdentifier: string;
    startDate: number;
    endDate?: number | null;
  }[];
  return (rows ?? []).map((r) => ({
    uuid: r.uuid ?? r.identifier ?? null,
    username: r.username,
    connectionIdentifier: r.connectionIdentifier,
    startDate: r.startDate,
    endDate: r.endDate ?? null,
  }));
}

/* ------------------------------------------------------ connection test */

export type ProbeResult = {
  ok: boolean;
  elapsedMs: number;
  code: string;
  guacStatus?: number;
  message?: string;
};

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONFIRM_MS = 3_000;

/**
 * Opens a real throwaway connection (a temporary Guacamole connection, used
 * by the service account, deleted afterwards): reachability, protocol and
 * credentials in one check.
 */
export async function probe(target: ConnectionTarget): Promise<ProbeResult> {
  const started = Date.now();
  let connectionId: string | null = null;
  try {
    const parent = await ensureGroup();
    const created = (await adminOk(
      "POST",
      "/connections",
      connectionBody(parent, `connection test ${randomUUID().slice(0, 8)}`, target),
    )) as { identifier: string };
    connectionId = created.identifier;
    const { token, dataSource } = await serviceSession();
    const ws = openTunnel({ token, dataSource, connectionId }, { width: 1024, height: 768, dpi: 96, images: [], audio: [] });

    const outcome = await new Promise<Omit<ProbeResult, "elapsedMs">>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, code: "timeout" }), PROBE_TIMEOUT_MS);
      let confirm: NodeJS.Timeout | undefined;
      const done = (r: Omit<ProbeResult, "elapsedMs">) => {
        clearTimeout(timer);
        clearTimeout(confirm);
        resolve(r);
      };
      ws.on("message", (data) => {
        const frame = data.toString();
        const error = findError(frame);
        if (error !== null) return done({ ok: false, code: "remote_error", guacStatus: error.code, message: error.message });
        // guacd asking for credentials = the configured ones were not enough.
        if (hasOpcode(frame, "required")) return done({ ok: false, code: "credentials_required" });
        if (hasOpcode(frame, "disconnect")) return done({ ok: false, code: "closed" });
        if (confirm === undefined && hasOpcode(frame, "sync")) {
          confirm = setTimeout(() => done({ ok: true, code: "connected" }), PROBE_CONFIRM_MS);
        }
      });
      ws.on("error", (err) => done({ ok: false, code: "gateway_unavailable", message: err.message }));
      ws.on("close", () => done({ ok: false, code: "closed" }));
    });
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    return { ...outcome, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      code: err instanceof GuacamoleUnavailableError ? "gateway_unavailable" : "probe_failed",
      message: (err as Error).message,
    };
  } finally {
    if (connectionId !== null) await deleteConnection(connectionId).catch(() => undefined);
  }
}

/* -------------------------------------------------------------- display */

export type DisplayOptions = {
  width: number;
  height: number;
  dpi: number;
  timezone?: string;
  images: string[];
  audio: string[];
};

/** Opens the display stream (subprotocol "guacamole") for a session token. */
export function openTunnel(
  session: { token: string; dataSource: string; connectionId: string },
  display: DisplayOptions,
): WebSocket {
  const query = new URLSearchParams({
    token: session.token,
    GUAC_DATA_SOURCE: session.dataSource,
    GUAC_ID: session.connectionId,
    GUAC_TYPE: "c",
    GUAC_WIDTH: String(display.width),
    GUAC_HEIGHT: String(display.height),
    GUAC_DPI: String(display.dpi),
  });
  if (display.timezone) query.set("GUAC_TIMEZONE", display.timezone);
  for (const image of display.images) query.append("GUAC_IMAGE", image);
  for (const audio of display.audio) query.append("GUAC_AUDIO", audio);

  const url = `${guacBaseUrl().replace(/^http/, "ws")}/websocket-tunnel?${query.toString()}`;
  return new WebSocket(url, "guacamole", { handshakeTimeout: 10_000 });
}

/* ------------------------------------------------- protocol helpers */

/** Encodes one Guacamole instruction (`len.value,len.value;`). */
export function instruction(opcode: string, ...args: string[]): string {
  return [opcode, ...args].map((part) => `${[...part].length}.${part}`).join(",") + ";";
}

/** Guacamole status codes the portal sends or interprets. */
export const GUAC_STATUS = {
  SERVER_ERROR: 0x0200,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_CLOSED: 0x020b,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
} as const;

/**
 * Parses a frame of complete Guacamole instructions into [opcode, ...args].
 * Element lengths count Unicode code points, so values may safely contain
 * `,` or `;`. Stops at the first malformed element rather than throwing.
 */
export function parseInstructions(frame: string): string[][] {
  const chars = [...frame];
  const out: string[][] = [];
  let current: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let len = 0;
    let digits = 0;
    while (i < chars.length && chars[i]! >= "0" && chars[i]! <= "9") {
      len = len * 10 + Number(chars[i]);
      i += 1;
      digits += 1;
    }
    if (digits === 0 || chars[i] !== ".") break;
    i += 1;
    current.push(chars.slice(i, i + len).join(""));
    i += len;
    const terminator = chars[i];
    i += 1;
    if (terminator === ";") {
      out.push(current);
      current = [];
    } else if (terminator !== ",") {
      break;
    }
  }
  return out;
}

/** First `error` instruction in a frame, if any. Cheap pre-check first. */
export function findError(frame: string): { message: string; code: number } | null {
  if (!frame.includes("5.error,")) return null;
  const hit = parseInstructions(frame).find((ins) => ins[0] === "error");
  if (hit === undefined) return null;
  return { message: hit[1] ?? "", code: Number(hit[2] ?? GUAC_STATUS.SERVER_ERROR) };
}

/** Whether a frame contains an instruction with this opcode. */
export function hasOpcode(frame: string, opcode: string): boolean {
  const needle = `${opcode.length}.${opcode}`;
  if (!frame.includes(needle)) return false;
  return parseInstructions(frame).some((ins) => ins[0] === opcode);
}
