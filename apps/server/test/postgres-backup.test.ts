/**
 * Os comandos do app contra um Postgres de verdade (o `pg_dump`/`pg_restore` da Instalação): um
 * cluster descartável na máquina, numa porta livre. Precisa do servidor do Postgres 18 instalado
 * (`initdb`, `pg_ctl`); sem ele, os testes são pulados e o caminho fica no smoke manual (README).
 * `SHEARIM_TEST_PG_BIN` aponta a pasta dos binários.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelDto, MessageDto } from "@shearim/contracts";
import { sql } from "drizzle-orm";
import { systemClock } from "../src/clock";
import { connect } from "../src/db/connect";
import { dumpNow } from "../src/installation/commands";
import { onCleanup, testApp } from "./harness";

const MAIN = join(import.meta.dir, "../src/main.ts");

const binDir = [
  process.env.SHEARIM_TEST_PG_BIN,
  "/opt/homebrew/opt/postgresql@18/bin",
  "/usr/local/opt/postgresql@18/bin",
  "/usr/lib/postgresql/18/bin",
].find((d) => d && ["initdb", "pg_ctl", "pg_dump", "pg_restore"].every((b) => existsSync(join(d, b))));

let cluster: { dir: string; port: number } | undefined;

async function sh(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} saiu com ${code}: ${err}`);
}

function freePort() {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

beforeAll(async () => {
  if (!binDir) return;
  const dir = mkdtempSync(join(tmpdir(), "shearim-pgcluster-"));
  const port = freePort();
  await sh([join(binDir, "initdb"), "-D", join(dir, "data"), "-U", "shearim", "--auth=trust", "-E", "UTF8"]);
  await sh([
    join(binDir, "pg_ctl"),
    "-D",
    join(dir, "data"),
    "-l",
    join(dir, "log"),
    "-o",
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`,
    "-w",
    "start",
  ]);
  cluster = { dir, port };
}, 120_000);

afterAll(async () => {
  if (!cluster || !binDir) return;
  await sh([join(binDir, "pg_ctl"), "-D", join(cluster.dir, "data"), "-m", "immediate", "stop"]);
  rmSync(cluster.dir, { recursive: true, force: true });
}, 60_000);

/** Um banco novo e vazio no cluster. */
async function freshDatabase() {
  const name = `shearim_${crypto.randomUUID().replaceAll("-", "")}`;
  const c = connect({ DATABASE_URL: `postgres://shearim@127.0.0.1:${cluster!.port}/postgres`, pgliteDir: "" });
  await c.db.execute(sql.raw(`CREATE DATABASE ${name}`));
  await c.close();
  return `postgres://shearim@127.0.0.1:${cluster!.port}/${name}`;
}

async function runApp(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, DATABASE_PASSWORD_FILE: "", SHEARIM_PG_BIN_DIR: binDir!, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };

describe.skipIf(!binDir)("Postgres de verdade: pg_dump e pg_restore", () => {
  test("`migrate`, backup e `restore <arquivo>`: o Workspace volta como estava no dump", async () => {
    const url = await freshDatabase();
    const backupsDir = mkdtempSync(join(tmpdir(), "shearim-backups-"));
    onCleanup(() => rmSync(backupsDir, { recursive: true, force: true }));
    const env = { DATABASE_URL: url, SHEARIM_BACKUPS_DIR: backupsDir };

    expect((await runApp(["migrate"], env)).code).toBe(0);
    const conn = connect({ DATABASE_URL: url, pgliteDir: "", pgBinDir: binDir });
    const t = await testApp({ db: conn.db });
    const channel: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "vendas", kind: "public" })
    ).json();
    await t.as(juliana).post(`/api/channels/${channel.id}/messages`, { body: "antes do backup" });
    const backup = await dumpNow({ conn, clock: systemClock, backupsDir, log: () => {} }, "shearim");
    await t.as(juliana).post(`/api/channels/${channel.id}/messages`, { body: "depois do backup" });
    await t.shutdown();
    await conn.close();

    const run = await runApp(["restore", backup.file], env);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(backup.file).toEndWith(".dump");
    expect(readdirSync(backupsDir).filter((f) => f.startsWith("shearim-pre-restauracao-"))).toHaveLength(1);
    const again = connect({ DATABASE_URL: url, pgliteDir: "" });
    onCleanup(() => again.close());
    const t2 = await testApp({ db: again.db });
    const messages: MessageDto[] = await (await t2.as(juliana).get(`/api/channels/${channel.id}/messages`)).json();
    expect(messages.map((m) => m.body)).toEqual(["antes do backup"]);
    // Em dia com as migrações: subir de novo não pede dump nem migração.
    expect((await runApp(["migrate"], env)).code).toBe(0);
    expect(readdirSync(backupsDir).filter((f) => f.startsWith("shearim-pre-migracao-"))).toEqual([]);
  }, 120_000);

  test("banco migrado por uma versão mais nova: `migrate` se recusa também no Postgres", async () => {
    const url = await freshDatabase();
    const env = { DATABASE_URL: url, SHEARIM_BACKUPS_DIR: tmpdir() };
    expect((await runApp(["migrate"], env)).code).toBe(0);
    const conn = connect({ DATABASE_URL: url, pgliteDir: "" });
    await conn.db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('da-versao-mais-nova', ${Date.UTC(2030, 0, 1)})`,
    );
    await conn.close();

    const run = await runApp(["migrate"], env);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("migrado por uma versão mais nova do Shearim");
  }, 120_000);
});
