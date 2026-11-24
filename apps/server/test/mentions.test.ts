import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const CHAVE = "sk-ant-api03-chave-do-workspace";

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral. */
async function workspaceComFaro(t: TestApp, opts: { chave?: boolean } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial.",
      instructions: "Você é o Faro, do comercial. Responda curto.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  return { faro, geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(juliana).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

describe("Menção a um Agente pela Chave", () => {
  test("a Menção recebe a resposta pela Messages API, ancorada sob a mensagem de origem", async () => {
    const t = await testApp();
    const { faro, geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ chunks: ["O prazo ", "é sexta."], thinking: true });

    const origem = await enviar(t, geral.id, "@Faro qual o prazo da proposta?");

    expect((await aba.next("message.created")).message).toEqual(origem);
    const resposta = (await aba.next("message.created")).message;
    expect(resposta).toEqual({
      id: expect.any(String),
      channelId: geral.id,
      body: "O prazo é sexta.",
      author: { kind: "agent", id: faro.id, displayName: "Faro", photo: null },
      originMessageId: origem.id,
      createdAt: expect.any(String),
    });
    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens).toEqual([origem, resposta]);
  });

  test("a chamada vai com a Chave decifrada, o modelo e as instruções do Agente e a mensagem de quem escreveu", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);

    await enviar(t, geral.id, "Oi @faro, tudo certo?");
    await aba.next("message.created");
    await aba.next("message.created");

    const [chamada] = await t.anthropic.waitForRequests(1);
    expect(chamada!.apiKey).toBe(CHAVE);
    expect(chamada!.body).toMatchObject({ model: "claude-sonnet-5-5", stream: true });
    expect(JSON.stringify(chamada!.body.system)).toContain("Você é o Faro, do comercial. Responda curto.");
    expect(JSON.stringify(chamada!.body.messages)).toContain("Juliana (pessoa): Oi @faro, tudo certo?");
  });

  test("o Andamento aparece pelo WebSocket: na fila, escrevendo e então respondida", async () => {
    const t = await testApp();
    const { faro, geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);

    const origem = await enviar(t, geral.id, "@Faro me ajuda?");

    const naFila = (await aba.next("execution.updated")).execution;
    const escrevendo = (await aba.next("execution.updated")).execution;
    await aba.next("message.created"); // a da Juliana
    const resposta = await aba.next("message.created");
    const fim = (await aba.next("execution.updated")).execution;
    expect(naFila).toMatchObject({
      channelId: geral.id,
      originMessageId: origem.id,
      agent: { id: faro.id, displayName: "Faro", photo: null },
      state: "queued",
      attempt: 0,
    });
    expect(escrevendo).toMatchObject({
      id: naFila.id,
      state: "running",
      step: "writing",
      since: "2026-11-24T12:00:00.000Z",
      attempt: 1,
      payer: "key",
    });
    expect(fim).toMatchObject({ id: naFila.id, state: "done", replyMessageId: resposta.message.id });
  });

  test("a mensagem da pessoa é gravada e anunciada antes de qualquer execução", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error", errorMessage: "Overloaded" });

    const origem = await enviar(t, geral.id, "@Faro vai falhar");
    await aba.next("execution.updated");

    const tipos = aba.received().map((e) => e.type);
    expect(tipos.indexOf("message.created")).toBeLessThan(tipos.indexOf("execution.updated"));
    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens).toEqual([origem]);
  });

  test("mensagem sem Menção não chama Agente nenhum", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);

    const semMencao = await enviar(t, geral.id, "Faro é bom, mas ninguém chamou. email@Faro também não.");
    const comMencao = await enviar(t, geral.id, "Agora sim, @Faro.");

    // A primeira execução que chega é a da segunda mensagem: a primeira não gerou nenhuma.
    expect((await aba.next("execution.updated")).execution.originMessageId).toBe(comMencao.id);
    expect(semMencao.id).not.toBe(comMencao.id);
    await aba.next("message.created");
    await aba.next("message.created");
    await aba.next("message.created");
    expect(t.anthropic.requests).toHaveLength(1);
  });

  test("a resposta continua pendente e sai depois que o servidor reinicia", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    t.anthropic.reply({ hang: true }, { text: "Voltei e respondi." });
    const origem = await enviar(t, geral.id, "@Faro responde mesmo com reinício?");
    await t.anthropic.waitForRequests(1);

    const pendente: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    await t.restart();

    expect(pendente).toMatchObject([{ originMessageId: origem.id, state: "running", step: "writing" }]);
    const resposta = await eventually("a resposta sair depois do reinício", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(resposta.body).toBe("Voltei e respondi.");
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([]);
  });

  test.each([
    [{ status: 401, errorType: "authentication_error" }, "a Chave do Workspace foi recusada pela Anthropic"],
    [{ status: 402, errorType: "billing_error" }, "a Chave do Workspace está sem crédito"],
    [
      { streamError: { type: "overloaded_error", message: "Overloaded" }, text: "Começou e " },
      "a Anthropic está sobrecarregada",
    ],
  ])("a falha da Messages API aparece com o motivo (%o)", async (reply, motivo) => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply(reply);

    await enviar(t, geral.id, "@Faro e agora?");

    await aba.next("execution.updated");
    await aba.next("execution.updated");
    const falha = (await aba.next("execution.updated")).execution;
    expect(falha).toMatchObject({ state: "failed", reason: motivo, replyMessageId: null });
    const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    expect(abertas).toEqual([falha]);
  });

  test("sem Chave do Workspace, Agentes não agem, com o motivo, e a Messages API nem é chamada", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t, { chave: false });
    const aba = await t.socket(juliana);

    await enviar(t, geral.id, "@Faro alguém aí?");

    await aba.next("execution.updated");
    const aviso = (await aba.next("execution.updated")).execution;
    expect(aviso).toMatchObject({ state: "not_acting", reason: "o Workspace não tem Chave" });
    expect(t.anthropic.requests).toHaveLength(0);
  });
});
