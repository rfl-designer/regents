import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * O que sabe tirar e repor uma cópia inteira do banco (Spec, módulo 13). Na Instalação é o
 * `pg_dump`/`pg_restore` do Postgres (`postgres-dumper.ts`); no desenvolvimento e nos testes, o
 * diretório de dados do PGlite num tar. O backup completo é esse arquivo mais `./secrets`.
 */
export interface Dumper {
  /** A extensão dos arquivos que ele gera (`dump`, `tar.gz`). */
  extension: string;
  /** Grava a cópia em `file`. Só aparece o arquivo inteiro: nunca um pela metade. */
  dump(file: string): Promise<{ bytes: number }>;
  /** Troca o banco inteiro pelo de `file`. A conexão do app não serve mais depois disto. */
  restore(file: string): Promise<void>;
}

/** Escreve em `<file>.partial` e só renomeia quando terminou; se falhar, não sobra nada. */
export async function writeAtomically(file: string, write: (tmp: string) => Promise<void>) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.partial`;
  try {
    await write(tmp);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { bytes: statSync(file).size };
}

/** O PGlite em disco de `bun run dev` e dos testes: o diretório de dados num `.tar.gz`. */
export function pgliteDumper(deps: { client: () => PGlite; dataDir: string; close: () => Promise<void> }): Dumper {
  return {
    extension: "tar.gz",
    dump: (file) =>
      writeAtomically(file, async (tmp) => {
        await Bun.write(tmp, await deps.client().dumpDataDir("gzip"));
      }),
    async restore(file) {
      const data = new Blob([await Bun.file(file).arrayBuffer()], { type: "application/x-gzip" });
      await deps.close();
      rmSync(deps.dataDir, { recursive: true, force: true });
      mkdirSync(deps.dataDir, { recursive: true });
      const restored = new PGlite(deps.dataDir, { loadDataDir: data });
      await restored.waitReady;
      await restored.close();
    },
  };
}

/** Sem cópia: o PGlite em memória do e2e, que some ao parar. */
export const noDumper: Dumper = {
  extension: "none",
  dump: () => Promise.reject(new Error("o banco em memória não tem backup")),
  restore: () => Promise.reject(new Error("o banco em memória não tem backup")),
};
