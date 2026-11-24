import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Db, migrationsFolder, schema } from "./client";

export interface Connection {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
  describe: string;
}

/**
 * Com `DATABASE_URL`, fala com o Postgres (produção, compose).
 * Sem ela, usa um PGlite em disco em `pgliteDir` (só para `bun run dev`).
 */
export function connect(env: { DATABASE_URL?: string; pgliteDir: string }): Connection {
  if (env.DATABASE_URL) {
    const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(sql, { schema, casing: "snake_case" });
    return {
      db,
      migrate: () => migratePostgres(db, { migrationsFolder }),
      close: () => sql.end(),
      describe: "Postgres (DATABASE_URL)",
    };
  }
  mkdirSync(env.pgliteDir, { recursive: true });
  const client = new PGlite(env.pgliteDir);
  const db = drizzlePglite(client, { schema, casing: "snake_case" });
  return {
    db,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
    describe: `PGlite em ${env.pgliteDir}`,
  };
}
