import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, Resource } from "@prisma/client";
import { Client, type ConnectConfig } from "ssh2";
import { audit } from "./audit.js";
import { liveRegistry } from "./live-sessions.js";
import { readSecrets, readSettings } from "./servers.js";

/**
 * Live server health: CPU, memory, disk, network, load, uptime.
 *
 * Two sources, per server (settings.monitoring):
 *   ssh      — agentless: one persistent SSH connection per server, using the
 *              server's own stored credentials, runs a read-only command that
 *              prints /proc counters. Linux targets; nothing to install.
 *   exporter — scrapes a Prometheus exporter's /metrics over HTTP:
 *              node_exporter (Linux) or windows_exporter (Windows / RDP).
 *
 * Samples are kept in memory (ring buffer per server). A server is polled
 * every 10 s while it has a live session or someone looked at its metrics in
 * the last 2 minutes, every 60 s otherwise.
 *
 * Alerts (written to the audit log, shown in the overview's Alerts panel):
 *   CPU or memory >= 90 % for 3 samples in a row  -> warn
 *   disk >= 90 % -> warn, >= 95 % -> crit
 *   3 failed readings in a row -> crit "unreachable"; the next success -> info "recovered"
 * Each (server, kind) alerts at most once per 30 minutes.
 */

export type HealthSample = {
  at: number;
  /** % of all cores busy since the previous sample (null on the first one). */
  cpuPct: number | null;
  load1: number | null;
  cores: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memUsedPct: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskUsedPct: number | null;
  /** Bytes per second since the previous sample. */
  netRxBps: number | null;
  netTxBps: number | null;
  uptimeSec: number | null;
};

/** Monotonic counters as read from the server; samples are derived from two. */
type Raw = {
  at: number;
  cpuTotal: number | null;
  cpuIdle: number | null;
  load1: number | null;
  cores: number | null;
  memTotal: number | null;
  memAvailable: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  netRx: number | null;
  netTx: number | null;
  uptimeSec: number | null;
};

type State = {
  samples: HealthSample[];
  last: Raw | null;
  lastError: string | null;
  lastAttempt: number;
  hotUntil: number;
  polling: boolean;
  source: string;
  failures: number;
  cpuHigh: number;
  memHigh: number;
  down: boolean;
  alertedAt: Map<string, number>;
};

const ALERT_COOLDOWN_MS = 30 * 60_000;
const HIGH = 90;
const DISK_CRIT = 95;
const STREAK = 3;
const MONITOR = { id: null, label: "Health monitor" };

const MAX_SAMPLES = 180;
const HOT_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 60_000;
const HOT_WINDOW_MS = 2 * 60_000;
const TIMEOUT_MS = 8_000;

const states = new Map<string, State>();

function stateOf(serverId: string, source: string): State {
  let s = states.get(serverId);
  if (s === undefined || s.source !== source) {
    s = {
      samples: [],
      last: null,
      lastError: null,
      lastAttempt: 0,
      hotUntil: 0,
      polling: false,
      source,
      failures: 0,
      cpuHigh: 0,
      memHigh: 0,
      down: false,
      alertedAt: new Map(),
    };
    states.set(serverId, s);
  }
  return s;
}

/* ------------------------------------------------------------ SSH source */

/** Read-only: prints kernel counters, touches nothing. */
const PROC_COMMAND = [
  "head -n1 /proc/stat",
  "echo ---",
  "cat /proc/loadavg",
  "echo ---",
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  "echo ---",
  "df -P -B1 / | tail -n1",
  "echo ---",
  "cat /proc/net/dev",
  "echo ---",
  "cat /proc/uptime",
  "echo ---",
  "nproc",
].join("; ");

type SshConn = { client: Client; ready: Promise<void>; alive: boolean; fingerprint: string };
const sshConns = new Map<string, SshConn>();

/** base64 key from a known_hosts line ("host type base64" or "type base64"). */
function pinnedKey(hostKey: string): string | null {
  const parts = hostKey.trim().split(/\s+/);
  const b64 = parts.find((p) => /^AAAA[0-9A-Za-z+/=]+$/.test(p));
  return b64 ?? null;
}

function sshConnection(server: Resource): SshConn {
  const settings = readSettings(server.settings);
  const fingerprint = `${server.hostname}:${server.port}:${server.username}:${server.updatedAt.getTime()}`;
  const existing = sshConns.get(server.id);
  if (existing && existing.alive && existing.fingerprint === fingerprint) return existing;
  if (existing) existing.client.end();

  const secrets = readSecrets(server);
  const pinned = pinnedKey(settings.hostKey);
  const config: ConnectConfig = {
    host: server.hostname,
    port: server.port,
    username: server.username ?? "",
    readyTimeout: TIMEOUT_MS,
    keepaliveInterval: 30_000,
    ...(secrets.privateKey ? { privateKey: secrets.privateKey } : {}),
    ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
    ...(secrets.password ? { password: secrets.password } : {}),
    // Same rule as sessions: a pinned host key must match.
    ...(pinned ? { hostVerifier: (key: Buffer) => key.toString("base64") === pinned } : {}),
  };
  const client = new Client();
  const conn: SshConn = {
    client,
    alive: true,
    fingerprint,
    ready: new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (err) => {
        conn.alive = false;
        reject(err);
      });
    }),
  };
  client.on("close", () => {
    conn.alive = false;
  });
  client.on("error", () => {
    conn.alive = false;
  });
  client.connect(config);
  sshConns.set(server.id, conn);
  return conn;
}

function execOnce(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("command timed out")), TIMEOUT_MS);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      let out = "";
      stream.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stream.stderr.on("data", () => undefined);
      stream.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  });
}

export function parseProc(output: string, at: number): Raw {
  const [stat = "", loadavg = "", meminfo = "", df = "", netdev = "", uptime = "", nproc = ""] = output
    .split(/^---$/m)
    .map((part) => part.trim());
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const cpu = stat.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  // user nice system idle iowait irq softirq steal …
  const cpuTotal = cpu.length >= 4 ? cpu.slice(0, 8).reduce((a, b) => a + b, 0) : null;
  const cpuIdle = cpu.length >= 5 ? cpu[3]! + cpu[4]! : cpu.length >= 4 ? cpu[3]! : null;

  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(meminfo);
    return m ? Number(m[1]) * 1024 : null;
  };

  const dfCols = df.split(/\s+/);
  let netRx = 0;
  let netTx = 0;
  let sawNet = false;
  for (const line of netdev.split("\n").slice(2)) {
    const [iface, rest] = line.split(":");
    if (!iface || rest === undefined || iface.trim() === "lo") continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    if (Number.isFinite(cols[0]) && Number.isFinite(cols[8])) {
      netRx += cols[0]!;
      netTx += cols[8]!;
      sawNet = true;
    }
  }

  return {
    at,
    cpuTotal,
    cpuIdle,
    load1: num(loadavg.split(/\s+/)[0]),
    cores: num(nproc),
    memTotal: kb("MemTotal"),
    memAvailable: kb("MemAvailable"),
    diskTotal: num(dfCols[1]),
    diskUsed: num(dfCols[2]),
    netRx: sawNet ? netRx : null,
    netTx: sawNet ? netTx : null,
    uptimeSec: num(uptime.split(/\s+/)[0]),
  };
}

async function readViaSsh(server: Resource): Promise<Raw> {
  const conn = sshConnection(server);
  await conn.ready;
  const output = await execOnce(conn.client, PROC_COMMAND);
  return parseProc(output, Date.now());
}

/* ------------------------------------------------------- exporter source */

type Series = { name: string; labels: Record<string, string>; value: number }[];

export function parsePrometheus(text: string): Series {
  const out: Series = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([^\s]+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1]!] = pair[2]!;
    }
    const value = Number(m[4]);
    if (Number.isFinite(value)) out.push({ name: m[1]!, labels, value });
  }
  return out;
}

export function rawFromExporter(series: Series, at: number): Raw {
  const all = (name: string, where: (l: Record<string, string>) => boolean = () => true) =>
    series.filter((s) => s.name === name && where(s.labels));
  const sum = (name: string, where?: (l: Record<string, string>) => boolean) => {
    const hits = all(name, where);
    return hits.length ? hits.reduce((a, s) => a + s.value, 0) : null;
  };
  const one = (name: string, where?: (l: Record<string, string>) => boolean) => all(name, where)[0]?.value ?? null;
  const first = (...values: (number | null)[]) => values.find((v) => v !== null) ?? null;
  const notLo = (l: Record<string, string>) => l["device"] !== "lo" && !(l["nic"] ?? "").toLowerCase().includes("loopback");

  const windows = series.some((s) => s.name.startsWith("windows_"));
  if (windows) {
    const memTotal = first(one("windows_memory_physical_total_bytes"), one("windows_cs_physical_memory_bytes"));
    const memFree = first(
      one("windows_memory_available_bytes"),
      one("windows_memory_physical_free_bytes"),
      one("windows_os_physical_memory_free_bytes"),
    );
    const disk = (l: Record<string, string>) => l["volume"] === "C:";
    const diskTotal = one("windows_logical_disk_size_bytes", disk);
    const diskFree = one("windows_logical_disk_free_bytes", disk);
    const boot = first(one("windows_system_boot_time_timestamp_seconds"), one("windows_system_system_up_time"));
    return {
      at,
      cpuTotal: sum("windows_cpu_time_total"),
      cpuIdle: sum("windows_cpu_time_total", (l) => l["mode"] === "idle"),
      load1: null,
      cores: first(one("windows_cs_logical_processors"), one("windows_cpu_logical_processor")),
      memTotal,
      memAvailable: memFree,
      diskTotal,
      diskUsed: diskTotal !== null && diskFree !== null ? diskTotal - diskFree : null,
      netRx: sum("windows_net_bytes_received_total", notLo),
      netTx: sum("windows_net_bytes_sent_total", notLo),
      uptimeSec: boot !== null ? Math.max(0, at / 1000 - boot) : null,
    };
  }

  const root = (l: Record<string, string>) => l["mountpoint"] === "/";
  const diskTotal = one("node_filesystem_size_bytes", root);
  const diskAvail = one("node_filesystem_avail_bytes", root);
  const cpus = new Set(all("node_cpu_seconds_total").map((s) => s.labels["cpu"]));
  const bootTime = one("node_boot_time_seconds");
  const now = one("node_time_seconds") ?? at / 1000;
  return {
    at,
    cpuTotal: sum("node_cpu_seconds_total"),
    cpuIdle: sum("node_cpu_seconds_total", (l) => l["mode"] === "idle" || l["mode"] === "iowait"),
    load1: one("node_load1"),
    cores: cpus.size || null,
    memTotal: one("node_memory_MemTotal_bytes"),
    memAvailable: one("node_memory_MemAvailable_bytes"),
    diskTotal,
    diskUsed: diskTotal !== null && diskAvail !== null ? diskTotal - diskAvail : null,
    netRx: sum("node_network_receive_bytes_total", notLo),
    netTx: sum("node_network_transmit_bytes_total", notLo),
    uptimeSec: bootTime !== null ? Math.max(0, now - bootTime) : null,
  };
}

async function readViaExporter(url: string): Promise<Raw> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("exporter URL must be http(s)");
  const res = await fetch(parsed, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`exporter answered ${res.status}`);
  return rawFromExporter(parsePrometheus(await res.text()), Date.now());
}

/* ----------------------------------------------------------- derive */

const pct = (part: number | null, whole: number | null) =>
  part === null || whole === null || whole <= 0 ? null : Math.round((part / whole) * 1000) / 10;

export function toSample(raw: Raw, prev: Raw | null): HealthSample {
  const dt = prev ? (raw.at - prev.at) / 1000 : 0;
  const delta = (a: number | null, b: number | null | undefined) => (a !== null && b !== null && b !== undefined ? a - b : null);
  const cpuTotalD = delta(raw.cpuTotal, prev?.cpuTotal);
  const cpuIdleD = delta(raw.cpuIdle, prev?.cpuIdle);
  const cpuPct =
    cpuTotalD !== null && cpuIdleD !== null && cpuTotalD > 0
      ? Math.max(0, Math.min(100, Math.round((1 - cpuIdleD / cpuTotalD) * 1000) / 10))
      : null;
  const rate = (d: number | null) => (d !== null && dt > 0 && d >= 0 ? Math.round(d / dt) : null);
  const memUsed = raw.memTotal !== null && raw.memAvailable !== null ? raw.memTotal - raw.memAvailable : null;
  return {
    at: raw.at,
    cpuPct,
    load1: raw.load1,
    cores: raw.cores,
    memUsed,
    memTotal: raw.memTotal,
    memUsedPct: pct(memUsed, raw.memTotal),
    diskUsed: raw.diskUsed,
    diskTotal: raw.diskTotal,
    diskUsedPct: pct(raw.diskUsed, raw.diskTotal),
    netRxBps: rate(delta(raw.netRx, prev?.netRx)),
    netTxBps: rate(delta(raw.netTx, prev?.netTx)),
    uptimeSec: raw.uptimeSec,
  };
}

/* ----------------------------------------------------------- collector */

function sourceOf(server: Resource): string {
  const s = readSettings(server.settings);
  return s.monitoring === "exporter" ? `exporter:${s.exporterUrl}` : s.monitoring;
}

/** Writes a health alert unless the same one fired in the last 30 minutes. */
async function alert(
  prisma: PrismaClient,
  server: Resource,
  state: State,
  kind: string,
  severity: "info" | "warn" | "crit",
  details: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<void> {
  const last = state.alertedAt.get(kind) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  state.alertedAt.set(kind, Date.now());
  await audit(prisma, {
    actor: MONITOR,
    action: `server.health_${kind}`,
    severity,
    target: { type: "server", id: server.id, label: server.name },
    details,
  }, log);
}

async function evaluate(prisma: PrismaClient, server: Resource, state: State, sample: HealthSample, log: FastifyBaseLogger) {
  if (state.down) {
    state.down = false;
    state.alertedAt.delete("unreachable");
    await alert(prisma, server, state, "recovered", "info", { after: `${state.failures} failed readings` }, log);
  }
  state.failures = 0;
  state.cpuHigh = sample.cpuPct !== null && sample.cpuPct >= HIGH ? state.cpuHigh + 1 : 0;
  state.memHigh = sample.memUsedPct !== null && sample.memUsedPct >= HIGH ? state.memHigh + 1 : 0;
  if (state.cpuHigh === STREAK) await alert(prisma, server, state, "cpu", "warn", { cpuPct: sample.cpuPct }, log);
  if (state.memHigh === STREAK) await alert(prisma, server, state, "memory", "warn", { memUsedPct: sample.memUsedPct }, log);
  if (sample.diskUsedPct !== null && sample.diskUsedPct >= HIGH) {
    await alert(prisma, server, state, "disk", sample.diskUsedPct >= DISK_CRIT ? "crit" : "warn", { diskUsedPct: sample.diskUsedPct }, log);
  }
}

async function poll(prisma: PrismaClient, server: Resource, state: State, log: FastifyBaseLogger): Promise<void> {
  state.polling = true;
  state.lastAttempt = Date.now();
  try {
    const settings = readSettings(server.settings);
    const raw =
      settings.monitoring === "ssh" ? await readViaSsh(server) : await readViaExporter(settings.exporterUrl);
    const sample = toSample(raw, state.last);
    state.samples.push(sample);
    if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
    state.last = raw;
    state.lastError = null;
    await evaluate(prisma, server, state, sample, log);
  } catch (err) {
    const message = (err as Error).message || "unreachable";
    if (state.lastError !== message) log.info({ server: server.name, err: message }, "metrics: collection failed");
    state.lastError = message;
    state.failures += 1;
    sshConns.get(server.id)?.client.end();
    sshConns.delete(server.id);
    if (state.failures === STREAK) {
      state.down = true;
      await alert(prisma, server, state, "unreachable", "crit", { error: message }, log);
    }
  } finally {
    state.polling = false;
  }
}

/** One collector tick: poll every monitored server that is due. */
async function tick(prisma: PrismaClient, log: FastifyBaseLogger): Promise<void> {
  const servers = await prisma.resource.findMany({ where: { archivedAt: null } });
  const now = Date.now();
  const busy = new Set(
    servers.filter((s) => liveRegistry.forResource(s.id).length > 0).map((s) => s.id),
  );
  const seen = new Set<string>();
  for (const server of servers) {
    const settings = readSettings(server.settings);
    if (settings.monitoring === "off" || server.hostname.trim() === "") continue;
    if (settings.monitoring === "ssh" && server.protocol !== "ssh") continue;
    if (settings.monitoring === "exporter" && !settings.exporterUrl) continue;
    seen.add(server.id);
    const state = stateOf(server.id, sourceOf(server));
    const hot = busy.has(server.id) || state.hotUntil > now;
    const interval = hot ? HOT_INTERVAL_MS : IDLE_INTERVAL_MS;
    if (!state.polling && now - state.lastAttempt >= interval) void poll(prisma, server, state, log);
  }
  // Monitoring switched off or server gone: drop state and connections.
  for (const id of [...states.keys()]) {
    if (!seen.has(id)) {
      states.delete(id);
      sshConns.get(id)?.client.end();
      sshConns.delete(id);
    }
  }
}

let timer: NodeJS.Timeout | undefined;

export function startMetrics(prisma: PrismaClient, log: FastifyBaseLogger): void {
  const run = () =>
    void tick(prisma, log).catch((err: unknown) => log.warn({ err: (err as Error).message }, "metrics: tick failed"));
  run();
  timer = setInterval(run, 5_000);
}

export function stopMetrics(): void {
  clearInterval(timer);
  for (const conn of sshConns.values()) conn.client.end();
  sshConns.clear();
}

export type HealthView = {
  mode: "off" | "ssh" | "exporter";
  samples: HealthSample[];
  latest: HealthSample | null;
  lastError: string | null;
};

/** Current view of one server; marks it "hot" so the next samples come fast. */
export function healthOf(server: Resource, limit = MAX_SAMPLES): HealthView {
  const settings = readSettings(server.settings);
  if (settings.monitoring === "off") return { mode: "off", samples: [], latest: null, lastError: null };
  const state = stateOf(server.id, sourceOf(server));
  state.hotUntil = Date.now() + HOT_WINDOW_MS;
  const samples = state.samples.slice(-limit);
  return { mode: settings.monitoring, samples, latest: samples[samples.length - 1] ?? null, lastError: state.lastError };
}

/** Latest sample only, without marking the server hot (lists). */
export function latestHealth(serverId: string): HealthSample | null {
  const state = states.get(serverId);
  return state?.samples[state.samples.length - 1] ?? null;
}

export type HealthStatus = "ok" | "warn" | "crit" | "down" | "unknown";

/** Compact status for the overview's fleet panel (no side effects). */
export function healthStatusOf(serverId: string): {
  status: HealthStatus;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  at: number | null;
  lastError: string | null;
} {
  const state = states.get(serverId);
  const latest = state?.samples[state.samples.length - 1] ?? null;
  const worst = Math.max(latest?.cpuPct ?? 0, latest?.memUsedPct ?? 0, latest?.diskUsedPct ?? 0);
  const status: HealthStatus =
    state?.down === true
      ? "down"
      : latest === null
        ? "unknown"
        : worst >= DISK_CRIT
          ? "crit"
          : worst >= 85
            ? "warn"
            : "ok";
  return {
    status,
    cpuPct: latest?.cpuPct ?? null,
    memUsedPct: latest?.memUsedPct ?? null,
    diskUsedPct: latest?.diskUsedPct ?? null,
    at: latest?.at ?? null,
    lastError: state?.lastError ?? null,
  };
}
