import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import {
  closeUserGrant,
  closeWatchGrant,
  findError,
  GUAC_STATUS,
  hasOpcode,
  instruction,
  openTunnel,
  openUserGrant,
  openWatchGrant,
  syncServer,
  type DisplayOptions,
  type UserGrant,
  type WatchGrant,
} from "../services/guacamole.js";
import { audit } from "../services/audit.js";
import {
  availableCredit,
  finalizeSession,
  liveRegistry,
  sessionRate,
  watchRegistry,
  type EndReason,
} from "../services/live-sessions.js";
import { isConfigured, minCap } from "../services/servers.js";
import { consumeTicket } from "../services/tunnel-tickets.js";

/**
 * GET /api/tunnel — the remote display, as a WebSocket.
 *
 *   browser ──ws (ticket)──▶ backend ──ws (Guacamole token)──▶ Guacamole ──▶ guacd ──▶ server
 *
 * The browser speaks the Guacamole protocol (guacamole-common-js) but only
 * ever to this endpoint. The backend redeems a one-time ticket, re-checks
 * access, makes sure the server is mirrored in Guacamole, gives the user's
 * Guacamole account READ on that one connection for the length of the
 * session, logs in as them and pipes frames both ways. So the browser never
 * holds a Guacamole token, never sees server credentials or addresses, and
 * Guacamole's "Active sessions" / "History" still show who it was.
 *
 * Owning the stream also makes the backend the meter: it starts billing at
 * the first rendered frame once the connection is confirmed (see
 * CONFIRM_MS), enforces the hold / time cap, extends the hold
 * from fresh credit (a top-up mid-session keeps you connected), and ends
 * the session with a reason the UI can show.
 */

/** Credit is reserved in chunks of this many minutes and topped up as used. */
export const HOLD_CHUNK_MINUTES = Math.max(1, Number(process.env["HOLD_MINUTES_DEFAULT"] ?? 60));
/** Least credit, in seconds of a server's rate, worth opening or extending a session for. */
export const MIN_CREDIT_SECONDS = Math.max(1, Number(process.env["MIN_SESSION_CREDIT_SECONDS"] ?? 60));
const HEARTBEAT_MS = 30_000;
/**
 * guacd draws an SSH terminal before it has reached the server, so the first
 * frame is not proof of a connection: a failure (bad host, refused, bad
 * credentials) arrives as an `error` shortly after. Billing starts at the
 * first frame only if no error/disconnect follows within this window — a
 * failed connection is never billed, a real one is billed from its start.
 */
const CONFIRM_MS = 3_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_TYPE = /^audio\/L(?:8|16)(?:;rate=\d{4,6},channels=[12])?$/;
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

type TunnelQuery = {
  ticket?: string;
  width?: string;
  height?: string;
  dpi?: string;
  timezone?: string;
  image?: string | string[];
  audio?: string | string[];
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function displayOptions(q: TunnelQuery): DisplayOptions {
  const timezone = q.timezone !== undefined && TIMEZONE.test(q.timezone) ? q.timezone : undefined;
  return {
    width: clampInt(q.width, 320, 7680, 1280),
    height: clampInt(q.height, 240, 4320, 720),
    dpi: clampInt(q.dpi, 48, 384, 96),
    ...(timezone !== undefined ? { timezone } : {}),
    images: list(q.image).filter((t) => IMAGE_TYPES.has(t)),
    audio: list(q.audio).filter((t) => AUDIO_TYPE.test(t)).slice(0, 4),
  };
}

/** Origins allowed to open the tunnel (the portal frontend). */
function allowedOrigins(): Set<string> {
  const raw = process.env["TUNNEL_ALLOWED_ORIGINS"] ?? process.env["APP_URL"] ?? "http://localhost:3000";
  return new Set(raw.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean));
}

/**
 * Cross-site WebSocket hijacking guard: browsers always send Origin on a
 * WebSocket handshake, so a page on any other site is refused before the
 * upgrade. (The ticket is the real credential; this is defence in depth.)
 */
async function originGuard(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins().has(origin.replace(/\/$/, ""))) {
    request.log.warn({ origin }, "tunnel: rejected origin");
    return reply.code(403).send({ error: "bad_origin" });
  }
}

export async function tunnelRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/tunnel/watch — an admin joins a live session read-only
   * (Guacamole sharing, read-only profile enforced by guacd). Ticket from
   * POST /api/admin/sessions/:id/watch. The user is told they are watched.
   */
  fastify.get<{ Querystring: TunnelQuery }>(
    "/api/tunnel/watch",
    { websocket: true, preValidation: originGuard },
    (socket, request) => {
      void runWatch(fastify, socket, request.query, request.log).catch((err: unknown) => {
        request.log.error({ err }, "watch: crashed");
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(instruction("error", "internal_error", String(GUAC_STATUS.SERVER_ERROR)));
          socket.close(1011);
        }
      });
    },
  );

  fastify.get<{ Querystring: TunnelQuery }>(
    "/api/tunnel",
    { websocket: true, preValidation: originGuard },
    (socket, request) => {
      void runTunnel(fastify, socket, request.query, request.log).catch((err: unknown) => {
        request.log.error({ err }, "tunnel: crashed");
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(instruction("error", "internal_error", String(GUAC_STATUS.SERVER_ERROR)));
          socket.close(1011);
        }
      });
    },
  );
}

async function runTunnel(
  fastify: FastifyInstance,
  socket: WebSocket,
  query: TunnelQuery,
  log: FastifyRequest["log"],
): Promise<void> {
  const prisma = fastify.prisma;

  /** Refuse before anything is running: tell the client why, then close. */
  const refuse = (reason: string, code: number) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(instruction("error", reason, String(code)));
      socket.close(1000);
    }
  };

  // Frames the browser sends while we are still reaching Guacamole.
  const early: string[] = [];
  const onEarly = (data: WebSocket.RawData) => {
    if (early.length < 200) early.push(data.toString());
  };
  socket.on("message", onEarly);

  /* ---- 1. ticket + access ------------------------------------------ */
  const ticket = consumeTicket(String(query.ticket ?? ""));
  if (ticket === null) return refuse("ticket_invalid", GUAC_STATUS.CLIENT_UNAUTHORIZED);

  const session = await prisma.session.findUnique({
    where: { id: ticket.sessionId },
    include: { resource: true, user: true },
  });
  if (session === null || session.userId !== ticket.userId || session.status !== "pending") {
    return refuse("session_unavailable", GUAC_STATUS.CLIENT_FORBIDDEN);
  }

  const server = session.resource;
  const giveUp = async (reason: string, code: number, end: EndReason = "never_connected") => {
    await finalizeSession(prisma, session.id, end);
    refuse(reason, code);
  };

  if (session.user.status !== "active") {
    return giveUp("account_suspended", GUAC_STATUS.CLIENT_FORBIDDEN);
  }
  if (!server.active || server.archivedAt !== null || !isConfigured(server)) {
    return giveUp("server_unavailable", GUAC_STATUS.UPSTREAM_UNAVAILABLE);
  }
  // Access may have been revoked between POST /api/sessions and now.
  const entitlement = await prisma.entitlement.findUnique({
    where: { userId_resourceId: { userId: session.userId, resourceId: server.id } },
  });
  if (!server.openToAll && entitlement === null) {
    return giveUp("no_access", GUAC_STATUS.CLIENT_FORBIDDEN);
  }

  /* ---- 2. Guacamole: mirror + just-in-time access (creds stay server-side) */
  let grant: UserGrant;
  try {
    const connectionId = await syncServer(prisma, server, log);
    if (connectionId === null) throw new Error("server is not mirrored in Guacamole");
    grant = await openUserGrant(session.user, connectionId);
  } catch (err) {
    log.error({ err: (err as Error).message, sessionId: session.id }, "tunnel: could not open a Guacamole session");
    return giveUp("gateway_unavailable", GUAC_STATUS.UPSTREAM_UNAVAILABLE, "connection_failed");
  }
  if (socket.readyState !== WebSocket.OPEN) {
    // The user left while we were connecting.
    void closeUserGrant(grant);
    await finalizeSession(prisma, session.id, "never_connected");
    return;
  }

  const upstream = openTunnel(grant, displayOptions(query));

  /* ---- 3. metering state -------------------------------------------- */
  const rate = sessionRate(session, server.ratePerMinute);
  const capMinutes = minCap(server.maxSessionMin, entitlement?.maxSessionMin ?? null);
  let hold = Number(session.holdAmount);
  let startedAt: number | null = null;
  let firstFrameAt: number | null = null;
  let ended = false;
  let confirm: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let upstreamError: { message: string; code: number } | null = null;

  const end = (reason: EndReason, tellClient: boolean, message: string = reason) => {
    if (ended) return;
    ended = true;
    clearTimeout(confirm);
    clearTimeout(deadline);
    clearInterval(heartbeat);
    liveRegistry.remove(session.id);
    watchRegistry.closeAll(session.id);

    if (tellClient && socket.readyState === WebSocket.OPEN) {
      socket.send(instruction("error", message, String(GUAC_STATUS.SESSION_CLOSED)));
    }
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
    void closeUserGrant(grant);
    void finalizeSession(prisma, session.id, reason)
      .then((result) => {
        if (result !== null) {
          log.info({ sessionId: session.id, reason, charge: result.charge }, "tunnel: session settled");
        }
      })
      .catch((err: unknown) => log.error({ err, sessionId: session.id }, "tunnel: settle failed"));
  };

  liveRegistry.add({
    sessionId: session.id,
    userId: session.userId,
    resourceId: server.id,
    terminate: (reason) => end(reason, true),
  });

  /** Arms the timer for whichever comes first: hold used up or time cap. */
  const schedule = () => {
    if (startedAt === null || ended) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const holdSeconds = (hold / rate) * 60;
    const capSeconds = capMinutes === null ? Infinity : capMinutes * 60;
    const remaining = Math.min(holdSeconds, capSeconds) - elapsed;
    deadline = setTimeout(() => void onDeadline(), Math.min(MAX_TIMER_MS, Math.max(0, remaining * 1000)));
  };

  const onDeadline = async () => {
    if (startedAt === null || ended) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const capSeconds = capMinutes === null ? Infinity : capMinutes * 60;
    if (elapsed >= capSeconds - 1) return end("time_limit", true);
    if ((hold / rate) * 60 > elapsed + 1) return schedule(); // long-timer wake-up

    // Hold used up: reserve another chunk from whatever credit is free now.
    try {
      const free = await availableCredit(prisma, session.userId);
      if (ended) return;
      if (free < (rate * MIN_CREDIT_SECONDS) / 60) return end("balance_exhausted", true);
      const chunk = rate * HOLD_CHUNK_MINUTES;
      const capLeft = capSeconds === Infinity ? Infinity : (rate * (capSeconds - elapsed)) / 60;
      const add = round4(Math.min(free, chunk, capLeft));
      await prisma.$transaction([
        prisma.session.update({
          where: { id: session.id },
          data: { holdAmount: { increment: add.toFixed(4) } },
        }),
        prisma.ledgerEntry.create({
          data: { userId: session.userId, sessionId: session.id, type: "hold", amount: add.toFixed(4) },
        }),
      ]);
      hold = round4(hold + add);
      schedule();
    } catch (err) {
      log.error({ err, sessionId: session.id }, "tunnel: hold extension failed");
      end("balance_exhausted", true);
    }
  };

  /** Confirmed: the remote session is really up — bill from its first frame. */
  const onStarted = async (at: Date) => {
    startedAt = at.getTime();
    await prisma.session.updateMany({
      where: { id: session.id, status: "pending" },
      data: { status: "active", startedAt: at, lastSeenAt: at },
    });
    schedule();
    heartbeat = setInterval(() => {
      void prisma.session
        .updateMany({ where: { id: session.id, status: "active" }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
  };

  /* ---- 4. pipe ------------------------------------------------------- */
  upstream.on("open", () => {
    socket.off("message", onEarly);
    for (const frame of early) upstream.send(frame);
    early.length = 0;
    socket.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
  });

  upstream.on("message", (data) => {
    const frame = data.toString();
    if (firstFrameAt === null && !ended && hasOpcode(frame, "sync")) {
      firstFrameAt = Date.now();
      const at = new Date(firstFrameAt);
      confirm = setTimeout(() => {
        if (ended) return;
        void onStarted(at).catch((err: unknown) => log.error({ err }, "tunnel: could not mark session active"));
      }, CONFIRM_MS);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(frame);

    // Guacamole reports a failed or finished connection in-band and may keep
    // the socket open afterwards; the session is over either way. The browser
    // already received the reason, so end without a second message.
    const error = findError(frame);
    if (error !== null) upstreamError = error;
    if (error !== null || hasOpcode(frame, "disconnect")) {
      if (upstreamError !== null) {
        log.info({ sessionId: session.id, guac: upstreamError }, "tunnel: remote side reported an error");
      }
      end(startedAt === null ? "connection_failed" : "server_closed", false);
    }
  });

  upstream.on("close", () => {
    const reason = startedAt === null ? "connection_failed" : "server_closed";
    end(reason, upstreamError === null, reason);
  });

  upstream.on("error", (err) => {
    log.error({ err: err.message, sessionId: session.id }, "tunnel: Guacamole stream error");
    end(startedAt === null ? "connection_failed" : "server_closed", true, "gateway_unavailable");
  });

  socket.on("close", () => end("user_closed", false));
  socket.on("error", () => end("user_closed", false));
}

async function runWatch(
  fastify: FastifyInstance,
  socket: WebSocket,
  query: TunnelQuery,
  log: FastifyRequest["log"],
): Promise<void> {
  const prisma = fastify.prisma;
  const refuse = (reason: string, code: number) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(instruction("error", reason, String(code)));
      socket.close(1000);
    }
  };

  const ticket = consumeTicket(String(query.ticket ?? ""), "watch");
  if (ticket === null) return refuse("ticket_invalid", GUAC_STATUS.CLIENT_UNAUTHORIZED);
  const session = await prisma.session.findUnique({
    where: { id: ticket.sessionId },
    include: { user: true, resource: true },
  });
  if (session === null || session.status !== "active" || !liveRegistry.has(session.id)) {
    return refuse("session_ended", GUAC_STATUS.SESSION_CLOSED);
  }
  if (session.resource.guacConnectionId === null) return refuse("session_ended", GUAC_STATUS.SESSION_CLOSED);

  let grant: WatchGrant;
  try {
    grant = await openWatchGrant(session.user, session.resource.guacConnectionId);
  } catch (err) {
    log.warn({ err: (err as Error).message, sessionId: session.id }, "watch: could not join");
    return refuse("gateway_unavailable", GUAC_STATUS.UPSTREAM_UNAVAILABLE);
  }
  if (socket.readyState !== WebSocket.OPEN) {
    void closeWatchGrant(grant);
    return;
  }

  // Watchers never resize the user's display: use a nominal size.
  const upstream = openTunnel(grant, { ...displayOptions(query), width: 1024, height: 768 });
  let closed = false;
  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    watchRegistry.remove(session.id, close);
    if (reason && socket.readyState === WebSocket.OPEN) {
      socket.send(instruction("error", reason, String(GUAC_STATUS.SESSION_CLOSED)));
    }
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    void closeWatchGrant(grant);
  };
  watchRegistry.add(session.id, () => close("session_ended"));

  const admin = await prisma.user.findUnique({ where: { id: ticket.userId }, select: { email: true } });
  await audit(prisma, {
    actor: { id: ticket.userId, label: admin?.email ?? "admin" },
    action: "session.watched",
    severity: "warn",
    target: { type: "session", id: session.id, label: `${session.user.email} on ${session.resource.name}` },
  }, log);

  const early: string[] = [];
  const onEarly = (data: WebSocket.RawData) => {
    if (early.length < 200) early.push(data.toString());
  };
  socket.on("message", onEarly);
  upstream.on("open", () => {
    socket.off("message", onEarly);
    for (const frame of early) upstream.send(frame);
    // Only protocol replies travel upstream; guacd ignores a read-only
    // joiner's input anyway, this just keeps the pipe tidy.
    socket.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
  });
  upstream.on("message", (data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
  });
  upstream.on("close", () => close("session_ended"));
  upstream.on("error", () => close("gateway_unavailable"));
  socket.on("close", () => close());
  socket.on("error", () => close());
}
