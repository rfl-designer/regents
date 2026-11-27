import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { type Db, migrationsFolder as defaultFolder } from "../db/client";

/**
 * Onde o banco está em relação às migrações desta versão (Spec, módulo 13: migrações só para a
 * frente). O Drizzle guarda em `drizzle.__drizzle_migrations.created_at` o `when` do `_journal.json`
 * de cada migração aplicada e só aplica as de `when` maior que a última do banco; então um banco
 * com `created_at` maior que a última migração desta versão foi migrado por uma versão mais nova.
 */
export type MigrationState =
  /** Banco vazio: nada aplicado ainda (a primeira subida). */
  | { kind: "empty"; pending: number }
  | { kind: "current"; tag: string }
  | { kind: "behind"; tag: string; pending: number }
  /** Migrado por uma versão mais nova: esta não pode subir nele. */
  | { kind: "newer"; appliedAt: Date; latestKnown: string };

interface JournalEntry {
  tag: string;
  when: number;
}

export function journalOf(folder = defaultFolder): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/** O `created_at` da última migração aplicada, ou nada se o banco nunca foi migrado. */
async function lastApplied(db: Db): Promise<number | undefined> {
  const exists = rowsOf<{ t: string | null }>(
    await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`),
  );
  if (!exists[0]?.t) return undefined;
  const rows = rowsOf<{ at: string | number | null }>(
    await db.execute(sql`select max(created_at) as at from drizzle.__drizzle_migrations`),
  );
  const at = rows[0]?.at;
  return at === null || at === undefined ? undefined : Number(at);
}

export async function migrationState(db: Db, folder = defaultFolder): Promise<MigrationState> {
  const journal = journalOf(folder);
  const latest = journal.at(-1)!;
  const at = await lastApplied(db);
  if (at === undefined) return { kind: "empty", pending: journal.length };
  if (at > latest.when) return { kind: "newer", appliedAt: new Date(at), latestKnown: latest.tag };
  const pending = journal.filter((m) => m.when > at).length;
  const tag = [...journal].reverse().find((m) => m.when <= at)?.tag ?? latest.tag;
  return pending === 0 ? { kind: "current", tag } : { kind: "behind", tag, pending };
}

/** Esta versão não sobe num banco migrado por uma mais nova: voltar de versão é restaurar um dump. */
export class NewerDatabaseError extends Error {
  override name = "NewerDatabaseError";
  constructor(state: Extract<MigrationState, { kind: "newer" }>) {
    super(
      `este banco foi migrado por uma versão mais nova do Regents (uma migração de ${state.appliedAt.toISOString()}, ` +
        `depois da última que esta versão conhece, ${state.latestKnown}). Para não estragar os dados, esta versão não sobe nele. ` +
        "Volte para a versão mais nova (REGENTS_VERSION no .env) ou, para ficar nesta, restaure um backup feito antes da " +
        "atualização: `docker compose run --rm app restore <arquivo>` (o dump de antes da migração fica em ./backups).",
    );
  }
}

/** O `db.execute` do PGlite devolve `{ rows }`; o do postgres-js, a própria lista. */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
