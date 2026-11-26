import { describe, expect, test } from "bun:test";
import type { DeviceDto, DmDto, MeDto, MessageDto } from "@regents/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

/**
 * Aparelhos e push parado (#33): a lista de Notificações (os aparelhos do Membro, com o estado e
 * o último push entregue), remover um aparelho e o aviso, em toda conexão do Membro, de que um
 * aparelho parou, voltou ou saiu (as faixas de push parado).
 */

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };

async function workspace(t: TestApp, ...people: Person[]) {
  const me: Record<string, MeDto> = { Juliana: await (await t.as(juliana).get("/api/me")).json() };
  for (const p of people) me[p.name!] = await t.addMember(p, { by: juliana });
  return me;
}

async function abrirDm(t: TestApp, who: Person, memberIds: string[]): Promise<DmDto> {
  const res = await t.as(who).post("/api/dms", { memberIds });
  expect(res.status).toBe(201);
  return res.json();
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function aparelhosDe(t: TestApp, who: Person): Promise<DeviceDto[]> {
  const res = await t.as(who).get("/api/devices");
  expect(res.status).toBe(200);
  return res.json();
}

describe("Notificações: os meus aparelhos", () => {
  test("lista os aparelhos com o estado e o último push entregue", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice({ ...bruno, device: "iPhone" });
    t.clock.advance(60_000);
    const notebook = await t.pushDevice({ ...bruno, device: "MacBook" });
    celular.respond(410);
    t.clock.set("2026-11-20T18:05:00.000Z");

    await enviar(t, juliana, dm.id, "oi");
    await celular.next();
    await notebook.next();

    const lista = await eventually("o servidor anotar as respostas", async () => {
      const list = await aparelhosDe(t, bruno);
      return list.every((d) => d.lastPushAt || d.pushStoppedAt) && list;
    });
    expect(lista).toEqual([
      {
        id: celular.deviceId,
        label: "iPhone",
        pushing: false,
        pushStoppedAt: "2026-11-20T18:05:00.000Z",
        lastPushAt: null,
      },
      {
        id: notebook.deviceId,
        label: "MacBook",
        pushing: true,
        pushStoppedAt: null,
        lastPushAt: "2026-11-20T18:05:00.000Z",
      },
    ]);
  });

  test("remover um aparelho tira ele da lista, e ele não recebe mais push", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const antigo = await t.pushDevice(bruno);
    t.clock.advance(60_000);
    const atual = await t.pushDevice(bruno);

    const res = await t.as(bruno).delete(`/api/devices/${antigo.deviceId}`);
    expect(res.status).toBe(204);

    expect((await aparelhosDe(t, bruno)).map((d) => d.id)).toEqual([atual.deviceId]);
    await enviar(t, juliana, dm.id, "depois de remover");
    expect((await atual.next()).payload.notification.body).toBe("depois de remover");
    expect(t.push.deliveries.filter((d) => d.endpoint === antigo.subscription.endpoint)).toHaveLength(0);
  });

  test("remover um aparelho que parou também tira a faixa dele", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    celular.respond(410);
    await enviar(t, juliana, dm.id, "oi");
    await eventually("o aparelho parar", async () => (await aparelhosDe(t, bruno))[0]?.pushStoppedAt);

    expect((await t.as(bruno).delete(`/api/devices/${celular.deviceId}`)).status).toBe(204);

    expect(await aparelhosDe(t, bruno)).toEqual([]);
  });

  test("ninguém remove o aparelho de outra pessoa", async () => {
    const t = await testApp();
    await workspace(t, bruno);
    const celular = await t.pushDevice(bruno);

    expect((await t.as(juliana).delete(`/api/devices/${celular.deviceId}`)).status).toBe(404);
    expect((await t.as(bruno).delete(`/api/devices/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await t.as(bruno).delete("/api/devices/nao-e-um-uuid")).status).toBe(404);

    expect((await aparelhosDe(t, bruno)).map((d) => d.id)).toEqual([celular.deviceId]);
  });
});

describe("as faixas de push parado acompanham, em toda conexão do Membro", () => {
  test('quando um aparelho para, as abas do Membro recebem os aparelhos com o "parou em"; as dos outros, nada', async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice({ ...bruno, device: "iPhone" });
    const abaDoBruno = await t.socket(bruno, "aba do Bruno no notebook");
    const abaDaJuliana = await t.socket(juliana, "aba da Juliana");
    celular.respond(410);
    t.clock.set("2026-11-20T18:05:00.000Z");

    await enviar(t, juliana, dm.id, "oi");

    const { devices } = await abaDoBruno.next("devices.updated", { timeoutMs: 5_000 });
    expect(devices).toEqual([
      {
        id: celular.deviceId,
        label: "iPhone",
        pushing: false,
        pushStoppedAt: "2026-11-20T18:05:00.000Z",
        lastPushAt: null,
      },
    ]);
    // O evento sai numa publicação só: se tivesse ido à Juliana, já teria chegado.
    expect(abaDaJuliana.received().map((e) => e.type)).not.toContain("devices.updated");
  });

  test("religar o push no aparelho tira a faixa: as abas recebem o aparelho recebendo de novo", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    celular.respond(410);
    await enviar(t, juliana, dm.id, "oi");
    await eventually("o aparelho parar", async () => (await aparelhosDe(t, bruno))[0]?.pushStoppedAt);
    const aba = await t.socket(bruno);

    await t.pushDevice(bruno, celular.deviceId);

    const { devices } = await aba.next("devices.updated");
    expect(devices).toEqual([expect.objectContaining({ id: celular.deviceId, pushing: true, pushStoppedAt: null })]);
  });

  test("remover o aparelho tira a faixa: as abas recebem a lista sem ele", async () => {
    const t = await testApp();
    await workspace(t, bruno);
    const celular = await t.pushDevice(bruno);
    t.clock.advance(60_000);
    const notebook = await t.pushDevice(bruno);
    const aba = await t.socket(bruno);

    await t.as(bruno).delete(`/api/devices/${celular.deviceId}`);

    const { devices } = await aba.next("devices.updated");
    expect(devices.map((d) => d.id)).toEqual([notebook.deviceId]);
  });

  test("o navegador que passa a ser de outra pessoa sai da lista de quem o tinha", async () => {
    const t = await testApp();
    await workspace(t, bruno);
    const compartilhado = await t.pushDevice(bruno);
    const abaDoBruno = await t.socket(bruno);

    await t.as(juliana).put(`/api/push/subscriptions/${crypto.randomUUID()}`, compartilhado.subscription);

    const { devices } = await abaDoBruno.next("devices.updated");
    expect(devices).toEqual([
      expect.objectContaining({ id: compartilhado.deviceId, pushing: false, pushStoppedAt: null }),
    ]);
  });
});
