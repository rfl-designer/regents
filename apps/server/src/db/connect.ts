import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Dumper, noDumper, pgliteDumper } from "../installation/dumper";
import { postgresDumper } from "../installation/postgres-dumper";
import { type Db, migrationsFolder, schema } from "./client";

export interface Connection {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
  describe: string;
  /** Tira e repõe a cópia do banco inteiro (backup, dump antes de migrar, `restore`). */
  dumper: Dumper;
}

/** Valor de `pgliteDir` para um PGlite em memória (some ao parar). */
export const MEMORY = "memory://";

/**
 * Com `DATABASE_URL`, fala com o Postgres (produção, compose).
 * Sem ela, usa um PGlite em disco em `pgliteDir` (só para `bun run dev`), ou em memória com `MEMORY`.
 */
export function connect(env: {
  DATABASE_URL?: string;
  DATABASE_PASSWORD?: string;
  pgliteDir: string;
  /** Pasta do `pg_dump`/`pg_restore` (padrão: os do `PATH`). */
  pgBinDir?: string;
}): Connection {
  if (env.DATABASE_URL) {
    // A senha pode vir à parte (do segredo do compose), para não morar na URL.
    const password = env.DATABASE_PASSWORD ? { password: env.DATABASE_PASSWORD } : {};
    const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {}, ...password });
    const db = drizzlePostgres(sql, { schema, casing: "snake_case" });
    return {
      db,
      migrate: () => migratePostgres(db, { migrationsFolder }),
      close: () => sql.end(),
      describe: "Postgres (DATABASE_URL)",
      dumper: postgresDumper({ url: env.DATABASE_URL, password: env.DATABASE_PASSWORD, sql, binDir: env.pgBinDir }),
    };
  }
  if (env.pgliteDir !== MEMORY) mkdirSync(env.pgliteDir, { recursive: true });
  const client = new PGlite(env.pgliteDir);
  const db = drizzlePglite(client, { schema, casing: "snake_case" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  return {
    db,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close,
    dumper: env.pgliteDir === MEMORY ? noDumper : pgliteDumper({ client: () => client, dataDir: env.pgliteDir, close }),
    describe: env.pgliteDir === MEMORY ? "PGlite em memória" : `PGlite em ${env.pgliteDir}`,
  };
}
