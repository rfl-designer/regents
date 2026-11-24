import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** Uma transação aberta por `db.transaction`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Os ids das linhas são UUID: o que não tem esse formato não existe (sem ir ao banco). */
export function isUuid(id: string) {
  return UUID.test(id);
}

/** Pasta das migrações geradas pelo drizzle-kit (commitadas). */
export const migrationsFolder = new URL("../../migrations", import.meta.url).pathname;
