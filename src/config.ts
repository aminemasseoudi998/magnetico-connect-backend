/**
 * Env config, read per tick (loadConfig is a function, not a module constant)
 * so tests can point the daemon at a mock Guacamole + scratch DB by setting
 * process.env before importing the poller.
 */
export type DaemonConfig = {
  databaseUrl: string;
  guacBaseUrl: string;
  guacAdminUser: string;
  guacAdminPassword: string;
  dataSources: string[];
  pollIntervalMs: number;
  tokenGraceMs: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(): DaemonConfig {
  const dataSources = (process.env["GUAC_DATA_SOURCES"] ?? "postgresql,json")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (dataSources.length === 0) {
    throw new Error("GUAC_DATA_SOURCES must list at least one data source");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    guacBaseUrl: (process.env["GUAC_BASE_URL"] ?? "http://localhost:8080/guacamole").replace(
      /\/$/,
      "",
    ),
    guacAdminUser: process.env["GUAC_ADMIN_USER"] ?? "guacadmin",
    guacAdminPassword: process.env["GUAC_ADMIN_PASSWORD"] ?? "guacadmin",
    dataSources,
    pollIntervalMs: numberOr("POLL_INTERVAL_MS", 30_000),
    tokenGraceMs: numberOr("TOKEN_GRACE_MS", 120_000),
  };
}
