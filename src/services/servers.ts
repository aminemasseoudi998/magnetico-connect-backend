import type { Prisma, Resource } from "@prisma/client";
import { decryptSecret } from "./secrets.js";

/**
 * Remote servers ("resources"): the settings model, the Guacamole connection
 * parameters built from it, and the two API views — the full admin view and
 * the minimal user view that never reveals where a server lives.
 */

export const TIERS = ["standard", "accelerated", "dedicated"] as const;
export const SSH_COLOR_SCHEMES = ["gray-black", "black-white", "white-black", "green-black"] as const;
export const RDP_SECURITY_MODES = ["any", "nla", "tls", "rdp"] as const;
export const RDP_KEYBOARD_LAYOUTS = [
  "en-us-qwerty",
  "en-gb-qwerty",
  "fr-fr-azerty",
  "fr-be-azerty",
  "fr-ch-qwertz",
  "de-de-qwertz",
  "es-es-qwerty",
  "it-it-qwerty",
  "pt-br-qwerty",
] as const;

export const MONITORING_MODES = ["off", "ssh", "exporter"] as const;

/** Non-secret options stored in `resources.settings`. */
export type ServerSettings = {
  /** Remote → local clipboard. */
  clipboardCopy: boolean;
  /** Local → remote clipboard. */
  clipboardPaste: boolean;
  // SSH
  colorScheme: (typeof SSH_COLOR_SCHEMES)[number];
  fontSize: number;
  /** Pinned host key (known_hosts line). Empty = accept any key. */
  hostKey: string;
  // RDP
  security: (typeof RDP_SECURITY_MODES)[number];
  ignoreCert: boolean;
  domain: string;
  keyboardLayout: (typeof RDP_KEYBOARD_LAYOUTS)[number];
  /**
   * Record every session (screen, not keystrokes) through guacd; admins can
   * replay them from Admin → Sessions and Guacamole's History. Users are told.
   */
  recording: boolean;
  /**
   * Live server health (services/metrics.ts): "ssh" reads /proc over SSH with
   * this server's own credentials (Linux, nothing to install); "exporter"
   * scrapes a Prometheus node_exporter / windows_exporter URL.
   */
  monitoring: (typeof MONITORING_MODES)[number];
  /** http(s) URL of the exporter's /metrics, for monitoring = "exporter". */
  exporterUrl: string;
  /**
   * Guacamole parameters the portal has no field for (recording, SFTP,
   * wallpaper…), typically set by an admin in the Guacamole UI. Kept and sent
   * back untouched so two-way sync never wipes them.
   */
  extraParams: Record<string, string>;
};

export const DEFAULT_SETTINGS: ServerSettings = {
  clipboardCopy: true,
  clipboardPaste: true,
  colorScheme: "gray-black",
  fontSize: 12,
  hostKey: "",
  security: "any",
  ignoreCert: false,
  domain: "",
  keyboardLayout: "en-us-qwerty",
  recording: false,
  monitoring: "off",
  exporterUrl: "",
  extraParams: {},
};

/** JSON-schema for `settings` in request bodies (partial: omitted = keep/default). */
export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    clipboardCopy: { type: "boolean" },
    clipboardPaste: { type: "boolean" },
    colorScheme: { type: "string", enum: [...SSH_COLOR_SCHEMES] },
    fontSize: { type: "integer", minimum: 8, maximum: 32 },
    hostKey: { type: "string", maxLength: 4096 },
    security: { type: "string", enum: [...RDP_SECURITY_MODES] },
    ignoreCert: { type: "boolean" },
    domain: { type: "string", maxLength: 255 },
    keyboardLayout: { type: "string", enum: [...RDP_KEYBOARD_LAYOUTS] },
    recording: { type: "boolean" },
    monitoring: { type: "string", enum: [...MONITORING_MODES] },
    exporterUrl: { type: "string", maxLength: 2048 },
    extraParams: {
      type: "object",
      maxProperties: 100,
      additionalProperties: { type: "string", maxLength: 8192 },
    },
  },
} as const;

/** Stored JSON → complete settings (unknown keys dropped, gaps defaulted). */
export function readSettings(raw: Prisma.JsonValue): ServerSettings {
  const stored = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out: ServerSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ServerSettings)[]) {
    if (key === "extraParams") continue;
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  if (!(MONITORING_MODES as readonly string[]).includes(out.monitoring)) out.monitoring = "off";
  out.extraParams = readExtraParams((stored as Record<string, unknown>)["extraParams"]);
  return out;
}

/** Keeps only string-valued extra parameters (and never a managed one). */
function readExtraParams(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && !MANAGED_PARAMS.has(key)) out[key] = value;
  }
  return out;
}

/** The secrets a connection needs, already decrypted. */
export type ServerSecrets = {
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
};

export function readSecrets(server: Resource): ServerSecrets {
  const open = (sealed: string | null) => (sealed === null ? null : decryptSecret(sealed, server.id));
  return {
    password: open(server.passwordEnc),
    privateKey: open(server.privateKeyEnc),
    passphrase: open(server.passphraseEnc),
  };
}

export type ConnectionTarget = {
  protocol: "ssh" | "rdp";
  hostname: string;
  port: number;
  username: string | null;
  settings: ServerSettings;
  secrets: ServerSecrets;
};

/**
 * Guacamole connection parameters. Built server-side only and sent to
 * Guacamole (the mirrored connection, services/guacamole.ts) — never to the browser.
 */
export function guacParameters(target: ConnectionTarget): Record<string, string> {
  const { settings, secrets } = target;
  // Unmanaged parameters first; everything the portal manages overrides them.
  const params: Record<string, string> = {
    ...readExtraParams(settings.extraParams),
    hostname: target.hostname,
    port: String(target.port),
  };
  if (target.username) params["username"] = target.username;
  if (!settings.clipboardCopy) params["disable-copy"] = "true";
  if (!settings.clipboardPaste) params["disable-paste"] = "true";
  if (settings.recording) {
    // Guacamole fills the tokens per session (history-recording-storage
    // extension): one folder per session, named by its history UUID, which is
    // how both the Guacamole UI and the portal find the recording again.
    params["recording-path"] = "${HISTORY_PATH}/${HISTORY_UUID}";
    params["create-recording-path"] = "true";
  }

  if (target.protocol === "ssh") {
    if (secrets.password) params["password"] = secrets.password;
    if (secrets.privateKey) params["private-key"] = secrets.privateKey;
    if (secrets.passphrase) params["passphrase"] = secrets.passphrase;
    if (settings.hostKey.trim()) params["host-key"] = settings.hostKey.trim();
    params["color-scheme"] = settings.colorScheme;
    params["font-size"] = String(settings.fontSize);
    params["server-alive-interval"] = "30";
  } else {
    if (secrets.password) params["password"] = secrets.password;
    if (settings.domain.trim()) params["domain"] = settings.domain.trim();
    params["security"] = settings.security;
    if (settings.ignoreCert) params["ignore-cert"] = "true";
    params["server-layout"] = settings.keyboardLayout;
    // Follow the browser window: the remote desktop resizes with the viewer.
    params["resize-method"] = "display-update";
    params["enable-font-smoothing"] = "true";
  }
  return params;
}

/**
 * Parameters the portal owns (edited through its own fields). Anything else
 * on a Guacamole connection lands in `settings.extraParams`.
 */
const MANAGED_PARAMS = new Set([
  "hostname",
  "port",
  "username",
  "password",
  "private-key",
  "passphrase",
  "disable-copy",
  "disable-paste",
  "color-scheme",
  "font-size",
  "host-key",
  "server-alive-interval",
  "domain",
  "security",
  "ignore-cert",
  "server-layout",
  "resize-method",
  "enable-font-smoothing",
  "recording-path",
  "create-recording-path",
]);

const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T =>
  value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** A Guacamole connection read back into portal fields (two-way sync). */
export type FromGuacamole = {
  hostname: string;
  port: number;
  username: string | null;
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
  settings: ServerSettings;
};

/**
 * Guacamole connection parameters → portal server fields. `current` keeps
 * values Guacamole has no say in (e.g. the SSH colors of an RDP server).
 */
export function fromGuacamoleParameters(
  protocol: "ssh" | "rdp",
  params: Record<string, string>,
  current: ServerSettings = DEFAULT_SETTINGS,
): FromGuacamole {
  const port = Number(params["port"]);
  const text = (key: string) => (params[key] !== undefined && params[key] !== "" ? params[key]! : null);
  const extraParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!MANAGED_PARAMS.has(key)) extraParams[key] = value;
  }
  const fontSize = Number(params["font-size"]);
  return {
    hostname: (params["hostname"] ?? "").trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : protocol === "rdp" ? 3389 : 22,
    username: text("username"),
    password: text("password"),
    privateKey: protocol === "ssh" ? text("private-key") : null,
    passphrase: protocol === "ssh" ? text("passphrase") : null,
    settings: {
      ...current,
      clipboardCopy: params["disable-copy"] !== "true",
      clipboardPaste: params["disable-paste"] !== "true",
      recording: (params["recording-path"] ?? "") !== "",
      ...(protocol === "ssh"
        ? {
            colorScheme: oneOf(SSH_COLOR_SCHEMES, params["color-scheme"], current.colorScheme),
            fontSize: Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 32 ? fontSize : current.fontSize,
            hostKey: params["host-key"] ?? "",
          }
        : {
            security: oneOf(RDP_SECURITY_MODES, params["security"], "any"),
            ignoreCert: params["ignore-cert"] === "true",
            domain: params["domain"] ?? "",
            keyboardLayout: oneOf(RDP_KEYBOARD_LAYOUTS, params["server-layout"], current.keyboardLayout),
          }),
      extraParams,
    },
  };
}

export function targetOf(server: Resource): ConnectionTarget {
  return {
    protocol: server.protocol,
    hostname: server.hostname,
    port: server.port,
    username: server.username,
    settings: readSettings(server.settings),
    secrets: readSecrets(server),
  };
}

/** A server can take sessions only once an admin has pointed it somewhere. */
export function isConfigured(server: Pick<Resource, "hostname" | "port">): boolean {
  return server.hostname.trim().length > 0 && server.port > 0;
}

/* ------------------------------------------------------------ API views */

export type AdminServerStats = {
  entitledUsers: number;
  liveSessions: number;
  sessions30d: number;
  revenue30d: number;
};

export function adminView(server: Resource, stats: AdminServerStats) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    protocol: server.protocol,
    tier: server.tier,
    hostname: server.hostname,
    port: server.port,
    username: server.username,
    hasPassword: server.passwordEnc !== null,
    hasPrivateKey: server.privateKeyEnc !== null,
    hasPassphrase: server.passphraseEnc !== null,
    settings: readSettings(server.settings),
    ratePerMinute: Number(server.ratePerMinute),
    maxSessionMin: server.maxSessionMin,
    openToAll: server.openToAll,
    active: server.active,
    configured: isConfigured(server),
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
    stats,
  };
}

/** What a user sees: enough to choose and pay, nothing about the network. */
export function userView(server: Resource, entitlementCap: number | null) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    protocol: server.protocol,
    tier: server.tier,
    ratePerMinute: Number(server.ratePerMinute),
    maxSessionMin: minCap(server.maxSessionMin, entitlementCap),
    /** Sessions on this server are recorded — shown to the user before connecting. */
    recorded: readSettings(server.settings).recording,
  };
}

/** Tightest of two optional minute caps. */
export function minCap(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
