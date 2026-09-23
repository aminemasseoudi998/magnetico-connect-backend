import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Step 7 — real Guacamole JSON-auth signing.
 *
 * Implements the "Encrypted JSON authentication" scheme from the Apache
 * Guacamole manual (v1.5.5, gug/json-auth), byte-compatible with the
 * reference `doc/encrypt-json.sh`:
 *   1. JSON payload: { username, expires (unix ms), connections: { name: { protocol, parameters } } }
 *   2. Sign the UTF-8 JSON with HMAC/SHA-256 under the shared 128-bit key,
 *      prepend the 32-byte binary signature to the plaintext.
 *   3. Encrypt with AES-128-CBC, IV = 16 zero bytes (PKCS#7 padding).
 *   4. Base64-encode. The browser submits it as the `data` parameter
 *      (POST /api/tokens, or `?data=` on any Guacamole page URL).
 *
 * Key: 128 bits as 32 hex digits, shared with Guacamole via
 * `GUAC_JSON_AUTH_SECRET` here and `JSON_SECRET_KEY` on the guacamole
 * container (see infra/docker-compose.yml). Guards (protocol names,
 * per-connection parameters) are documented at each function.
 */

export const GUAC_TOKEN_TTL_MS = 60_000;

export type GuacProtocol = "ssh" | "rdp";

export type GuacPayload = {
  username: string;
  expires: number;
  connections: Record<string, { protocol: GuacProtocol; parameters: Record<string, string> }>;
};

/** Shared 128-bit key from `GUAC_JSON_AUTH_SECRET` (32 hex digits). */
export function getJsonSecretKey(): Buffer {
  const hex = (process.env["GUAC_JSON_AUTH_SECRET"] ?? "").trim();
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(
      "GUAC_JSON_AUTH_SECRET must be a 32-digit hex value (128-bit key). " +
        "Generate one, e.g. `node -e \"console.log(require('crypto').randomBytes(16).toString('hex'))\"`.",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Connection parameters (target host/port/credentials) for a Guacamole
 * connection id. Sourced from `GUAC_CONNECTION_PARAMS`, a JSON object mapping
 * guac_connection_id -> parameter map, e.g.
 * `{"1": {"hostname": "10.0.0.11", "port": "22", "username": "ops"}}`.
 *
 * TODO(secrets, step 14): per-resource credentials do NOT belong in env.
 * Move these into a secrets-backed store (Vault/KMS + restricted columns)
 * before any production traffic; env is transport for the PoC only.
 * TODO(admin): surface target host/port management in the admin console.
 */
export function getConnectionParams(connectionId: string): Record<string, string> {
  const raw = process.env["GUAC_CONNECTION_PARAMS"] ?? "{}";
  let map: unknown;
  try {
    map = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("GUAC_CONNECTION_PARAMS is not valid JSON");
  }
  if (typeof map !== "object" || map === null) {
    throw new Error("GUAC_CONNECTION_PARAMS must be a JSON object keyed by connection id");
  }
  const params = (map as Record<string, unknown>)[connectionId];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(
      `connection_unconfigured: no parameters for connection "${connectionId}" in GUAC_CONNECTION_PARAMS`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(
        `connection_unconfigured: parameter "${key}" for connection "${connectionId}" must be a string`,
      );
    }
    out[key] = value;
  }
  if (typeof out["hostname"] !== "string" || out["hostname"].length === 0) {
    throw new Error(
      `connection_unconfigured: connection "${connectionId}" needs at least a "hostname" parameter`,
    );
  }
  return out;
}

/**
 * Build the plaintext payload. `username` is the portal session id on
 * purpose: guacamole_connection_history then carries the session id, which is
 * exactly how the billing daemon (step 9) matches live connections back to
 * Portal `sessions` rows.
 */
export function buildGuacPayload(args: {
  sessionId: string;
  connectionName: string;
  protocol: GuacProtocol;
  parameters: Record<string, string>;
  nowMs?: number;
}): string {
  const now = args.nowMs ?? Date.now();
  const payload: GuacPayload = {
    username: args.sessionId,
    expires: now + GUAC_TOKEN_TTL_MS,
    connections: {
      [args.connectionName]: { protocol: args.protocol, parameters: args.parameters },
    },
  };
  return JSON.stringify(payload);
}

/** Sign + encrypt + base64-encode. Throws on invalid key length. */
export function signGuacToken(jsonPayload: string, key: Buffer): string {
  if (key.length !== 16) {
    throw new Error("JSON-auth key must be 128 bits (16 bytes)");
  }
  const plaintext = Buffer.from(jsonPayload, "utf8");
  const signature = createHmac("sha256", key).update(plaintext).digest();
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0));
  return Buffer.concat([
    cipher.update(Buffer.concat([signature, plaintext])),
    cipher.final(),
  ]).toString("base64");
}

/**
 * Reverse of signGuacToken — mirrors what guacamole-auth-json does server
 * side (decrypt, split 32-byte HMAC, verify, parse). Used by tests and the
 * step-7 verification script; never in the request path.
 */
export function verifyGuacToken(token: string, key: Buffer): GuacPayload {
  const encrypted = Buffer.from(token, "base64");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0));
  const signed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (signed.length < 33) {
    throw new Error("token too short to contain an HMAC-SHA256 signature");
  }
  const signature = signed.subarray(0, 32);
  const plaintext = signed.subarray(32);
  const expected = createHmac("sha256", key).update(plaintext).digest();
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid token signature");
  }
  return JSON.parse(plaintext.toString("utf8")) as GuacPayload;
}

/**
 * Client URL carrying the token as the `data` query parameter, per the
 * manual ("include it in the URL of any Guacamole page as a query parameter
 * named `data`"). `connectionName` is the connections-map key, so the link
 * opens straight into the session's connection.
 */
export function getGuacUrl(connectionName: string, token: string): string {
  const base = process.env["GUAC_BASE_URL"] ?? "http://localhost:8080/guacamole";
  return (
    `${base.replace(/\/$/, "")}/#/client/${encodeURIComponent(connectionName)}` +
    `?data=${encodeURIComponent(token)}`
  );
}

/**
 * Dev-only placeholder used when GUAC_JSON_AUTH_SECRET is unset (local work
 * without a Guacamole stack). Never returned once the secret is configured.
 * TODO(step 7 done): this stays only as the explicit secret-less fallback.
 */
export function signGuacTokenStub(args: {
  connectionId: string;
  userId: string;
  sessionId: string;
}): string {
  const payload = JSON.stringify({
    stub: true,
    connectionId: args.connectionId,
    userId: args.userId,
    sessionId: args.sessionId,
    exp: new Date(Date.now() + GUAC_TOKEN_TTL_MS).toISOString(),
  });
  return Buffer.from(payload, "utf8").toString("base64url") + ".stub";
}
