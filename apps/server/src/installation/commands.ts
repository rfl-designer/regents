import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Clock } from "../clock";
import type { Connection } from "../db/connect";
import { migrationState, NewerDatabaseError } from "./migrations";

export interface CommandDeps {
  conn: Connection;
  clock: Clock;
  /** `./backups` (no compose, `/backups`). */
  backupsDir: string;
  log: (line: string) => void;
}

/** `20261124T030000Z`: a hora do arquivo, em UTC, ordenável pelo nome. */
export function stamp(at: Date) {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Um dump do banco agora em `./backups`, com o motivo no nome. */
export async function dumpNow(deps: CommandDeps, prefix: string) {
  const file = join(deps.backupsDir, `${prefix}-${stamp(deps.clock.now())}.${deps.conn.dumper.extension}`);
  const { bytes } = await deps.conn.dumper.dump(file);
  return { file, bytes };
}

/** Não deu para guardar o dump de antes da migração: melhor não migrar. */
export class DumpBeforeMigrationError extends Error {
  override name = "DumpBeforeMigrationError";
}

/**
 * As migrações do jeito seguro (Spec, módulo 13): só para a frente, nunca num banco migrado por
 * uma versão mais nova, e com um dump antes sempre que há o que migrar num banco que já tem dados
 * (é ele que deixa voltar de versão). É o que `migrate` roda e o que `serve` roda antes de subir.
 */
export async function migrateSafely(deps: CommandDeps): Promise<void> {
  const state = await migrationState(deps.conn.db);
  if (state.kind === "newer") throw new NewerDatabaseError(state);
  if (state.kind === "current") return;
  if (state.kind === "behind") {
    let saved: { file: string };
    try {
      saved = await dumpNow(deps, "shearim-pre-migracao");
    } catch (err) {
      throw new DumpBeforeMigrationError(
        `não consegui guardar o dump de antes da migração em ${deps.backupsDir} (${(err as Error).message}). ` +
          "Nada foi migrado. Confira se a pasta ./backups existe e se o app pode escrever nela.",
      );
    }
    deps.log(`dump de antes da migração (banco em ${state.tag}) em ${saved.file}`);
  }
  await deps.conn.migrate();
}

/** O `restore` falhou, com o que o Admin precisa saber (o que ficou no banco, onde está a cópia). */
export class RestoreError extends Error {
  override name = "RestoreError";
}

/** O arquivo como o Admin escreveu, ou pelo nome dentro de `./backups` (`restore shearim-...dump`). */
export function findBackup(arg: string, backupsDir: string): string | undefined {
  for (const candidate of [resolve(arg), join(backupsDir, basename(arg))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * `restore <arquivo>` (Spec, história 12): troca o banco inteiro pelo do dump. Antes, guarda uma
 * cópia do banco atual em `./backups` (`withCopy: false` pula, para um banco que não tem mais
 * nada a salvar). Os Membros não mudam porque são o `UserProfile.ID` da tailnet, e a Chave do
 * Workspace volta legível com a mesma `./secrets`.
 */
export async function restoreFrom(deps: CommandDeps, arg: string, opts: { withCopy: boolean }) {
  const file = findBackup(arg, deps.backupsDir);
  if (!file) throw new RestoreError(`não achei o arquivo ${arg} (nem em ${deps.backupsDir}). Nada foi restaurado.`);
  const state = await migrationState(deps.conn.db);
  let copy: string | undefined;
  if (opts.withCopy && state.kind !== "empty") {
    try {
      copy = (await dumpNow(deps, "shearim-pre-restauracao")).file;
      deps.log(`cópia do banco de antes da restauração em ${copy}`);
    } catch (err) {
      throw new RestoreError(
        `não consegui guardar uma cópia do banco atual antes de restaurar (${(err as Error).message}). Nada foi restaurado. ` +
          "Se o banco atual não tem mais nada a salvar, rode de novo com --sem-copia.",
      );
    }
  }
  try {
    await deps.conn.dumper.restore(file);
  } catch (err) {
    const back = copy ? ` O banco de antes está em ${copy}: \`restore ${basename(copy)}\` o põe de volta.` : "";
    throw new RestoreError(`a restauração falhou: ${(err as Error).message}${back}`);
  }
  deps.log(
    `banco restaurado de ${file}. Suba o app com a mesma pasta ./secrets (sem ela, a Chave do Workspace precisa ser gravada de novo).`,
  );
}
