import { loadConfig } from "./config.js";
import { closePool, tick } from "./poller.js";

/**
 * Billing daemon entrypoint — a polling loop, no HTTP server.
 * One tick per POLL_INTERVAL_MS; ticks never overlap (a slow tick delays,
 * never duplicates, the next one). SIGTERM/SIGINT shut down cleanly.
 */

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.warn(
    `[billing] starting: poll=${config.pollIntervalMs}ms sources=${config.dataSources.join(",")} ` +
      `guac=${config.guacBaseUrl}`,
  );

  let stopped = false;
  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.warn(`[billing] ${signal} received, draining…`);
    void closePool().finally(() => process.exit(0));
    // Hard cap so a hung pool can't block container stop.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!stopped) {
    const started = Date.now();
    try {
      const summary = await tick();
      console.warn(
        `[billing] tick open=${summary.open} live=${summary.live} ` +
          `activated=${summary.activated} killed=${summary.killed} ` +
          `reconciled=${summary.reconciled}` +
          (summary.errors.length > 0 ? ` errors=${summary.errors.length}` : "") +
          ` (${Date.now() - started}ms)`,
      );
    } catch (err) {
      console.warn(`[billing] tick crashed: ${err instanceof Error ? err.message : err}`);
    }
    if (!stopped) await sleep(config.pollIntervalMs);
  }
}

main().catch((err) => {
  console.error(`[billing] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
