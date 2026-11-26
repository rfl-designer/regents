/**
 * Os comandos do app (Spec, módulo 13): `migrate`, `restore <arquivo>` e a subida (`serve`), como o
 * Admin os roda (`docker compose run --rm app <comando>`): o processo de verdade, num PGlite em
 * disco com as migrações reais. O que se olha é o que o Admin veria: o código de saída, a mensagem,
 * os arquivos em `./backups` e, depois, o Workspace pela borda HTTP.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDto, ChannelDto, MessageDto } from "@regents/contracts";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { systemClock } from "../src/clock";
import { migrationsFolder, schema } from "../src/db/client";
import { connect } from "../src/db/connect";
import { dumpNow } from "../src/installation/commands";
import { onCleanup, testApp } from "./harness";

const MAIN = join(import.meta.dir, "../src/main.ts");

function tmpDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Roda `bun src/main.ts <args>` como o ENTRYPOINT da imagem, e espera ele sair. */
async function runApp(args: string[], env: Record<string, string>, timeoutMs = 30_000) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, DATABASE_URL: "", DATABASE_PASSWORD_FILE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Lê a saída do processo até aparecer `text` (ou falha em 20 s, com o que saiu). */
async function untilOutput(stream: ReadableStream<Uint8Array>, text: string) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const timeout = setTimeout(() => reader.cancel(), 20_000);
  try {
    while (!seen.includes(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`a saída acabou sem "${text}": ${seen}`);
      seen += decoder.decode(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return seen;
}

/**
 * Um PGlite em `dir` migrado com as migrações desta versão mais `extra` (as de uma versão mais
 * nova, que esta não conhece), ou só até `until` (inclusive), como uma Instalação de antes.
 */
async function databaseAt(dir: string, opts: { until?: string; extra?: { tag: string; sql: string }[] } = {}) {
  const folder = tmpDir("shearim-migrations-");
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  if (opts.until) {
    const i = journal.entries.findIndex((e) => e.tag === opts.until);
    if (i < 0) throw new Error(`migração ${opts.until} não existe`);
    journal.entries = journal.entries.slice(0, i + 1);
  }
  for (const m of opts.extra ?? []) {
    const last = journal.entries.at(-1)!;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 86_400_000, tag: m.tag });
    writeFileSync(join(folder, `${m.tag}.sql`), m.sql);
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  const client = new PGlite(dir);
  await migrate(drizzle(client, { schema, casing: "snake_case" }), { migrationsFolder: folder });
  return client;
}

/** O ambiente de um comando do app num PGlite em disco, com a pasta de backups. */
function envFor(dataDir: string, backupsDir: string) {
  return { SHEARIM_PGLITE_DIR: dataDir, SHEARIM_BACKUPS_DIR: backupsDir };
}

describe("banco migrado por uma versão mais nova", () => {
  test("`migrate` e a subida se recusam, dizendo o que fazer, e não tocam no banco", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    const newer = await databaseAt(dataDir, {
      extra: [{ tag: "9000_da-versao-mais-nova", sql: "CREATE TABLE da_versao_mais_nova (id integer);" }],
    });
    await newer.close();
    const keyFile = join(tmpDir("shearim-secrets-"), "master_key");
    writeFileSync(keyFile, "11".repeat(32));

    const migrated = await runApp(["migrate"], envFor(dataDir, backupsDir));
    const served = await runApp(["serve"], {
      ...envFor(dataDir, backupsDir),
      SHEARIM_IDENTITY: "dev",
      SHEARIM_MASTER_KEY_FILE: keyFile,
      HOST: "127.0.0.1",
      PORT: "0",
    });

    for (const run of [migrated, served]) {
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("migrado por uma versão mais nova do Shearim");
      expect(run.stderr).toContain("restore");
    }
    expect(served.stdout).not.toContain("ouvindo");
    // Recusar é não mexer: nada de dump, e a migração da versão mais nova continua lá.
    expect(readdirSync(backupsDir)).toEqual([]);
    const after = new PGlite(dataDir);
    const { rows } = await after.query<{ n: number }>("select count(*)::int as n from da_versao_mais_nova");
    expect(rows).toEqual([{ n: 0 }]);
    await after.close();
  }, 120_000);
});

describe("migrações com um dump antes", () => {
  test("`migrate` num banco de uma versão anterior guarda um dump em ./backups antes de migrar", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    await (await databaseAt(dataDir, { until: "0010_vigia-falha-e-cancelamento" })).close();

    const run = await runApp(["migrate"], envFor(dataDir, backupsDir));

    expect(run.code).toBe(0);
    const files = readdirSync(backupsDir);
    expect(files).toEqual([expect.stringMatching(/^shearim-pre-migracao-\d{8}T\d{6}Z\.tar\.gz$/)]);
    expect(run.stdout).toContain(files[0]!);
  }, 120_000);

  test("banco vazio (a primeira subida) e banco em dia não ganham dump: não há o que salvar nem o que migrar", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");

    const first = await runApp(["migrate"], envFor(dataDir, backupsDir));
    const again = await runApp(["migrate"], envFor(dataDir, backupsDir));

    expect([first.code, again.code]).toEqual([0, 0]);
    expect(readdirSync(backupsDir)).toEqual([]);
  }, 120_000);
});

describe("restore", () => {
  const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
  const masterKey = new Uint8Array(32).fill(7);

  test("`restore <arquivo>` põe o Workspace de volta como estava no backup, e com a mesma ./secrets a Chave segue valendo", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    const conn = connect({ pgliteDir: dataDir });
    await conn.migrate();
    const t = await testApp({ db: conn.db, masterKey });
    const ju = t.as(juliana);
    await ju.put("/api/workspace-key", { apiKey: "sk-ant-api03-do-workspace" });
    const channel: ChannelDto = await (await ju.post("/api/channels", { name: "vendas", kind: "public" })).json();
    const faro: AgentDto = await (await ju.post("/api/agents", { name: "Faro", model: "claude-sonnet-5-5" })).json();
    await ju.post(`/api/channels/${channel.id}/agents`, { agentId: faro.id });
    await ju.post(`/api/channels/${channel.id}/messages`, { body: "antes do backup" });
    const backup = await dumpNow({ conn, clock: systemClock, backupsDir, log: () => {} }, "shearim");
    await ju.post(`/api/channels/${channel.id}/messages`, { body: "depois do backup" });
    await t.shutdown();
    await conn.close();

    // Pelo nome do arquivo em ./backups, como o Admin veria no `ls backups`.
    const run = await runApp(["restore", backup.file.split("/").at(-1)!], envFor(dataDir, backupsDir));

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("restaurado");
    const again = connect({ pgliteDir: dataDir });
    onCleanup(() => again.close());
    const t2 = await testApp({ db: again.db, masterKey });
    const messages: MessageDto[] = await (await t2.as(juliana).get(`/api/channels/${channel.id}/messages`)).json();
    expect(messages.map((m) => m.body)).toEqual(["antes do backup"]);
    t2.anthropic.reply({ chunks: ["Oi!"] });
    await t2.as(juliana).post(`/api/channels/${channel.id}/messages`, { body: "@faro tudo certo?" });
    const [call] = await t2.anthropic.waitForRequests(1);
    expect(call!.apiKey).toBe("sk-ant-api03-do-workspace");
  }, 120_000);

  test("antes de trocar o banco, `restore` guarda uma cópia do atual em ./backups (o arquivo errado não apaga nada)", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    const conn = connect({ pgliteDir: dataDir });
    await conn.migrate();
    const backup = await dumpNow({ conn, clock: systemClock, backupsDir, log: () => {} }, "shearim");
    await conn.close();

    const run = await runApp(["restore", backup.file], envFor(dataDir, backupsDir));

    expect(run.code).toBe(0);
    const copies = readdirSync(backupsDir).filter((f) => f.startsWith("shearim-pre-restauracao-"));
    expect(copies).toHaveLength(1);
    expect(run.stdout).toContain(copies[0]!);
  }, 120_000);

  test("arquivo que não é backup: sai com erro e o Workspace segue como estava, mesmo com --sem-copia", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    const conn = connect({ pgliteDir: dataDir });
    await conn.migrate();
    const t = await testApp({ db: conn.db });
    const channel: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "vendas", kind: "public" })
    ).json();
    await t.as(juliana).post(`/api/channels/${channel.id}/messages`, { body: "continua aqui" });
    await t.shutdown();
    await conn.close();
    const bad = join(backupsDir, "shearim-truncado.tar.gz");
    writeFileSync(bad, "isto não é um backup");

    const run = await runApp(["restore", bad, "--sem-copia"], envFor(dataDir, backupsDir));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Nada foi restaurado");
    const again = connect({ pgliteDir: dataDir });
    onCleanup(() => again.close());
    const t2 = await testApp({ db: again.db });
    const messages: MessageDto[] = await (await t2.as(juliana).get(`/api/channels/${channel.id}/messages`)).json();
    expect(messages.map((m) => m.body)).toEqual(["continua aqui"]);
  }, 120_000);

  test("arquivo que não existe: sai com erro e não mexe no banco", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");

    const run = await runApp(["restore", "shearim-nao-existe.dump"], envFor(dataDir, backupsDir));
    const none = await runApp(["restore"], envFor(dataDir, backupsDir));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("shearim-nao-existe.dump");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("restore <arquivo>");
    expect(readdirSync(backupsDir)).toEqual([]);
  }, 120_000);
});

describe("serviço backup", () => {
  test("`backup` faz o primeiro backup ao subir, fica rodando e para limpo no SIGTERM", async () => {
    const dataDir = tmpDir("shearim-pg-");
    const backupsDir = tmpDir("shearim-backups-");
    expect((await runApp(["migrate"], envFor(dataDir, backupsDir))).code).toBe(0);

    const proc = Bun.spawn(["bun", MAIN, "backup"], {
      env: { ...process.env, DATABASE_URL: "", ...envFor(dataDir, backupsDir) },
      stdout: "pipe",
      stderr: "pipe",
    });
    onCleanup(() => proc.kill());
    // O log sai depois de o resultado ficar gravado no banco.
    await untilOutput(proc.stdout, "backup em");
    proc.kill("SIGTERM");

    expect(await proc.exited).toBe(0);
    expect(readdirSync(backupsDir)).toEqual([expect.stringMatching(/^shearim-\d{8}T\d{6}Z\.tar\.gz$/)]);
    const conn = connect({ pgliteDir: dataDir });
    onCleanup(() => conn.close());
    const t = await testApp({ db: conn.db });
    await t.as({ id: "1001", name: "Juliana" }).get("/api/me");
    const dto = await (await t.as({ id: "1001", name: "Juliana" }).get("/api/installation")).json();
    expect(dto.backup.last).toMatchObject({ ok: true, file: readdirSync(backupsDir)[0] });
  }, 120_000);
});
