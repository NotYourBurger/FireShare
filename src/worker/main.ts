import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { formatBytes } from "../app/format";
import { createCleanup, type CleanupReport } from "../server/cleanup";
import { loadConfig } from "../server/config";
import { schema, type Database } from "../server/db";
import { createS3Storage } from "../server/storage/s3";

/** How often the cleanup jobs run. */
const INTERVAL_MS = 5 * 60 * 1000;

// The cleanup worker: a separate process that reclaims storage on a schedule.
// The app migrates the database; until it has, runs fail, log, and retry.
const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const cleanup = createCleanup({
  db: drizzle(pool, { schema }) as unknown as Database,
  storage: createS3Storage(config.s3),
  config: config.cleanup,
});

let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function tick() {
  timer = undefined;
  try {
    console.log(describe(await cleanup.run()));
  } catch (err) {
    console.error("Cleanup run failed:", err);
  }
  if (!stopping) timer = setTimeout(tick, INTERVAL_MS);
  else await pool.end();
}

function describe(report: CleanupReport): string {
  const parts = [
    `${report.removedFiles} files of ${report.expiredShares} expired or deleted shares (${formatBytes(report.removedBytes)})`,
    `${report.abandonedShares} abandoned uploads (${formatBytes(report.abandonedBytes)})`,
  ];
  const reclaimed = formatBytes(report.removedBytes + report.abandonedBytes);
  const failed = report.failures > 0 ? `; ${report.failures} shares failed and will be retried` : "";
  return `Cleanup removed ${parts.join(" and ")}, reclaiming ${reclaimed}${failed}`;
}

// Stop between runs; a run cut short is completed by the next one anyway.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      void pool.end();
    }
  });
}

console.log(
  `Cleanup worker started: DELETE_GRACE ${config.cleanup.deleteGraceSeconds}s, PENDING_TTL ${config.cleanup.pendingTtlSeconds}s`,
);
void tick();
