/**
 * Backup noturno e a seção Instalação (Spec, módulo 13; histórias 11, 13 e 14). O serviço `backup`
 * do compose roda `createNightlyBackups` no mesmo banco; o Admin vê o resultado pela borda HTTP.
 * O `pg_dump` é o dublê (`fakes/dumper.ts`); o de verdade tem `postgres-backup.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallationDto } from "@regents/contracts";
import { migrationsFolder, schema } from "../src/db/client";
import { createNightlyBackups } from "../src/installation/backups";
import { writeAtomically } from "../src/installation/dumper";
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
      file: "regents-20261124T120000Z.dump",
      bytes: expect.any(Number),
      error: null,
    });
    expect(readdirSync(dir)).toEqual(["regents-20261124T120000Z.dump"]);

    t.clock.advance(DAY);
    await eventually("o backup da noite seguinte", async () => readdirSync(dir).length === 2);
    t.clock.advance(DAY);
    await eventually("o da outra noite", async () => readdirSync(dir).length === 3);
    const { backup } = await installation(t);
    expect(backup.lastGoodAt).toBe(backup.last!.at);
    expect(new Date(backup.lastGoodAt!).getTime()).toBeGreaterThan(Date.parse("2026-11-25T12:00:00.000Z"));
  }, 60_000);

  test("os backups noturnos ficam 14 dias; os dumps de antes de migrar ou restaurar não são apagados", async () => {
    const t = await testApp();
    const dir = backupsDir();
    writeFileSync(join(dir, "regents-pre-migracao-20260901T120000Z.dump"), "antes de migrar");
    writeFileSync(join(dir, "notas.txt"), "do Admin");
    const { job } = nightly(t, dir);

    for (let day = 0; day < 20; day++) {
      await job.runNow();
      t.clock.advance(DAY);
    }

    const nightlyFiles = readdirSync(dir).filter((f) => /^regents-\d{8}T\d{6}Z\.dump$/.test(f));
    expect(nightlyFiles).toHaveLength(14);
    // Os 14 mais recentes: de 30/11 ao último, de 13/12.
    expect(nightlyFiles.sort()[0]).toBe("regents-20261130T120000Z.dump");
    expect(nightlyFiles.at(-1)).toBe("regents-20261213T120000Z.dump");
    expect(readdirSync(dir)).toContain("regents-pre-migracao-20260901T120000Z.dump");
    expect(readdirSync(dir)).toContain("notas.txt");
  }, 60_000);

  test("os backups shearim-* de antes do nome Regents saem pela mesma regra de 14 dias; um arquivo sem nenhum dos dois prefixos fica", async () => {
    const t = await testApp();
    const dir = backupsDir();
    // O relógio do teste começa em 24/11/2026 12:00. Os da versão Shearim, de 1/11 e de 20/11.
    writeFileSync(join(dir, "shearim-20261101T030000Z.dump"), "de 23 dias");
    writeFileSync(join(dir, "shearim-20261120T030000Z.dump"), "de 4 dias");
    writeFileSync(join(dir, "shearim-pre-migracao-20261101T030000Z.dump"), "antes de migrar");
    writeFileSync(join(dir, "outro-20261101T030000Z.dump"), "do Admin");
    const { job } = nightly(t, dir);

    await job.runNow();
    expect(readdirSync(dir).sort()).toEqual([
      "outro-20261101T030000Z.dump",
      "regents-20261124T120000Z.dump",
      "shearim-20261120T030000Z.dump",
      "shearim-pre-migracao-20261101T030000Z.dump",
    ]);

    // Doze dias depois, o shearim-* de 20/11 faz 14 dias: sai como sairia um regents-*.
    t.clock.advance(12 * DAY);
    await job.runNow();
    expect(readdirSync(dir).sort()).toEqual([
      "outro-20261101T030000Z.dump",
      "regents-20261124T120000Z.dump",
      "regents-20261206T120000Z.dump",
      "shearim-pre-migracao-20261101T030000Z.dump",
    ]);
  }, 60_000);

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
    expect(readdirSync(dir)).toEqual(["regents-20261124T120000Z.dump"]);
  }, 60_000);

  test("a pasta que o usuário do container não pode gravar: o motivo diz de quem ela tem que ser e o comando", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const dir = backupsDir();
    // Como a ./backups do host com outro dono e modo 700: o uid do container nem entra nela.
    chmodSync(dir, 0o000);
    onCleanup(() => chmodSync(dir, 0o700));
    const { job, dumper } = nightly(t, dir);

    await job.runNow();

    const { backup } = await installation(t);
    const uid = process.getuid!();
    expect(backup.last).toMatchObject({ ok: false, file: null });
    expect(backup.last!.error).toContain(`não deixa o usuário do Regents (uid ${uid}) gravar`);
    expect(backup.last!.error).toContain(`sudo chown ${uid}:${uid} backups`);
    expect(dumper.dumps).toEqual([]);
  });
});

describe("a escrita do dump", () => {
  test("se o dump falha e a limpeza do .partial também, o motivo é o do dump", async () => {
    const dir = backupsDir();
    onCleanup(() => chmodSync(dir, 0o700));

    const write = writeAtomically(join(dir, "shearim.dump"), async () => {
      // A pasta fecha no meio: o `rm` do .partial dá EACCES.
      chmodSync(dir, 0o000);
      throw new Error("pg_dump saiu com 1: connection refused");
    });

    expect(write).rejects.toThrow("pg_dump saiu com 1: connection refused");
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
  }, 60_000);

  test("o backup shearim-* que a versão de antes do nome Regents gravou aparece como o último backup bom", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    // A linha que o serviço `backup` da versão Shearim gravou na noite de 23/11.
    const at = new Date("2026-11-23T03:00:00.000Z");
    await t.db.insert(schema.backups).values({
      id: crypto.randomUUID(),
      startedAt: at,
      finishedAt: at,
      ok: true,
      file: "shearim-20261123T030000Z.dump",
      bytes: 2048,
    });

    const { backup } = await installation(t);

    expect(backup).toEqual({
      last: {
        at: "2026-11-23T03:00:00.000Z",
        ok: true,
        file: "shearim-20261123T030000Z.dump",
        bytes: 2048,
        error: null,
      },
      lastGoodAt: "2026-11-23T03:00:00.000Z",
    });
  }, 60_000);

  test("só o Admin vê a seção Instalação", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });

    const res = await t.as(bruno).get("/api/installation");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin" });
  }, 60_000);
});

describe("avisos ao Admin sobre o backup", () => {
  const CHECK = 15 * 60 * 1000;

  test("backup que falha: push a cada Admin, uma vez só, e a faixa enquanto o próximo não der certo", async () => {
    const t = await testApp({ installation: { watch: true } });
    const brunoMembro = await t.addMember(bruno, { by: juliana });
    const celularDaJuliana = await t.pushDevice(juliana);
    const celularDoBruno = await t.pushDevice(bruno);
    const aba = await t.socket(juliana);
    const { job, dumper } = nightly(t, backupsDir());
    dumper.failWith("pg_dump: error: connection to server failed");

    await job.runNow();
    t.clock.advance(CHECK);

    const push = await celularDaJuliana.next({ timeoutMs: 5_000 });
    expect(push.payload.notification).toMatchObject({
      title: "O backup do Regents falhou",
      body: "pg_dump: error: connection to server failed",
      navigate: expect.stringMatching(/\/instalacao$/),
      tag: "instalacao-backup",
    });
    expect(push.urgency).toBe("high");
    const { installation: changed } = await aba.next("installation.updated", { timeoutMs: 5_000 });
    expect(changed.alerts).toEqual([
      { kind: "backup_failed", at: "2026-11-24T12:00:00.000Z", error: "pg_dump: error: connection to server failed" },
    ]);
    expect((await installation(t)).alerts).toEqual(changed.alerts);

    // A verificação seguinte não repete o push; o próximo que chega é o das 36 h sem backup bom.
    t.clock.advance(CHECK);
    t.clock.advance(36 * 60 * 60 * 1000);
    const next = await celularDaJuliana.next({ timeoutMs: 5_000 });
    expect(next.payload.notification.title).toBe("Faz 36 h sem um backup bom");
    expect(next.payload.notification.body).toContain("Ainda não houve nenhum backup bom");

    // Bruno não é Admin: nada para ele (o próximo push dele é o da DM que Juliana manda).
    const dm = await (await t.as(juliana).post("/api/dms", { memberIds: [brunoMembro.id] })).json();
    await t.as(juliana).post(`/api/conversations/${dm.id}/messages`, { body: "oi, Bruno" });
    expect((await celularDoBruno.next({ timeoutMs: 5_000 })).payload.notification.body).toBe("oi, Bruno");

    // Um backup bom apaga a faixa.
    dumper.failWith(null);
    await job.runNow();
    t.clock.advance(CHECK);
    // Antes dele, chegou a faixa das 36 h; o que vale é o último estado.
    let cleared = await aba.next("installation.updated", { timeoutMs: 5_000 });
    while (cleared.installation.alerts.length > 0)
      cleared = await aba.next("installation.updated", { timeoutMs: 5_000 });
    expect(cleared.installation.backup.last).toMatchObject({ ok: true });
  }, 60_000);

  test("Admin removido do Workspace não é mais Admin: nem a seção Instalação nem os avisos do backup", async () => {
    const t = await testApp({ installation: { watch: true } });
    const brunoMembro = await t.addMember(bruno, { by: juliana });
    await t.as(juliana).patch(`/api/members/${brunoMembro.id}`, { role: "admin" });
    expect((await t.as(bruno).get("/api/installation")).status).toBe(200);
    const celularDaJuliana = await t.pushDevice(juliana);
    const celularDoBruno = await t.pushDevice(bruno);
    expect((await t.as(juliana).delete(`/api/members/${brunoMembro.id}`)).status).toBeLessThan(300);
    const { job, dumper } = nightly(t, backupsDir());
    dumper.failWith("pg_dump: error: connection to server failed");

    await job.runNow();
    t.clock.advance(CHECK);

    // Os pushes saem em fila: quando o da Juliana chega, o do Bruno já teria chegado.
    expect((await celularDaJuliana.next({ timeoutMs: 5_000 })).payload.notification.title).toBe(
      "O backup do Regents falhou",
    );
    expect(t.push.deliveries.filter((d) => d.endpoint === celularDoBruno.subscription.endpoint)).toEqual([]);
    expect((await t.as(bruno).get("/api/installation")).status).not.toBe(200);
  }, 60_000);

  test("36 h sem backup bom depois de um que deu certo: push com quando foi o último, e a faixa", async () => {
    const t = await testApp({ installation: { watch: true } });
    const celular = await t.pushDevice(juliana);
    const { job } = nightly(t, backupsDir());
    await job.runNow();

    t.clock.advance(35 * 60 * 60 * 1000);
    expect((await installation(t)).alerts).toEqual([]);
    t.clock.advance(60 * 60 * 1000 + CHECK);

    const push = await celular.next({ timeoutMs: 5_000 });
    expect(push.payload.notification.title).toBe("Faz 36 h sem um backup bom");
    expect(push.payload.notification.body).toContain("O último backup bom foi em 24/11");
    expect((await installation(t)).alerts).toEqual([{ kind: "backup_stale", lastGoodAt: "2026-11-24T12:00:00.000Z" }]);
  }, 60_000);
});
