import type { PrismaClient } from "@prisma/client";
import { liveRegistry } from "./live-sessions.js";
import { healthStatusOf } from "./metrics.js";
import { readSettings } from "./servers.js";

/**
 * Admin overview analytics, computed from real rows (sessions, ledger,
 * resources) for a time range and the previous range of the same length.
 *
 * Money is attributed to the moment it was billed (session end); connected
 * time is split across the buckets it actually overlapped. Buckets are the
 * admin's local hours (24h range) or days (longer ranges).
 */

export const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type RangeKey = keyof typeof RANGES;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TIERS = ["standard", "accelerated", "dedicated"] as const;
type Tier = (typeof TIERS)[number];

const OUTCOMES = {
  completed: ["user_closed", "server_closed"],
  out_of_credit: ["balance_exhausted"],
  time_limit: ["time_limit"],
  terminated: ["admin_terminated", "account_suspended", "server_removed"],
  interrupted: ["interrupted"],
  failed: ["connection_failed"],
  abandoned: ["never_connected"],
} as const;
type Outcome = keyof typeof OUTCOMES;

const DURATION_BUCKETS = [
  { label: "< 1 min", max: 60 },
  { label: "1–5 min", max: 300 },
  { label: "5–15 min", max: 900 },
  { label: "15–30 min", max: 1800 },
  { label: "30–60 min", max: 3600 },
  { label: "1–2 h", max: 7200 },
  { label: "2 h +", max: Infinity },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

type Bucket = {
  start: number;
  label: string;
  revenue: number;
  byTier: Record<Tier, number>;
  sessions: number;
  hours: number;
  activeUsers: number;
  topups: number;
  charges: number;
};

export async function computeAnalytics(prisma: PrismaClient, range: RangeKey, tzOffsetMin: number) {
  const offset = tzOffsetMin * 60_000;
  const now = Date.now();
  const hourly = range === "24h";
  const step = hourly ? HOUR : DAY;
  const count = hourly ? 24 : RANGES[range];

  // Bucket boundaries aligned to the admin's local hours / midnights.
  const localFloor = (ms: number) => {
    const wall = ms - offset;
    return (hourly ? Math.floor(wall / HOUR) * HOUR : Math.floor(wall / DAY) * DAY) + offset;
  };
  const lastStart = localFloor(now);
  const from = lastStart - (count - 1) * step;
  const to = now;
  const span = to - from;
  const prevFrom = from - span;

  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => {
    const start = from + i * step;
    const wall = new Date(start - offset);
    const label = hourly
      ? `${String(wall.getUTCHours()).padStart(2, "0")}:00`
      : `${String(wall.getUTCDate()).padStart(2, "0")}/${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      start,
      label,
      revenue: 0,
      byTier: { standard: 0, accelerated: 0, dedicated: 0 },
      sessions: 0,
      hours: 0,
      activeUsers: 0,
      topups: 0,
      charges: 0,
    };
  });
  const bucketAt = (ms: number) => {
    const i = Math.floor((ms - from) / step);
    return i >= 0 && i < count ? buckets[i] : undefined;
  };
  // The same buckets one period earlier, for "vs previous period" overlays.
  const prevStart = from - count * step;
  const prevRevenue = buckets.map(() => 0);
  const prevHours = buckets.map(() => 0);
  const prevIndex = (ms: number) => {
    const i = Math.floor((ms - prevStart) / step);
    return i >= 0 && i < count ? i : -1;
  };

  const [sessions, ledger, servers, balances, users] = await Promise.all([
    prisma.session.findMany({
      where: {
        OR: [
          { createdAt: { gte: new Date(prevStart) } },
          { endedAt: { gte: new Date(prevStart) } },
          { endedAt: null, startedAt: { not: null } },
        ],
      },
      select: {
        userId: true,
        resourceId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        finalCharge: true,
        endReason: true,
        resource: { select: { name: true, protocol: true, tier: true } },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: { createdAt: { gte: new Date(prevFrom) }, type: { in: ["topup", "charge"] } },
      select: { type: true, amount: true, createdAt: true },
    }),
    prisma.resource.findMany({ where: { archivedAt: null } }),
    prisma.ledgerEntry.groupBy({ by: ["type"], _sum: { amount: true } }),
    prisma.user.findMany({ select: { id: true, displayName: true, email: true } }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  type Window = { revenue: number; sessions: number; hours: number; users: Set<string>; durations: number[]; failed: number; total: number; topups: number };
  const empty = (): Window => ({ revenue: 0, sessions: 0, hours: 0, users: new Set(), durations: [], failed: 0, total: 0, topups: 0 });
  const cur = empty();
  const prev = empty();
  const bucketUsers = buckets.map(() => new Set<string>());
  const outcomes: Record<Outcome, number> = { completed: 0, out_of_credit: 0, time_limit: 0, terminated: 0, interrupted: 0, failed: 0, abandoned: 0 };
  const durationCounts = DURATION_BUCKETS.map(() => 0);
  const perServer = new Map<string, { name: string; protocol: string; revenue: number; hours: number; sessions: number }>();
  const perUser = new Map<string, { revenue: number; hours: number; sessions: number }>();
  const protocolHours = { ssh: 0, rdp: 0 };
  const util = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (const s of sessions) {
    const created = s.createdAt.getTime();
    const started = s.startedAt?.getTime() ?? null;
    const ended = s.endedAt?.getTime() ?? null;
    const charge = s.finalCharge === null ? 0 : Number(s.finalCharge);
    const tier: Tier = (TIERS as readonly string[]).includes(s.resource.tier) ? (s.resource.tier as Tier) : "standard";

    // Attempts and outcomes by when the session was opened.
    const win = created >= from ? cur : created >= prevFrom ? prev : null;
    if (win) {
      win.total += 1;
      if (s.endReason === "connection_failed") win.failed += 1;
    }
    if (created >= from && s.endReason) {
      const outcome = (Object.keys(OUTCOMES) as Outcome[]).find((k) =>
        (OUTCOMES[k] as readonly string[]).includes(s.endReason!),
      );
      if (outcome) outcomes[outcome] += 1;
    }

    // Revenue when billed.
    if (ended !== null && charge > 0) {
      const w = ended >= from ? cur : ended >= prevFrom ? prev : null;
      if (w) w.revenue += charge;
      const b = bucketAt(ended);
      if (b) {
        b.revenue += charge;
        b.byTier[tier] += charge;
      }
      const pi = prevIndex(ended);
      if (pi !== -1) prevRevenue[pi]! += charge;
      if (ended >= from) {
        const srv = perServer.get(s.resourceId) ?? { name: s.resource.name, protocol: s.resource.protocol, revenue: 0, hours: 0, sessions: 0 };
        srv.revenue += charge;
        perServer.set(s.resourceId, srv);
        const usr = perUser.get(s.userId) ?? { revenue: 0, hours: 0, sessions: 0 };
        usr.revenue += charge;
        perUser.set(s.userId, usr);
      }
    }

    if (started === null) continue;
    // Connected sessions, counted in the window they started.
    const sw = started >= from ? cur : started >= prevFrom ? prev : null;
    if (sw) {
      sw.sessions += 1;
      sw.users.add(s.userId);
      if (ended !== null) sw.durations.push((ended - started) / 1000);
    }
    if (started >= from) {
      const b = bucketAt(started);
      if (b) b.sessions += 1;
      const srv = perServer.get(s.resourceId) ?? { name: s.resource.name, protocol: s.resource.protocol, revenue: 0, hours: 0, sessions: 0 };
      srv.sessions += 1;
      perServer.set(s.resourceId, srv);
      const usr = perUser.get(s.userId) ?? { revenue: 0, hours: 0, sessions: 0 };
      usr.sessions += 1;
      perUser.set(s.userId, usr);
      if (ended !== null) {
        const secs = (ended - started) / 1000;
        const i = DURATION_BUCKETS.findIndex((d) => secs < d.max);
        durationCounts[i === -1 ? DURATION_BUCKETS.length - 1 : i]! += 1;
      }
    }

    // Connected time split across the windows / buckets it overlapped.
    const end = ended ?? now;
    const overlap = (a: number, b: number) => Math.max(0, Math.min(end, b) - Math.max(started, a));
    cur.hours += overlap(from, to) / HOUR;
    prev.hours += overlap(prevFrom, from) / HOUR;
    const inRange = overlap(from, to) / HOUR;
    if (inRange > 0) {
      const srv = perServer.get(s.resourceId) ?? { name: s.resource.name, protocol: s.resource.protocol, revenue: 0, hours: 0, sessions: 0 };
      srv.hours += inRange;
      perServer.set(s.resourceId, srv);
      const usr = perUser.get(s.userId) ?? { revenue: 0, hours: 0, sessions: 0 };
      usr.hours += inRange;
      perUser.set(s.userId, usr);
      if (s.resource.protocol === "ssh") protocolHours.ssh += inRange;
      else protocolHours.rdp += inRange;
    }
    buckets.forEach((b, i) => {
      const ms = overlap(b.start, b.start + step);
      if (ms > 0) {
        b.hours += ms / HOUR;
        bucketUsers[i]!.add(s.userId);
      }
      const pms = overlap(prevStart + i * step, prevStart + (i + 1) * step);
      if (pms > 0) prevHours[i]! += pms / HOUR;
    });
    // Utilization: weekday × local hour across the range.
    let t = Math.max(started, from);
    while (t < end) {
      const wall = t - offset;
      const hourEnd = Math.min(end, t + (HOUR - (((wall % HOUR) + HOUR) % HOUR)));
      const d = new Date(wall);
      util[(d.getUTCDay() + 6) % 7]![d.getUTCHours()]! += hourEnd - t;
      t = hourEnd;
    }
  }
  buckets.forEach((b, i) => {
    b.activeUsers = bucketUsers[i]!.size;
  });

  for (const e of ledger) {
    const at = e.createdAt.getTime();
    const amount = Number(e.amount);
    if (e.type === "topup") {
      if (at >= from) cur.topups += amount;
      else if (at >= prevFrom) prev.topups += amount;
    }
    const b = bucketAt(at);
    if (b) {
      if (e.type === "topup") b.topups += amount;
      else b.charges += amount;
    }
  }

  // Utilization as % of in-service capacity: each weekday/hour cell is seen
  // `occurrences` times in the range.
  const inService = Math.max(1, servers.filter((s) => s.active).length);
  const occurrences = Math.max(1, span / (7 * DAY));
  const utilization = util.map((row) =>
    row.map((ms) =>
      ms === 0 ? 0 : Math.min(100, Math.max(1, Math.round((ms / (HOUR * occurrences * inService)) * 100))),
    ),
  );
  let peak: { day: number; hour: number; value: number } | null = null;
  utilization.forEach((row, day) =>
    row.forEach((value, hour) => {
      if (value > 0 && (peak === null || value > peak.value)) peak = { day, hour, value };
    }),
  );

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const kpi = (w: Window) => ({
    revenue: r2(w.revenue),
    sessions: w.sessions,
    connectedHours: r2(w.hours),
    activeUsers: w.users.size,
    avgSessionMin: r2(avg(w.durations) / 60),
    failureRate: w.total ? r2((w.failed / w.total) * 100) : 0,
    topups: r2(w.topups),
  });

  const sum = (type: string) => Number(balances.find((b) => b.type === type)?._sum.amount ?? 0);
  const outstanding = sum("topup") + sum("refund") - sum("charge");

  const top = <T extends { revenue: number; hours: number }>(m: Map<string, T>) =>
    [...m.entries()]
      .sort((a, b) => b[1].revenue - a[1].revenue || b[1].hours - a[1].hours)
      .slice(0, 8);

  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucket: hourly ? "hour" : "day",
    current: kpi(cur),
    previous: kpi(prev),
    live: {
      sessions: liveRegistry.count(),
      serversInService: servers.filter((s) => s.active && s.hostname.trim() !== "").length,
      servers: servers.length,
    },
    timeline: buckets.map((b, i) => ({
      label: b.label,
      start: new Date(b.start).toISOString(),
      revenue: r2(b.revenue),
      standard: r2(b.byTier.standard),
      accelerated: r2(b.byTier.accelerated),
      dedicated: r2(b.byTier.dedicated),
      sessions: b.sessions,
      hours: r2(b.hours),
      activeUsers: b.activeUsers,
      topups: r2(b.topups),
      charges: r2(b.charges),
      prevRevenue: r2(prevRevenue[i]!),
      prevHours: r2(prevHours[i]!),
    })),
    outcomes,
    durations: DURATION_BUCKETS.map((d, i) => ({ label: d.label, count: durationCounts[i]! })),
    protocolHours: { ssh: r2(protocolHours.ssh), rdp: r2(protocolHours.rdp) },
    topServers: top(perServer).map(([id, v]) => ({ id, ...v, revenue: r2(v.revenue), hours: r2(v.hours) })),
    topUsers: top(perUser).map(([id, v]) => ({
      id,
      name: userById.get(id)?.displayName ?? "?",
      email: userById.get(id)?.email ?? "",
      ...v,
      revenue: r2(v.revenue),
      hours: r2(v.hours),
    })),
    utilization,
    peak,
    credit: { outstanding: r2(outstanding) },
    fleet: servers
      .filter((s) => readSettings(s.settings).monitoring !== "off")
      .map((s) => ({ id: s.id, name: s.name, protocol: s.protocol, ...healthStatusOf(s.id) })),
  };
}
