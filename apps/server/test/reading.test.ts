import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MessageDto, UnreadDto } from "@shearim/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };

/** Juliana abre o Workspace (Admin, já no #geral); Bruno vira Membro e entra no #geral. */
async function geralComBruno(t: TestApp) {
  await t.addMember(bruno, { by: juliana });
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return geral!;
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana grava a Chave, cria o Faro e o põe no Canal. */
async function faroNo(t: TestApp, channelId: string): Promise<AgentDto> {
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-chave" });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", { name: "Faro", description: "Comercial.", model: "claude-haiku-5-5" })
  ).json();
  await t.as(juliana).post(`/api/channels/${channelId}/agents`, { agentId: faro.id });
  return faro;
}

async function naoLidas(t: TestApp, who: Person): Promise<UnreadDto> {
  const res = await t.as(who).get("/api/unread");
  expect(res.status).toBe(200);
  return res.json();
}

describe("não-lido", () => {
  test("a mensagem conta como não-lida para quem participa da conversa, menos o autor", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);

    const msg = await enviar(t, bruno, geral.id, "bom dia");

    expect(await naoLidas(t, juliana)).toEqual({
      conversations: [{ conversationId: geral.id, count: 1, mentions: 0, firstUnreadId: msg.id }],
      total: 1,
      mentions: 0,
      dms: 0,
    });
    expect(await naoLidas(t, bruno)).toEqual({ conversations: [], total: 0, mentions: 0, dms: 0 });
  });

  test("a mensagem que aparece na tela sai da contagem, e as outras abas de quem leu acompanham", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    const primeira = await enviar(t, bruno, geral.id, "bom dia");
    const segunda = await enviar(t, bruno, geral.id, "tudo certo?");
    const outraAba = await t.socket(juliana, "outra aba da Juliana");

    const res = await t.as(juliana).post(`/api/conversations/${geral.id}/reads`, { messageIds: [primeira.id] });

    const esperado: UnreadDto = {
      conversations: [{ conversationId: geral.id, count: 1, mentions: 0, firstUnreadId: segunda.id }],
      total: 1,
      mentions: 0,
      dms: 0,
    };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(esperado);
    expect((await outraAba.next("unread.updated")).unread).toEqual(esperado);
    expect(await naoLidas(t, juliana)).toEqual(esperado);
  });

  test("a mensagem nova avisa a contagem pelo WebSocket a quem participa, e não ao autor", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    const me = (await (await t.as(bruno).get("/api/me")).json()) as { id: string };
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");

    const msg = await enviar(t, bruno, geral.id, "bom dia");

    expect((await daJuliana.next("unread.updated")).unread).toMatchObject({
      conversations: [{ conversationId: geral.id, count: 1, firstUnreadId: msg.id }],
      total: 1,
    });
    // Prova de que nada veio ao autor: o próximo "unread.updated" do Bruno é o marcador.
    const marcador: UnreadDto = { conversations: [], total: 42, mentions: 0, dms: 0 };
    t.events.publish({ members: [me.id] }, { type: "unread.updated", unread: marcador });
    expect((await doBruno.next("unread.updated")).unread).toEqual(marcador);
  });

  test("a resposta ancorada conta como não-lida e vem primeiro na ordem de exibição, mesmo chegando depois", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    await faroNo(t, geral.id);
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    // A resposta sai devagar, para as mensagens do Bruno entrarem antes dela.
    t.anthropic.reply({ chunks: ["Sexta", "-feira."], delayMs: 150 });

    const pergunta = await enviar(t, bruno, geral.id, "@Faro qual o prazo?");
    await t.anthropic.waitForRequests(1);
    const depois1 = await enviar(t, bruno, geral.id, "enquanto isso, outra coisa");
    const depois2 = await enviar(t, bruno, geral.id, "e mais uma");
    let unread: UnreadDto;
    do unread = (await daJuliana.next("unread.updated", { timeoutMs: 3_000 })).unread;
    while (unread.total < 4);

    const resposta = (await (await t.as(juliana).get(`/api/conversations/${geral.id}/messages`)).json()).find(
      (m: MessageDto) => m.originMessageId === pergunta.id,
    ) as MessageDto;
    expect(unread.conversations).toEqual([
      { conversationId: geral.id, count: 4, mentions: 0, firstUnreadId: pergunta.id },
    ]);
    const daBruno = await (await t.as(bruno).get(`/api/conversations/${geral.id}/unread`)).json();
    expect(daBruno).toEqual({ messageIds: [resposta.id] });
    const daJulianaIds = await (await t.as(juliana).get(`/api/conversations/${geral.id}/unread`)).json();
    expect(daJulianaIds).toEqual({ messageIds: [pergunta.id, resposta.id, depois1.id, depois2.id] });
  });

  test("quem vê um Canal público sem participar dele não tem não-lidas ali", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    await t.addMember(carla, { by: juliana });

    await enviar(t, bruno, geral.id, "bom dia");

    expect((await naoLidas(t, carla)).total).toBe(0);
    expect(await (await t.as(carla).get(`/api/conversations/${geral.id}/unread`)).json()).toEqual({ messageIds: [] });
  });

  test("quem entra numa conversa não herda como não-lido o que veio antes", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    await t.addMember(carla, { by: juliana });
    await enviar(t, bruno, geral.id, "antes da Carla");
    t.clock.advance(1_000);
    await t.as(carla).post(`/api/channels/${geral.id}/join`);

    const depois = await enviar(t, bruno, geral.id, "depois da Carla");

    expect((await naoLidas(t, carla)).conversations).toEqual([
      { conversationId: geral.id, count: 1, mentions: 0, firstUnreadId: depois.id },
    ]);
  });

  test("Menções ao Membro e mensagens de DM aparecem à parte, para a lista destacá-las", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    const me = (await (await t.as(juliana).get("/api/me")).json()) as { id: string };
    const dm = (await (await t.as(bruno).post("/api/dms", { memberIds: [me.id] })).json()) as { id: string };

    await enviar(t, bruno, geral.id, "@Juliana dá uma olhada");
    await enviar(t, bruno, geral.id, "sem menção");
    await enviar(t, bruno, dm.id, "só entre nós");

    const unread = await naoLidas(t, juliana);
    expect(unread).toMatchObject({ total: 3, mentions: 1, dms: 1 });
    expect(unread.conversations).toContainEqual(
      expect.objectContaining({ conversationId: geral.id, count: 2, mentions: 1 }),
    );
    expect(unread.conversations).toContainEqual(
      expect.objectContaining({ conversationId: dm.id, count: 1, mentions: 0 }),
    );
  });
});

describe("marcar como lida", () => {
  test("numa conversa que a pessoa não vê, responde 404", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const privado: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "diretoria", kind: "private" })
    ).json();
    const msg = await enviar(t, juliana, privado.id, "segredo");

    const res = await t.as(bruno).post(`/api/conversations/${privado.id}/reads`, { messageIds: [msg.id] });

    expect(res.status).toBe(404);
  });

  test("uma marcação sem a lista de mensagens é recusada", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);

    const res = await t.as(juliana).post(`/api/conversations/${geral.id}/reads`, { messageIds: "tudo" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });

  test("uma mensagem de outra conversa não é marcada pela rota desta", async () => {
    const t = await testApp();
    const geral = await geralComBruno(t);
    const outro: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "vendas", kind: "public" })
    ).json();
    await t.as(bruno).post(`/api/channels/${outro.id}/join`);
    const la = await enviar(t, bruno, outro.id, "lá no #vendas");

    await t.as(juliana).post(`/api/conversations/${geral.id}/reads`, { messageIds: [la.id] });

    expect((await naoLidas(t, juliana)).conversations).toEqual([
      { conversationId: outro.id, count: 1, mentions: 0, firstUnreadId: la.id },
    ]);
  });
});
