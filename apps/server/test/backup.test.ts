/**
 * Backup noturno e a seção Instalação (Spec, módulo 13; histórias 11, 13 e 14). O serviço `backup`
 * do compose roda `createNightlyBackups` no mesmo banco; o Admin vê o resultado pela borda HTTP.
 * O `pg_dump` é o dublê (`fakes/dumper.ts`); o de verdade tem `postgres-backup.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallationDto } from "@shearim/contracts";
import { migrationsFolder } from "../src/db/client";
import { createNightlyBackups } from "../src/installation/backups";
import { fakeDumper } from "./fakes/dumper";
import { eventually, onCleanup, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const DAY = 24 * 60 * 60 * 1000;

function backupsDir() {
  const dir = mkdtempSync(join(tmpdir(), "shearim-backups-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** O serviço `backup` do compose, no banco do app de teste. */
function nightly(t: TestApp, dir: string, dumper = fakeDumper()) {
  const job = createNightlyBackups({ db: t.db, clock: t.clock, dumper, dir, log: () => {} });
  onCleanup(() => job.stop());
  return { job, dumper };
}

async function installation(t: TestApp): Promise<InstallationDto> {
  const res = await t.as(juliana).get("/api/installation");
  expect(res.status).toBe(200);
  return res.json();
}

describe("backup noturno", () => {
  test("ao subir sem backup recente, o serviço faz um na hora e depois um por noite, em ./backups", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const dir = backupsDir();
    const { job } = nightly(t, dir);

    job.start();

    const first = await eventually("o primeiro backup", async () => (await installation(t)).backup.last);
    expect(first).toEqual({
      at: "2026-11-24T12:00:00.000Z",
      ok: true,
      file: "shearim-20261124T120000Z.dump",
      bytes: expect.any(Number),
      error: null,
    });
    expect(readdirSync(dir)).toEqual(["shearim-20261124T120000Z.dump"]);

    t.clock.advance(DAY);
    await eventually("o backup da noite seguinte", async () => readdirSync(dir).length === 2);
    t.clock.advance(DAY);
    await eventually("o da outra noite", async () => readdirSync(dir).length === 3);
    const { backup } = await installation(t);
    expect(backup.lastGoodAt).toBe(backup.last!.at);
    expect(new Date(backup.lastGoodAt!).getTime()).toBeGreaterThan(Date.parse("2026-11-25T12:00:00.000Z"));
  });

  test("os backups noturnos ficam 14 dias; os dumps de antes de migrar ou restaurar não são apagados", async () => {
    const t = await testApp();
    const dir = backupsDir();
    writeFileSync(join(dir, "shearim-pre-migracao-20260901T120000Z.dump"), "antes de migrar");
    writeFileSync(join(dir, "notas.txt"), "do Admin");
    const { job } = nightly(t, dir);

    for (let day = 0; day < 20; day++) {
      await job.runNow();
      t.clock.advance(DAY);
    }

    const nightlyFiles = readdirSync(dir).filter((f) => /^shearim-\d{8}T\d{6}Z\.dump$/.test(f));
    expect(nightlyFiles).toHaveLength(14);
    // Os 14 mais recentes: de 30/11 ao último, de 13/12.
    expect(nightlyFiles.sort()[0]).toBe("shearim-20261130T120000Z.dump");
    expect(nightlyFiles.at(-1)).toBe("shearim-20261213T120000Z.dump");
    expect(readdirSync(dir)).toContain("shearim-pre-migracao-20260901T120000Z.dump");
    expect(readdirSync(dir)).toContain("notas.txt");
  });

  test("um backup que falha fica registrado com o motivo, e não deixa arquivo pela metade", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const dir = backupsDir();
    const { job, dumper } = nightly(t, dir);
    await job.runNow();
    t.clock.advance(DAY);
    dumper.failWith("pg_dump saiu com 1: connection refused");

    await job.runNow();

    const { backup } = await installation(t);
    expect(backup.last).toEqual({
      at: "2026-11-25T12:00:00.000Z",
      ok: false,
      file: null,
      bytes: null,
      error: "pg_dump saiu com 1: connection refused",
    });
    expect(backup.lastGoodAt).toBe("2026-11-24T12:00:00.000Z");
    expect(readdirSync(dir)).toEqual(["shearim-20261124T120000Z.dump"]);
  });
});

describe("seção Instalação", () => {
  test("mostra a versão, a migração do banco e que ainda não houve backup", async () => {
    const t = await testApp({ installation: { version: "1.4.2" } });
    await t.as(juliana).get("/api/me");
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));

    const dto = await installation(t);

    expect(dto.version).toBe("1.4.2");
    expect(dto.migration).toBe(journal.entries.at(-1).tag);
    expect(dto.backup).toEqual({ last: null, lastGoodAt: null });
  });

  test("só o Admin vê a seção Instalação", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });

    const res = await t.as(bruno).get("/api/installation");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin" });
  });
});
