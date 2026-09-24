/**
 * Minimal Guacamole REST client (global fetch, no dependencies).
 *
 * Endpoints (against the webapp base, e.g. http://guacamole:8080/guacamole):
 *   POST /api/tokens                                            admin login
 *   GET  /api/session/data/{ds}/activeConnections                live tunnels
 *   PATCH /api/session/data/{ds}/activeConnections               kill (JSON Patch remove)
 *   GET  /api/session/data/{ds}/history/connections              audit history
 * Auth for data endpoints: `Guacamole-Token` header.
 */

export type GuacActiveConnection = {
  identifier: string;
  connectionIdentifier?: string;
  connectionName?: string;
  username: string;
  startDate: number;
  remoteHost?: string;
};

export type GuacHistoryEntry = {
  identifier: string;
  connectionIdentifier?: string;
  connectionName?: string;
  username: string;
  startDate: number;
  endDate: number | null;
};

export class GuacError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(res: Response, what: string): Promise<unknown> {
  if (!res.ok) {
    throw new GuacError(res.status, `Guacamole ${what} failed (${res.status})`);
  }
  return (await res.json()) as unknown;
}

/** POST /api/tokens with admin credentials -> auth token string. */
export async function guacLogin(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const body = (await readJson(res, "login")) as { authToken?: string };
  if (typeof body.authToken !== "string" || body.authToken.length === 0) {
    throw new GuacError(res.status, "Guacamole login returned no auth token");
  }
  return body.authToken;
}

function authed(token: string): Record<string, string> {
  return { "Guacamole-Token": token };
}

/** Map of active-connection id -> connection (empty object when idle). */
export async function listActiveConnections(
  baseUrl: string,
  token: string,
  dataSource: string,
): Promise<Record<string, GuacActiveConnection>> {
  const res = await fetch(
    `${baseUrl}/api/session/data/${encodeURIComponent(dataSource)}/activeConnections`,
    { headers: authed(token) },
  );
  return (await readJson(res, "activeConnections")) as Record<string, GuacActiveConnection>;
}

/** Kill one batch of active connections via JSON Patch `remove` ops. */
export async function killActiveConnections(
  baseUrl: string,
  token: string,
  dataSource: string,
  activeIds: string[],
): Promise<void> {
  if (activeIds.length === 0) return;
  const res = await fetch(
    `${baseUrl}/api/session/data/${encodeURIComponent(dataSource)}/activeConnections`,
    {
      method: "PATCH",
      headers: { ...authed(token), "content-type": "application/json" },
      body: JSON.stringify(activeIds.map((id) => ({ op: "remove", path: `/${id}` }))),
    },
  );
  if (!res.ok) {
    throw new GuacError(res.status, `Guacamole kill failed (${res.status})`);
  }
}

/** Full connection-history list; callers filter by username/connection. */
export async function listConnectionHistory(
  baseUrl: string,
  token: string,
  dataSource: string,
): Promise<GuacHistoryEntry[]> {
  const res = await fetch(
    `${baseUrl}/api/session/data/${encodeURIComponent(dataSource)}/history/connections`,
    { headers: authed(token) },
  );
  if (!res.ok) {
    throw new GuacError(res.status, `Guacamole history failed (${res.status})`);
  }
  // Idle systems answer with an empty body — treat any unparseable payload
  // as "no history" rather than a failed tick.
  let body: unknown = [];
  try {
    body = (await res.json()) as unknown;
  } catch {
    body = [];
  }
  return Array.isArray(body) ? (body as GuacHistoryEntry[]) : [];
}
