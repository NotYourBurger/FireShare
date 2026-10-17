import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };

/** Either the node-postgres database (app) or an in-process PGlite one (tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
