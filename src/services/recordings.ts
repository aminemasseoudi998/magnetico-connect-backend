import { createReadStream, type ReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { connectionHistory } from "./guacamole.js";

/**
 * Session recordings written by guacd.
 *
 * guacd writes each recorded session to
 *   <recordings>/<Guacamole history UUID>/recording
 * (recording-path "${HISTORY_PATH}/${HISTORY_UUID}", services/servers.ts), a
 * folder shared with this backend through a bind mount (infra/recordings).
 * The portal session is matched to its Guacamole history entry by the user's
 * Guacamole username, the connection and the start time; the UUID is then
 * remembered in sessions.guac_history_ref.
 *
 * RECORDINGS_DIR — that folder as this process sees it
 *   (default: ../infra/recordings, relative to the backend's working dir).
 */

export function recordingsDir(): string {
  return path.resolve(process.env["RECORDINGS_DIR"] ?? path.join(process.cwd(), "..", "infra", "recordings"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A history entry this far from the portal's start time is not ours. */
const MATCH_WINDOW_MS = 2 * 60_000;

export type RecordingInfo =
  | { available: true; sizeBytes: number; historyUuid: string }
  | { available: false; reason: "not_recorded" | "still_running" | "not_found" | "gateway_unavailable" };

type Located = { file: string; sizeBytes: number; historyUuid: string };

async function firstFile(dir: string): Promise<{ file: string; sizeBytes: number } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size > 0) return { file, sizeBytes: info.size };
  }
  return null;
}

/** Resolves (and caches) the Guacamole history UUID of a portal session. */
async function historyUuidOf(
  prisma: PrismaClient,
  session: { id: string; guacHistoryRef: string | null; startedAt: Date | null; userEmail: string; connectionId: string | null },
): Promise<string | null> {
  if (session.guacHistoryRef !== null && UUID.test(session.guacHistoryRef)) return session.guacHistoryRef;
  if (session.startedAt === null || session.connectionId === null) return null;

  const username = session.userEmail.trim().toLowerCase();
  const entries = await connectionHistory(username);
  const started = session.startedAt.getTime();
  let best: { uuid: string; delta: number } | null = null;
  for (const e of entries) {
    if (e.connectionIdentifier !== session.connectionId || e.username !== username || !e.uuid) continue;
    const delta = Math.abs(e.startDate - started);
    if (delta <= MATCH_WINDOW_MS && (best === null || delta < best.delta)) best = { uuid: e.uuid, delta };
  }
  if (best === null) return null;
  await prisma.session.update({ where: { id: session.id }, data: { guacHistoryRef: best.uuid } });
  return best.uuid;
}

async function locate(prisma: PrismaClient, sessionId: string): Promise<Located | RecordingInfo> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { email: true } }, resource: { select: { guacConnectionId: true } } },
  });
  if (session === null || !session.recorded || session.startedAt === null) {
    return { available: false, reason: "not_recorded" };
  }
  if (session.status === "pending" || session.status === "active") {
    return { available: false, reason: "still_running" };
  }
  let uuid: string | null;
  try {
    uuid = await historyUuidOf(prisma, {
      id: session.id,
      guacHistoryRef: session.guacHistoryRef,
      startedAt: session.startedAt,
      userEmail: session.user.email,
      connectionId: session.resource.guacConnectionId,
    });
  } catch {
    return { available: false, reason: "gateway_unavailable" };
  }
  if (uuid === null) return { available: false, reason: "not_found" };
  const hit = await firstFile(path.join(recordingsDir(), uuid));
  if (hit === null) return { available: false, reason: "not_found" };
  return { ...hit, historyUuid: uuid };
}

export async function recordingInfo(prisma: PrismaClient, sessionId: string): Promise<RecordingInfo> {
  const found = await locate(prisma, sessionId);
  if ("file" in found) return { available: true, sizeBytes: found.sizeBytes, historyUuid: found.historyUuid };
  return found;
}

export async function openRecording(
  prisma: PrismaClient,
  sessionId: string,
): Promise<{ stream: ReadStream; sizeBytes: number } | RecordingInfo> {
  const found = await locate(prisma, sessionId);
  if (!("file" in found)) return found;
  return { stream: createReadStream(found.file), sizeBytes: found.sizeBytes };
}
