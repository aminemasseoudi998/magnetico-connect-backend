import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for server credentials (passwords, SSH keys).
 *
 * AES-256-GCM with a random 96-bit IV per value. The server id is bound in as
 * additional authenticated data, so a ciphertext copied onto another row
 * fails to decrypt instead of silently logging into the wrong machine.
 *
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>` — the version prefix
 * leaves room for key rotation.
 *
 * Key: SERVER_CREDENTIALS_KEY, 32 bytes as 64 hex digits. Losing it makes
 * every stored credential unreadable (admins re-enter them); leaking it
 * together with a DB dump exposes them. Keep it out of the repo.
 * TODO(secrets, step 14): move the key into a KMS / Vault transit engine.
 */

const VERSION = "v1";

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey !== undefined) return cachedKey;
  const hex = (process.env["SERVER_CREDENTIALS_KEY"] ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "SERVER_CREDENTIALS_KEY must be 64 hex digits (256-bit key). Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`.",
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/** Fails fast at boot rather than at the first server save. */
export function assertSecretsConfigured(): void {
  key();
}

export function encryptSecret(plaintext: string, serverId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(serverId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(sealed: string, serverId: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(":");
  if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error("unsupported credential format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(serverId, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
