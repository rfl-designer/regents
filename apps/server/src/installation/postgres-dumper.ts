import { join } from "node:path";
import type { Sql } from "postgres";
import { type Dumper, writeAtomically } from "./dumper";

/**
 * O `pg_dump`/`pg_restore` do Postgres da Instalação (a imagem do app traz o cliente do Postgres na
 * mesma versão do servidor). O dump vai no formato custom (`-Fc`): comprimido, e o `pg_restore`
 * escolhe o que repor. Sem dono nem permissões: o banco restaurado é do usuário que restaura.
 */
export function postgresDumper(deps: { url: string; password?: string; sql: Sql; binDir?: string }): Dumper {
  const bin = (name: string) => (deps.binDir ? join(deps.binDir, name) : name);
  const env = { ...process.env, ...(deps.password ? { PGPASSWORD: deps.password } : {}) };

  async function run(cmd: string[]) {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(cmd, { env, stdout: "ignore", stderr: "pipe" });
    } catch (err) {
      throw new Error(`não consegui rodar o ${cmd[0]}: ${String(err)}`);
    }
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr as ReadableStream).text()]);
    if (code !== 0) throw new Error(`${cmd[0]} saiu com ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`);
  }

  return {
    extension: "dump",
    dump: (file) =>
      writeAtomically(file, (tmp) =>
        run([
          bin("pg_dump"),
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          `--file=${tmp}`,
          `--dbname=${deps.url}`,
        ]),
      ),
    async restore(file) {
      // Lê o índice do dump antes do DROP: um arquivo que o pg_restore recusa não apaga nada.
      await run([bin("pg_restore"), "--list", file]).catch((err: Error) => {
        throw new Error(`o arquivo não é um dump que o pg_restore aceite (${err.message}). Nada foi restaurado.`);
      });
      // O banco inteiro volta a ser o do dump: o que uma versão mais nova criou não pode sobrar.
      await deps.sql.unsafe(
        "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
      );
      await deps.sql.end();
      await run([
        bin("pg_restore"),
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        `--dbname=${deps.url}`,
        file,
      ]);
    },
  };
}
