import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { schema, type Database } from ".";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** A fresh, migrated, in-process Postgres for one test. */
export async function createTestDb(): Promise<Database> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as Database;
}
