/**
 * O vencimento da chave do nó da Instalação na tailnet (Spec, histórias 13 e 15): vem do
 * `GET /localapi/v0/status` do tailscaled (`Self.KeyExpiry`), pelo mesmo socket do `whois`.
 * Contrato contra a LocalAPI falsa com respostas gravadas; o resto pela borda HTTP e pelo push.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallationDto } from "@regents/contracts";
import { createNightlyBackups } from "../src/installation/backups";
import { localApiNodeKey } from "../src/installation/node-key";
import { fakeLocalApi, recordedStatus } from "./fake-localapi";
import { fakeDumper } from "./fakes/dumper";
import { fakeClock, onCleanup, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const DAY = 24 * 60 * 60 * 1000;
const CHECK = 15 * 60 * 1000;

describe("adaptador do status da LocalAPI (contrato, resposta gravada)", () => {
  test("o vencimento é o Self.KeyExpiry; sem ele, a chave não vence", async () => {
    const localApi = fakeLocalApi();
    const nodeKey = localApiNodeKey({ socketPath: localApi.socketPath });

    localApi.status(recordedStatus("status-com-vencimento"));
    const expires = await nodeKey.read();
    localApi.status(recordedStatus("status-sem-vencimento"));
    const never = await nodeKey.read();

    expect(expires).toEqual({ kind: "expires", expiresAt: "2027-03-01T09:00:00.000Z" });
    expect(never).toEqual({ kind: "never" });
  }, 60_000);

  test("tailscaled fora do ar ou com erro: não se sabe, e o motivo vai junto", async () => {
    const localApi = fakeLocalApi();
    const nodeKey = localApiNodeKey({ socketPath: localApi.socketPath });

    localApi.status("internal error\n", 500);
    const broken = await nodeKey.read();
    localApi.stop();
    const down = await nodeKey.read();

    expect(broken).toEqual({ kind: "unknown", reason: expect.stringContaining("500") });
    expect(down).toEqual({ kind: "unknown", reason: expect.stringContaining("tailscaled") });
  }, 60_000);
});

describe("chave do nó na seção Instalação", () => {
  test("o Admin vê quando a chave do nó vence", async () => {
    const localApi = fakeLocalApi();
    localApi.status(recordedStatus("status-com-vencimento"));
    const t = await testApp({ installation: { nodeKey: localApiNodeKey({ socketPath: localApi.socketPath }) } });
    await t.as(juliana).get("/api/me");

    const dto: InstallationDto = await (await t.as(juliana).get("/api/installation")).json();

    expect(dto.nodeKey).toEqual({ kind: "expires", expiresAt: "2027-03-01T09:00:00.000Z" });
  }, 60_000);

  test("14 dias antes de a chave do nó vencer, cada Admin recebe um push, uma vez só", async () => {
    const localApi = fakeLocalApi();
    localApi.status(recordedStatus("status-com-vencimento"));
    // A chave vence em 01/03/2027 09:00Z; o relógio começa 20 dias antes, com backup toda noite.
    const t = await testApp({
      clock: fakeClock("2027-02-09T09:00:00.000Z"),
      installation: { watch: true, nodeKey: localApiNodeKey({ socketPath: localApi.socketPath }) },
    });
    const celular = await t.pushDevice(juliana);
    const dir = mkdtempSync(join(tmpdir(), "shearim-backups-"));
    onCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const dumper = fakeDumper();
    const job = createNightlyBackups({ db: t.db, clock: t.clock, dumper, dir, log: () => {} });
    for (let day = 0; day < 5; day++) {
      t.clock.advance(DAY);
      await job.runNow();
    }

    // Até aqui (15 dias antes), nenhum push; o primeiro é o de quando faltam 14 dias.
    t.clock.advance(DAY + CHECK);

    const push = await celular.next({ timeoutMs: 5_000 });
    expect(push.payload.notification).toMatchObject({
      title: "A chave do nó vence em 14 dias",
      navigate: expect.stringMatching(/\/instalacao$/),
      tag: "instalacao-chave-do-no",
    });
    expect(push.payload.notification.body).toContain("01/03");
    expect(push.urgency).toBe("normal");

    // As verificações seguintes não repetem: o próximo push é o do backup que falha.
    t.clock.advance(CHECK);
    t.clock.advance(DAY);
    dumper.failWith("disco cheio");
    await job.runNow();
    t.clock.advance(CHECK);
    expect((await celular.next({ timeoutMs: 5_000 })).payload.notification.title).toBe("O backup do Shearim falhou");
  }, 60_000);
});
