import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Pasta das migrações geradas pelo drizzle-kit (commitadas). */
export const migrationsFolder = new URL("../../migrations", import.meta.url).pathname;
