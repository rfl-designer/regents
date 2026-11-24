/**
 * Dublê do `pg_dump` para os testes do backup noturno, que rodam no PGlite em memória (sem cópia
 * de verdade): grava um arquivo pequeno no lugar do dump, ou falha como o `pg_dump` falharia.
 * O `pg_dump` de verdade tem o seu teste em `postgres-backup.test.ts`.
 */
import type { Dumper } from "../../src/installation/dumper";
import { writeAtomically } from "../../src/installation/dumper";

export interface FakeDumper extends Dumper {
  /** A partir de agora, todo dump falha com esta mensagem (`null` volta a dar certo). */
  failWith(message: string | null): void;
  /** Os arquivos que ele gravou, em ordem. */
  dumps: string[];
}

export function fakeDumper(): FakeDumper {
  let failure: string | null = null;
  const dumps: string[] = [];
  return {
    extension: "dump",
    dumps,
    failWith: (message) => {
      failure = message;
    },
    dump: (file) =>
      writeAtomically(file, async (tmp) => {
        if (failure) throw new Error(failure);
        await Bun.write(tmp, "PGDMP falso\n");
        dumps.push(file);
      }),
    restore: () => Promise.reject(new Error("o dublê não restaura")),
  };
}
