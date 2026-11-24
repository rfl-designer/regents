import { describe, expect, test } from "bun:test";
import type { ChannelDto, MeDto, MessageDto } from "@shearim/contracts";
import { type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };

function mensagem(body: string): MessageDto {
  return {
    id: crypto.randomUUID(),
    channelId: crypto.randomUUID(),
    body,
    author: { kind: "member", id: crypto.randomUUID(), displayName: "Juliana", profilePicUrl: null },
    originMessageId: null,
    mentions: [],
    createdAt: "2026-11-24T12:00:00.000Z",
  };
}

async function canalInicial(t: TestApp) {
  const channels: ChannelDto[] = await (await t.as(juliana).get("/api/channels")).json();
  return channels[0]!;
}

describe("mensagens em tempo real", () => {
  test("uma mensagem enviada aparece na hora em todas as conexões abertas", async () => {
    const t = await testApp();
    const geral = await canalInicial(t);
    const aba1 = await t.socket(juliana, "aba 1");
    const aba2 = await t.socket(juliana, "aba 2");

    const res = await t.as(juliana).post(`/api/channels/${geral.id}/messages`, { body: "Chegou?" });
    const sent: MessageDto = await res.json();

    expect((await aba1.next("message.created")).message).toEqual(sent);
    expect((await aba2.next("message.created")).message).toEqual(sent);
  });

  test("a conexão é de quem a porta de identidade diz que fez o upgrade", async () => {
    const t = await testApp();
    const me: MeDto = await (await t.as(juliana).get("/api/me")).json();

    const aba = await t.socket(juliana);

    expect(await aba.next("ready")).toEqual({ type: "ready", me });
  });

  test("sem identidade da tailnet, o upgrade é recusado", async () => {
    const t = await testApp();
    await canalInicial(t);

    const res = await t.upgrade({ none: "funnel" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_identity", reason: "funnel" });
  });

  test("quem não é Membro não abre o WebSocket", async () => {
    const t = await testApp();
    await canalInicial(t);

    const res = await t.upgrade({ id: "2002", name: "Bruno" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_a_member" });
  });

  test("um evento publicado para alguns Membros chega só às conexões deles", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const { id: julianaId }: MeDto = await (await t.as(juliana).get("/api/me")).json();
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");

    t.events.publish({ members: [julianaId] }, { type: "message.created", message: mensagem("só para a Juliana") });
    t.events.publish("everyone", { type: "message.created", message: mensagem("para todos") });

    // O evento "para todos" saiu depois; se o de Juliana chegasse ao Bruno, chegaria antes.
    expect((await doBruno.next("message.created")).message.body).toBe("para todos");
    expect((await daJuliana.next("message.created")).message.body).toBe("só para a Juliana");
    expect((await daJuliana.next("message.created")).message.body).toBe("para todos");
  });

  test("a conexão fechada deixa de receber, e as outras seguem recebendo", async () => {
    const t = await testApp();
    const aba1 = await t.socket(juliana, "aba 1");
    const aba2 = await t.socket(juliana, "aba 2");

    await aba1.close();
    t.events.publish("everyone", { type: "message.created", message: mensagem("depois de fechar") });

    expect((await aba2.next("message.created")).message.body).toBe("depois de fechar");
    expect(aba1.received().map((e) => e.type)).toEqual(["ready"]);
  });
});
