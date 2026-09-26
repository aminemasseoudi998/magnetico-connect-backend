import { loadConfig } from "./config.js";
import {
  closePool,
  getBalances,
  getPool,
  listOpenSessions,
  markActive,
  markKilled,
  reconcileSession,
} from "./db.js";
import { decideKills, type LiveSession } from "./enforcer.js";
import { accruedFor } from "./metering.js";
import {
  GuacError,
  deleteGuacUser,
  killActiveConnections,
  listActiveConnections,
  listConnectionHistory,
  guacLogin,
  type GuacActiveConnection,
  type GuacHistoryEntry,
} from "./guac.js";
import { planReconciliations } from "./reconciler.js";

export type TickSummary = {
  open: number;
  live: number;
  activated: number;
  killed: number;
  reconciled: number;
  errors: string[];
};

/**
 * Session ids ever observed live by THIS process. Lost on restart — the
 * token-grace rule on created_at covers cold starts (fresh tickets wait out
 * the grace window; older rows settle immediately).
 */
const seenActive = new Set<string>();

function stamp(): string {
  return new Date().toISOString();
}

/** One metering pass: match, activate, enforce, settle. Never throws. */
export async function tick(): Promise<TickSummary> {
  const summary: TickSummary = {
    open: 0,
    live: 0,
    activated: 0,
    killed: 0,
    reconciled: 0,
    errors: [],
  };
  const fail = (scope: string, err: unknown): null => {
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push(`${scope}: ${message}`);
    console.warn(`[billing] ${stamp()} ${scope}: ${message}`);
    return null;
  };

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail("config", err);
    return summary;
  }

  const db = getPool(config.databaseUrl);
  const open = (await listOpenSessions(db).catch((err) => fail("portal-db", err) ?? [])) ?? [];
  summary.open = open.length;
  if (open.length === 0) return summary;
  const byId = new Map(open.map((s) => [s.id, s]));

  // 1. Guacamole login + active connections across data sources (merge;
  //    a source that 404s is skipped — e.g. "json" when only JDBC exists).
  const token = await guacLogin(config.guacBaseUrl, config.guacAdminUser, config.guacAdminPassword).catch(
    (err) => fail("guac-login", err),
  );
  if (token === null) return summary;

  const liveBySession = new Map<string, { conn: GuacActiveConnection; dataSource: string }>();
  for (const ds of config.dataSources) {
    let listed: Record<string, GuacActiveConnection> | null = null;
    try {
      listed = await listActiveConnections(config.guacBaseUrl, token, ds);
    } catch (err) {
      if (err instanceof GuacError && err.status === 404) {
        console.warn(`[billing] ${stamp()} data source "${ds}" not present, skipping`);
        continue;
      }
      fail(`activeConnections/${ds}`, err);
      continue;
    }
    for (const [activeId, conn] of Object.entries(listed ?? {})) {
      if (typeof conn?.username !== "string" || !byId.has(conn.username)) continue;
      if (!liveBySession.has(conn.username)) {
        liveBySession.set(conn.username, { conn, dataSource: ds });
      }
    }
  }
  summary.live = liveBySession.size;

  // 2. pending -> active on first sighting (Guacamole startDate is authoritative).
  for (const [sessionId, { conn }] of liveBySession) {
    const row = byId.get(sessionId);
    if (row === undefined || row.status !== "pending") continue;
    const startedAt = new Date(Number.isFinite(conn.startDate) ? conn.startDate : Date.now());
    try {
      await markActive(db, sessionId, startedAt);
      summary.activated += 1;
    } catch (err) {
      fail(`activate/${sessionId}`, err);
    }
  }
  for (const sessionId of liveBySession.keys()) seenActive.add(sessionId);

  // 3. Enforcement: zero balance OR accrued past the hold (batched per
  //    data source, then marked killed).
  const live: LiveSession[] = [];
  for (const [sessionId, { conn, dataSource }] of liveBySession) {
    const row = byId.get(sessionId);
    if (row === undefined || (row.status !== "pending" && row.status !== "active")) continue;
    const parsed = row.started_at !== null ? Date.parse(row.started_at) : NaN;
    const startedMs = Number.isFinite(parsed)
      ? (parsed as number)
      : Number.isFinite(conn.startDate)
        ? conn.startDate
        : Date.now();
    live.push({
      session: row,
      activeId: conn.identifier,
      dataSource,
      startedMs,
      ratePerMinute: Number(row.rate_per_minute),
      holdAmount: Number(row.hold_amount),
    });
  }
  const userIds = [...new Set(live.map((l) => l.session.user_id))];
  const balances =
    (await getBalances(db, userIds).catch((err) => fail("balances", err))) ?? new Map();
  const nowMs = Date.now();
  const kills = decideKills(live, balances, nowMs);
  // Observable drain (step 10): accrued vs hold per live session, every tick.
  for (const item of live) {
    const killed = kills.some((k) => k.sessionId === item.session.id);
    console.warn(
      `[billing] ${stamp()} drain session=${item.session.id.slice(0, 8)} ` +
        `accrued=${accruedFor(item.ratePerMinute, item.startedMs, nowMs)} ` +
        `hold=${item.holdAmount} balance=${balances.get(item.session.user_id) ?? 0}` +
        (killed ? " KILL" : ""),
    );
  }
  const killsBySource = new Map<string, string[]>();
  for (const kill of kills) {
    const list = killsBySource.get(kill.dataSource) ?? [];
    list.push(kill.activeId);
    killsBySource.set(kill.dataSource, list);
  }
  const now = new Date();
  for (const [ds, activeIds] of killsBySource) {
    try {
      await killActiveConnections(config.guacBaseUrl, token, ds, activeIds);
    } catch (err) {
      fail(`kill/${ds}`, err);
      continue;
    }
  }
  const killedIds = kills.map((k) => k.sessionId);
  if (killedIds.length > 0) {
    for (const kill of kills) {
      console.warn(
        `[billing] ${stamp()} killed session ${kill.sessionId} ` +
          `(${kill.reason} accrued=${kill.accrued} balance=${kill.balance})`,
      );
    }
    try {
      await markKilled(db, killedIds, now);
      summary.killed = killedIds.length;
    } catch (err) {
      fail("mark-killed", err);
    }
  }

  // 4. Settle everything open-but-not-live (history preferred, portal fallback).
  let history: GuacHistoryEntry[] = [];
  for (const ds of config.dataSources) {
    try {
      const rows = await listConnectionHistory(config.guacBaseUrl, token, ds);
      history = history.concat(rows);
    } catch (err) {
      if (err instanceof GuacError && err.status === 404) continue;
      fail(`history/${ds}`, err);
    }
  }
  const plans = planReconciliations({
    open,
    activeSessionIds: new Set(liveBySession.keys()),
    seenActive,
    history,
    nowMs: Date.now(),
    tokenGraceMs: config.tokenGraceMs,
  });
  for (const plan of plans) {
    try {
      await reconcileSession(
        db,
        {
          sessionId: plan.session.id,
          userId: plan.session.user_id,
          endedAt: plan.endedAt,
          finalCharge: plan.finalCharge,
          historyRef: plan.historyRef,
        },
        Number(plan.session.hold_amount),
      );
      seenActive.delete(plan.session.id);
      summary.reconciled += 1;
      console.warn(
        `[billing] ${stamp()} reconciled session ${plan.session.id}: ` +
          `charge=${plan.finalCharge} hold=${plan.session.hold_amount} ` +
          `history=${plan.historyRef ?? "none"}`,
      );
      // Drop the per-session JDBC user (provisioned by POST /api/sessions).
      // Best-effort: a failed delete must not fail the tick, and the next
      // provision recreates on conflict anyway.
      try {
        await deleteGuacUser(config.guacBaseUrl, token, config.dataSources[0] as string, plan.session.id);
      } catch (err) {
        fail(`cleanup-user/${plan.session.id}`, err);
      }
    } catch (err) {
      fail(`reconcile/${plan.session.id}`, err);
    }
  }

  return summary;
}

export { closePool };
