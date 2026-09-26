import { randomBytes } from "node:crypto";

/**
 * Step 7b — Guacamole JDBC provisioning (admin REST).
 *
 * Why this exists (step-10 finding): pure JSON-auth tunnels are invisible to
 * every Guacamole observability surface (`activeConnections` always `{}`,
 * empty history, no `guacamole_connection_history` rows — verified live
 * against 1.5.5), so the billing daemon cannot meter them. Per-session JDBC
 * users fix that with stock Guacamole semantics: the admin sees all tunnels,
 * owners see their own, kills and history work, and the daemon needs no
 * changes beyond user cleanup.
 *
 * Per portal session the backend:
 *   1. ensures a JDBC connection with the resource's name/protocol/params
 *      (find-or-create by name, PUT-refresh on every use),
 *   2. ensures a JDBC user named = portal session id with a fresh random
 *      password (recreate on conflict so passwords never go stale),
 *   3. grants that user READ on the one connection,
 *   4. logs in as the user -> authToken for the browser `?token=` handoff.
 * The daemon deletes the JDBC user after reconciling (see billing-daemon).
 *
 * Reference: `parentIdentifier` must be OMITTED for top-level connections —
 * sending `"ROOT"` fails with `invalid input syntax for type integer: ""`
 * on a fresh database (verified live).
 */

export class GuacAdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type GuacAdminConfig = {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  /** JDBC data source id, e.g. "postgresql". */
  dataSource: string;
};

export function guacAdminConfig(): GuacAdminConfig {
  return {
    baseUrl: (process.env["GUAC_BASE_URL"] ?? "http://localhost:8080/guacamole").replace(/\/$/, ""),
    adminUser: process.env["GUAC_ADMIN_USER"] ?? "guacadmin",
    adminPassword: process.env["GUAC_ADMIN_PASSWORD"] ?? "guacadmin",
    dataSource: process.env["GUAC_DATA_SOURCE"] ?? "postgresql",
  };
}

export function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function readJson(res: Response, what: string): Promise<unknown> {
  if (!res.ok) {
    throw new GuacAdminError(res.status, `Guacamole ${what} failed (${res.status})`);
  }
  return (await res.json()) as unknown;
}

/** Admin login -> auth token. Throws GuacAdminError (or fetch TypeError when down). */
export async function guacAdminLogin(cfg: GuacAdminConfig): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(cfg.adminUser)}&password=${encodeURIComponent(cfg.adminPassword)}`,
  });
  const body = (await readJson(res, "admin login")) as { authToken?: string };
  if (typeof body.authToken !== "string" || body.authToken.length === 0) {
    throw new GuacAdminError(res.status, "Guacamole admin login returned no token");
  }
  return body.authToken;
}

function authed(token: string): Record<string, string> {
  return { "Guacamole-Token": token };
}

export type GuacConnection = {
  identifier: string;
  name: string;
  protocol: string;
  parameters?: Record<string, string>;
};

/** Find-or-create by name; always PUT-refreshes parameters. Returns the numeric id. */
export async function ensureConnection(
  cfg: GuacAdminConfig,
  token: string,
  args: { name: string; protocol: "ssh" | "rdp"; parameters: Record<string, string> },
): Promise<string> {
  const base = `${cfg.baseUrl}/api/session/data/${encodeURIComponent(cfg.dataSource)}/connections`;
  const list = (await readJson(
    await fetch(base, { headers: authed(token) }),
    "list connections",
  )) as Record<string, GuacConnection>;
  const existing = Object.values(list).find((c) => c.name === args.name);

  const body = {
    name: args.name,
    protocol: args.protocol,
    parameters: args.parameters,
    attributes: {},
  };
  if (existing === undefined) {
    const created = (await readJson(
      await fetch(base, {
        method: "POST",
        headers: { ...authed(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "create connection",
    )) as GuacConnection;
    if (typeof created.identifier !== "string") {
      throw new GuacAdminError(500, "Guacamole create connection returned no identifier");
    }
    return created.identifier;
  }

  await readJson(
    await fetch(`${base}/${encodeURIComponent(existing.identifier)}`, {
      method: "PUT",
      headers: { ...authed(token), "content-type": "application/json" },
      body: JSON.stringify({ ...body, identifier: existing.identifier }),
    }),
    "update connection",
  );
  return existing.identifier;
}

/** Create-or-recreate so the password is always the one we just generated. */
export async function ensureSessionUser(
  cfg: GuacAdminConfig,
  token: string,
  username: string,
  password: string,
): Promise<void> {
  const base = `${cfg.baseUrl}/api/session/data/${encodeURIComponent(cfg.dataSource)}/users`;
  const create = () =>
    fetch(base, {
      method: "POST",
      headers: { ...authed(token), "content-type": "application/json" },
      body: JSON.stringify({ username, password, attributes: {} }),
    });
  let res = await create();
  if (!res.ok) {
    // Assume conflict with a previous incarnation (e.g. an earlier crashed
    // session): drop it and recreate so the password is known-good.
    await readJson(
      await fetch(`${base}/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: authed(token),
      }),
      "delete stale session user",
    );
    res = await create();
  }
  await readJson(res, "create session user");
}

/** Grant READ on one connection (idempotent: already-granted is not an error). */
export async function grantConnection(
  cfg: GuacAdminConfig,
  token: string,
  username: string,
  connectionId: string,
): Promise<void> {
  const res = await fetch(
    `${cfg.baseUrl}/api/session/data/${encodeURIComponent(cfg.dataSource)}/users/${encodeURIComponent(username)}/permissions`,
    {
      method: "PATCH",
      headers: { ...authed(token), "content-type": "application/json" },
      body: JSON.stringify([{ op: "add", path: `/connectionPermissions/${connectionId}`, value: "READ" }]),
    },
  );
  if (!res.ok && res.status !== 400) {
    throw new GuacAdminError(res.status, `Guacamole grant failed (${res.status})`);
  }
}

/** Log in as anyone (used for the session user) -> auth token for `?token=`. */
export async function loginAs(
  cfg: GuacAdminConfig,
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const body = (await readJson(res, "session login")) as { authToken?: string };
  if (typeof body.authToken !== "string" || body.authToken.length === 0) {
    throw new GuacAdminError(res.status, "Guacamole session login returned no token");
  }
  return body.authToken;
}
/** Best-effort removal (daemon calls this after reconciling). */
export async function deleteUser(
  cfg: GuacAdminConfig,
  token: string,
  username: string,
): Promise<void> {
  const res = await fetch(
    `${cfg.baseUrl}/api/session/data/${encodeURIComponent(cfg.dataSource)}/users/${encodeURIComponent(username)}`,
    { method: "DELETE", headers: authed(token) },
  );
  if (!res.ok && res.status !== 404) {
    throw new GuacAdminError(res.status, `Guacamole delete user failed (${res.status})`);
  }
}

/**
 * Browser handoff URL carrying a server-obtained auth token (`?token=` deep
 * link, verified live against 1.5.5). The browser never touches Guacamole
 * credentials and issues no cross-origin REST calls.
 */
export function clientUrl(cfg: GuacAdminConfig, connectionId: string, authToken: string): string {
  return (
    `${cfg.baseUrl}/#/client/${encodeURIComponent(connectionId)}` +
    `?token=${encodeURIComponent(authToken)}`
  );
}
