import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { Pool } from "pg";
import { loadAccessConfig, loadConfig } from "./config";
import { schema, type Database } from "./db";
import { createHttpHandlers, type HttpHandlers } from "./http";
import { createRateLimiter } from "./rate-limit";
import { createShareService } from "./shares";
import { createS3Storage } from "./storage/s3";
import { createUploadAccess } from "./upload-access";

let app: Promise<HttpHandlers> | undefined;

/** The wired-up app: migrates the database and prepares the bucket once per process. */
export function getApp(): Promise<HttpHandlers> {
  app ??= start().catch((err) => {
    app = undefined;
    throw err;
  });
  return app;
}

async function start(): Promise<HttpHandlers> {
  const config = loadConfig();
  const db = drizzle(new Pool({ connectionString: config.databaseUrl }), { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  const storage = createS3Storage(config.s3);
  await retry(() => storage.ensureBucket(), "storage");

  const { rateLimitUpload, rateLimitDownload, ...shareLimits } = config.limits;
  const shares = createShareService({ db: db as unknown as Database, storage, limits: shareLimits });
  const perMinute = (limit: number | null) => (limit === null ? null : createRateLimiter({ limit, windowSeconds: 60 }));
  return createHttpHandlers({
    shares,
    expiry: config.expiry,
    upload: config.upload,
    access: createUploadAccess(loadAccessConfig()),
    rateLimits: { upload: perMinute(rateLimitUpload), download: perMinute(rateLimitDownload) },
  });
}

/** Storage can take a few seconds longer to accept requests than the app takes to boot. */
async function retry(attempt: () => Promise<void>, what: string, tries = 30) {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`Waiting for ${what} (${i}/${tries}):`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
