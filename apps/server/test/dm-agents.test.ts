import { describe, expect, test } from "bun:test";
import type { AgentDto, DmDto, MeDto, MessageDto } from "@shearim/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };
const CHAVE = "sk-ant-api03-chave-do-workspace";

/** Juliana vira Admin e grava a Chave; as outras pessoas viram Membros; Faro e Lia são Agentes. */
async function workspace(t: TestApp, ...people: Person[]) {
  const me: Record<string, MeDto> = { Juliana: await (await t.as(juliana).get("/api/me")).json() };
  for (const p of people) me[p.name!] = await t.addMember(p, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const agente = async (name: string, instructions: string): Promise<AgentDto> =>
    (
      await t.as(juliana).post("/api/agents", {
        name,
        photo: null,
        description: "",
        instructions,
        model: "claude-sonnet-5-5",
      })
    ).json();
  const faro = await agente("Faro", "Você é o Faro, do comercial.");
  const lia = await agente("Lia", "Você é a Lia, do jurídico.");
  return { me, faro, lia };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

const pessoa = (m: MeDto) => ({ kind: "member" as const, id: m.id, displayName: m.displayName });
const agente = (a: AgentDto) => ({ kind: "agent" as const, id: a.id, displayName: a.name, photo: a.photo });

describe("DM com um Agente", () => {
  test("um Membro abre uma DM com um Agente, e o Agente responde a cada mensagem, sem Menção", async () => {
    const t = await testApp();
    const { me, faro } = await workspace(t, bruno);
    const aba = await t.socket(bruno, "aba do Bruno");

    const res = await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id });

    expect(res.status).toBe(201);
    const dm: DmDto = await res.json();
    expect(dm).toEqual({ id: expect.any(String), kind: "dm", participants: [pessoa(me.Bruno!), agente(faro)] });
    expect((await aba.next("dm.updated")).dm).toEqual(dm);
    expect(await (await t.as(bruno).get("/api/dms")).json()).toEqual([dm]);

    t.anthropic.reply({ text: "Sexta." }, { text: "Mando hoje." });
    const primeira = await enviar(t, bruno, dm.id, "qual o prazo da proposta?");
    expect((await aba.next("message.created")).message).toEqual(primeira);
    const r1 = (await aba.next("message.created")).message;
    const segunda = await enviar(t, bruno, dm.id, "e o contrato?");
    expect((await aba.next("message.created")).message).toEqual(segunda);
    const r2 = (await aba.next("message.created")).message;

    for (const [resposta, origem, texto] of [
      [r1, primeira, "Sexta."],
      [r2, segunda, "Mando hoje."],
    ] as const) {
      expect(resposta).toMatchObject({
        channelId: dm.id,
        body: texto,
        author: agente(faro),
        originMessageId: origem.id,
      });
    }
    const chamadas = await t.anthropic.waitForRequests(2);
    expect(JSON.stringify(chamadas[0]!.body.system)).toContain("Você é o Faro, do comercial.");
    expect(JSON.stringify(chamadas[1]!.body.messages)).toContain("Bruno: e o contrato?");
    // Só o Bruno participa: a DM com o Faro é dele.
    expect(await (await t.as(juliana).get("/api/dms")).json()).toEqual([]);
    expect((await t.as(juliana).get(`/api/conversations/${dm.id}/messages`)).status).toBe(404);
  });

  test("abrir de novo a DM com o mesmo Agente leva à mesma conversa; com outro Agente, é outra", async () => {
    const t = await testApp();
    const { me, faro, lia } = await workspace(t, bruno);
    const comFaro: DmDto = await (await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id })).json();
    const comJuliana: DmDto = await (await t.as(bruno).post("/api/dms", { memberIds: [me.Juliana!.id] })).json();

    const deNovo = await t.as(bruno).post("/api/dms", { memberIds: [me.Bruno!.id], agentId: faro.id });
    const semLista = await t.as(bruno).post("/api/dms", { agentId: faro.id });
    const comLia = await t.as(bruno).post("/api/dms", { memberIds: [], agentId: lia.id });
    const daJuliana = await t.as(juliana).post("/api/dms", { memberIds: [], agentId: faro.id });

    expect(deNovo.status).toBe(200);
    expect(await deNovo.json()).toEqual(comFaro);
    expect(semLista.status).toBe(200);
    expect(comLia.status).toBe(201);
    const dmLia: DmDto = await comLia.json();
    expect(dmLia.participants).toEqual([pessoa(me.Bruno!), agente(lia)]);
    // A DM da Juliana com o Faro é dela: não é a do Bruno.
    expect(daJuliana.status).toBe(201);
    expect((await daJuliana.json()).id).not.toBe(comFaro.id);
    const doBruno: DmDto[] = await (await t.as(bruno).get("/api/dms")).json();
    expect(doBruno.map((d) => d.id).sort()).toEqual([comFaro.id, comJuliana.id, dmLia.id].sort());
  });

  test("a DM com Agente é só entre quem abre e um Agente que existe", async () => {
    const t = await testApp();
    const { me, faro } = await workspace(t, bruno);

    for (const body of [
      { memberIds: [me.Juliana!.id], agentId: faro.id },
      { memberIds: [], agentId: crypto.randomUUID() },
      { memberIds: [], agentId: "não-é-uuid" },
      { memberIds: [], agentId: 42 },
    ]) {
      const res = await t.as(bruno).post("/api/dms", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    expect(await (await t.as(bruno).get("/api/dms")).json()).toEqual([]);
  });
});

describe("Menções numa DM com Agente", () => {
  test("mencionar o próprio Agente da DM não o chama duas vezes; mencionar outro chama os dois", async () => {
    const t = await testApp();
    const { faro } = await workspace(t, bruno);
    const dm: DmDto = await (await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id })).json();
    const aba = await t.socket(bruno, "aba do Bruno");
    t.anthropic.reply({ text: "Aqui, Bruno." }, { text: "Prazo é sexta." }, { text: "Contrato ok." });

    const soFaro = await enviar(t, bruno, dm.id, "@Faro, tá aí?");
    const comLia = await enviar(t, bruno, dm.id, "@Lia confere o contrato com o Faro?");

    const respostas = [];
    while (respostas.length < 3) {
      const { message } = await aba.next("message.created");
      if (message.author.kind === "agent") respostas.push([message.author.displayName, message.originMessageId]);
    }
    expect(respostas).toEqual([
      ["Faro", soFaro.id],
      ["Faro", comLia.id],
      ["Lia", comLia.id],
    ]);
    expect(t.anthropic.requests).toHaveLength(3);
  });

  test("uma Menção escrita por um Agente não dispara nada", async () => {
    const t = await testApp();
    const { faro } = await workspace(t, bruno);
    const dm: DmDto = await (await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id })).json();
    const aba = await t.socket(bruno, "aba do Bruno");
    t.anthropic.reply({ text: "Isso é com a @Lia." }, { text: "Combinado." });

    await enviar(t, bruno, dm.id, "e o contrato?");
    expect((await aba.next("message.created")).message.body).toBe("e o contrato?");
    expect((await aba.next("message.created")).message.body).toBe("Isso é com a @Lia.");
    const depois = await enviar(t, bruno, dm.id, "tá bom");

    // Se a Menção do Faro tivesse chamado a Lia, ela estaria na fila antes desta.
    const chamadas: string[] = [];
    while (chamadas.length < 2) {
      const { execution } = await aba.next("execution.updated");
      if (execution.state === "queued") chamadas.push(`${execution.agent.displayName} ${execution.originMessageId}`);
    }
    expect(chamadas[1]).toBe(`Faro ${depois.id}`);
    await t.anthropic.waitForRequests(2);
    expect(t.anthropic.requests).toHaveLength(2);
  });
});

describe("N e Desfecho nas DMs", () => {
  test("o N de uma DM com Agente é fixo: o Admin não a vê nem a edita nas Instruções dos Canais", async () => {
    const t = await testApp();
    const { faro } = await workspace(t);
    const dm: DmDto = await (await t.as(juliana).post("/api/dms", { memberIds: [], agentId: faro.id })).json();

    const config = await (await t.as(juliana).get("/api/channel-settings")).json();
    const patch = await t.as(juliana).request(`/api/channel-settings/${dm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recentMessages: 5 }),
    });

    expect(config.map((c: { name: string }) => c.name)).toEqual(["geral"]);
    expect(patch.status).toBe(404);
  });
});

describe("Agentes numa DM entre pessoas", () => {
  test.each([
    ["DM entre duas pessoas", [bruno], "dm"],
    ["DM em grupo", [bruno, carla], "group"],
  ] as const)("na %s, um Agente responde só quando é mencionado", async (_nome, outras, tipo) => {
    const t = await testApp();
    const { me, faro } = await workspace(t, ...outras);
    const aba = await t.socket(juliana, "aba da Juliana");
    const dm: DmDto = await (
      await t.as(juliana).post("/api/dms", { memberIds: outras.map((p) => me[p.name]!.id) })
    ).json();
    expect(dm.kind).toBe(tipo);
    await aba.next("dm.updated");
    t.anthropic.reply({ text: "Sexta, Juliana." });

    const semMencao = await enviar(t, juliana, dm.id, "Faro sabe o prazo, mas ninguém chamou ele.");
    const comMencao = await enviar(t, bruno, dm.id, "@faro qual o prazo?");

    // A primeira execução que chega é a da Menção: a mensagem sem Menção não chamou ninguém.
    expect((await aba.next("execution.updated")).execution).toMatchObject({
      channelId: dm.id,
      originMessageId: comMencao.id,
      agent: { id: faro.id },
    });
    expect((await aba.next("message.created")).message).toEqual(semMencao);
    expect((await aba.next("message.created")).message).toEqual(comMencao);
    expect((await aba.next("message.created")).message).toMatchObject({
      channelId: dm.id,
      body: "Sexta, Juliana.",
      author: agente(faro),
      originMessageId: comMencao.id,
    });
    expect(t.anthropic.requests).toHaveLength(1);
    // Mencionado, o Agente responde, mas não vira participante da DM.
    const [depois] = (await (await t.as(juliana).get("/api/dms")).json()) as DmDto[];
    expect(depois!.participants.every((p) => p.kind === "member")).toBe(true);
  });
});
