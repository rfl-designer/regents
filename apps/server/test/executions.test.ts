import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { sql } from "drizzle-orm";
import { scriptedBrain } from "./fakes/scripted-brain";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const DOIS_MINUTOS = 120_000;

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral. */
async function workspaceComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial.",
      instructions: "Você é o Faro, do comercial.",
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

/** O próximo Andamento que satisfaz `quando` (os anteriores são lidos e deixados para trás). */
async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated");
    if (quando(execution)) return execution;
  }
}

describe("Nenhuma mensagem no limbo (ADR 0003)", () => {
  test("uma falha depois de gravar a mensagem não a deixa sem Andamento: a execução já está na fila e segue", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    // Outro participante: as não-lidas dele são calculadas depois de gravar a mensagem.
    await t.addMember(bruno, { by: juliana });
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    t.anthropic.reply({ hang: true });

    // O banco falha no meio, depois de gravar a mensagem (no cálculo das não-lidas).
    await t.db.execute(sql`alter table message_reads rename to message_reads_fora`);
    const res = await t.as(juliana).post(`/api/channels/${geral.id}/messages`, { body: "@Faro tá aí?" });
    await t.db.execute(sql`alter table message_reads_fora rename to message_reads`);
    expect(res.status).toBe(500);

    const [origem] = (await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json()) as MessageDto[];
    expect(origem).toMatchObject({ body: "@Faro tá aí?" });
    await t.anthropic.waitForRequests(1);
    const [execucao] = (await (
      await t.as(juliana).get(`/api/channels/${geral.id}/executions`)
    ).json()) as ExecutionDto[];
    expect(execucao).toMatchObject({ originMessageId: origem!.id, state: "running", step: "writing" });
  });
});

describe("Vigia e nova tentativa", () => {
  test("escrevendo sem progresso por 2 min falha e é tentada de novo sozinha 10 s depois, como 2ª tentativa", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true }, { text: "Agora foi." });
    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);

    t.clock.advance(DOIS_MINUTOS - 1_000);
    const [antes] = (await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()) as ExecutionDto[];
    expect(antes).toMatchObject({ state: "running", step: "writing", attempt: 1 });

    t.clock.advance(1_000);
    const falha = await andamento(aba, (e) => e.state !== "running" && e.state !== "queued");
    expect(falha).toMatchObject({
      state: "retrying",
      reason: "ficou 2 minutos sem escrever nada",
      attempt: 1,
      retryAt: "2026-11-24T12:02:10.000Z",
    });

    t.clock.advance(10_000);
    const segunda = await andamento(aba, (e) => e.state === "running");
    expect(segunda).toMatchObject({
      step: "writing",
      attempt: 2,
      since: "2026-11-24T12:02:10.000Z",
      reason: null,
      retryAt: null,
    });
    const resposta = await eventually("a resposta da 2ª tentativa sair", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(resposta.body).toBe("Agora foi.");
    expect(t.anthropic.requests).toHaveLength(2);
  });

  test("depois da segunda falha, a falha aparece de vez com o motivo e o gancho do push é chamado uma vez", async () => {
    const falhas: ExecutionDto[] = [];
    const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true }, { hang: true });
    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);

    t.clock.advance(DOIS_MINUTOS);
    await andamento(aba, (e) => e.state === "retrying");
    t.clock.advance(10_000);
    await t.anthropic.waitForRequests(2);
    t.clock.advance(DOIS_MINUTOS);

    const falha = await andamento(aba, (e) => e.state === "failed");
    expect(falha).toMatchObject({
      originMessageId: origem.id,
      state: "failed",
      attempt: 2,
      reason: "ficou 2 minutos sem escrever nada, nas duas tentativas",
      retryAt: null,
    });
    expect(falhas).toEqual([falha]);
    t.clock.advance(60_000);
    expect(t.anthropic.requests).toHaveLength(2);
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([falha]);
  });

  test("uma falha que a nova tentativa não conserta aparece na hora, sem nova tentativa", async () => {
    const falhas: ExecutionDto[] = [];
    const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 404, errorType: "not_found_error" });

    await enviar(t, geral.id, "@Faro e esse modelo?");

    const falha = await andamento(aba, (e) => e.state !== "queued" && e.state !== "running");
    expect(falha).toMatchObject({ state: "failed", attempt: 1, reason: "o modelo do Agente não existe na Anthropic" });
    expect(falhas).toHaveLength(1);
  });

  test("motivos diferentes nas duas tentativas: fica o da segunda", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true }, { status: 529, errorType: "overloaded_error" });

    await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);
    t.clock.advance(DOIS_MINUTOS);
    await andamento(aba, (e) => e.state === "retrying");
    t.clock.advance(10_000);

    const falha = await andamento(aba, (e) => e.state === "failed");
    expect(falha).toMatchObject({ attempt: 2, reason: "a Anthropic está sobrecarregada" });
  });
});

describe("Subida", () => {
  test('ao subir, a execução que estava escrevendo vira falha "o servidor reiniciou" e é tentada de novo sozinha', async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    t.anthropic.reply({ hang: true }, { text: "Voltei e respondi." });
    const origem = await enviar(t, geral.id, "@Faro responde mesmo com reinício?");
    await t.anthropic.waitForRequests(1);

    await t.restart();

    const [falha] = await eventually("a execução virar falha depois do reinício", async () => {
      const lista: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return lista[0]?.state === "retrying" && lista;
    });
    expect(falha).toMatchObject({
      originMessageId: origem.id,
      reason: "o servidor reiniciou",
      attempt: 1,
      retryAt: "2026-11-24T12:00:10.000Z",
    });
    t.clock.advance(10_000);
    const resposta = await eventually("a resposta sair na nova tentativa", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(resposta.body).toBe("Voltei e respondi.");
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([]);
  });

  test("se o reinício pega a 2ª tentativa, a falha aparece de vez", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" }, { hang: true });
    await enviar(t, geral.id, "@Faro tá aí?");
    await andamento(aba, (e) => e.state === "retrying");
    t.clock.advance(10_000);
    await t.anthropic.waitForRequests(2);

    await t.restart();

    const [falha] = await eventually("a falha aparecer depois do reinício", async () => {
      const lista: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return lista[0]?.state === "failed" && lista;
    });
    expect(falha).toMatchObject({ attempt: 2, reason: "o servidor reiniciou" });
  });

  test("uma nova tentativa marcada antes do reinício sai na hora marcada depois dele", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" }, { text: "Saí depois." });
    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    await andamento(aba, (e) => e.state === "retrying");

    await t.restart();
    t.clock.advance(10_000);

    const resposta = await eventually("a resposta sair na hora marcada", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(resposta.body).toBe("Saí depois.");
  });
});

describe("Progresso", () => {
  test('pensamento, nova tentativa da API e texto contam como progresso; "tentando de novo (n/m)" aparece', async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    const origem = await enviar(t, geral.id, "@Faro pensa com calma");
    const chamada = await cerebro.nextRun();
    const quaseDois = DOIS_MINUTOS - 1_000;

    t.clock.advance(quaseDois);
    await chamada.emit({ type: "thinking" });
    t.clock.advance(quaseDois);
    await chamada.emit({ type: "api_retry", attempt: 1, max: 3 });
    const tentando = await andamento(aba, (e) => e.apiRetry !== null);
    expect(tentando).toMatchObject({ state: "running", step: "writing", apiRetry: { attempt: 1, max: 3 } });
    t.clock.advance(quaseDois);
    await chamada.emit({ type: "text", text: "Pensei " });
    const escrevendo = await andamento(aba, () => true);
    expect(escrevendo).toMatchObject({ state: "running", apiRetry: null });
    t.clock.advance(quaseDois);
    await chamada.emit({ type: "text", text: "e respondi." });
    t.clock.advance(quaseDois);
    await chamada.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });

    const fim = await andamento(aba, (e) => e.state !== "running");
    expect(fim.state).toBe("done");
    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens.find((m) => m.originMessageId === origem.id)?.body).toBe("Pensei e respondi.");
    expect(cerebro.runs).toHaveLength(1);
  });

  test("ping não é progresso: um stream só de pings falha em 2 min", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true, pingEveryMs: 5 });
    await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);
    await t.anthropic.waitForPings(3);

    t.clock.advance(DOIS_MINUTOS);

    const falha = await andamento(aba, (e) => e.state === "retrying");
    expect(falha.reason).toBe("ficou 2 minutos sem escrever nada");
  });
});

describe("Cancelamento", () => {
  const cancelar = (t: TestApp, quem: typeof juliana, conversa: string, mensagem: string) =>
    t.as(quem).post(`/api/conversations/${conversa}/messages/${mensagem}/cancel`);

  test('o autor cancela enquanto o Agente escreve: fica "cancelada", a chamada é interrompida e nada sai depois', async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true });
    const origem = await enviar(t, geral.id, "@Faro deixa pra lá");
    await t.anthropic.waitForRequests(1);
    await andamento(aba, (e) => e.state === "running" && e.payer === "key");

    const res = await cancelar(t, juliana, geral.id, origem.id);

    expect(res.status).toBe(200);
    const cancelada = await andamento(aba, (e) => e.state !== "running");
    expect(cancelada).toMatchObject({ originMessageId: origem.id, state: "cancelled", step: null, reason: null });
    expect(await res.json()).toEqual([cancelada]);
    t.clock.advance(DOIS_MINUTOS + 10_000);
    t.anthropic.reply({ text: "Não devia sair." });
    await enviar(t, geral.id, "@Faro outra coisa");
    await andamento(aba, (e) => e.state === "done");
    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens.filter((m) => m.originMessageId === origem.id)).toEqual([]);
    expect(t.anthropic.requests).toHaveLength(2);
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([cancelada]);
  });

  test("cancelar durante a espera da nova tentativa: ela não sai", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" });
    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    await andamento(aba, (e) => e.state === "retrying");

    expect((await cancelar(t, juliana, geral.id, origem.id)).status).toBe(200);
    expect((await andamento(aba, () => true)).state).toBe("cancelled");
    t.clock.advance(10_000);
    t.anthropic.reply({ text: "Só a outra." });
    await enviar(t, geral.id, "@Faro outra coisa");
    await andamento(aba, (e) => e.state === "done");
    expect(t.anthropic.requests).toHaveLength(2);
  });

  test("cancelar na fila, antes de começar, cancela todas as execuções da mensagem", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const prisma: AgentDto = await (
      await t
        .as(juliana)
        .post("/api/agents", { name: "Prisma", description: "", instructions: "", model: "claude-haiku-5-5" })
    ).json();
    await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: prisma.id });
    t.anthropic.reply({ hang: true });
    const primeira = await enviar(t, geral.id, "@Faro segura a fila");
    await t.anthropic.waitForRequests(1);
    const segunda = await enviar(t, geral.id, "@Faro e @Prisma, na fila");

    const res = await cancelar(t, juliana, geral.id, segunda.id);

    expect(res.status).toBe(200);
    const canceladas: ExecutionDto[] = await res.json();
    expect(canceladas.map((e) => [e.agent.displayName, e.state])).toEqual([
      ["Faro", "cancelled"],
      ["Prisma", "cancelled"],
    ]);
    const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    expect(abertas.find((e) => e.originMessageId === primeira.id)?.state).toBe("running");
  });

  test("só quem escreveu cancela, e só antes do fim", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true }, { text: "Pronto." });
    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);

    const doBruno = await cancelar(t, bruno, geral.id, origem.id);
    expect(doBruno.status).toBe(403);
    expect(await doBruno.json()).toMatchObject({ error: "not_author" });

    t.clock.advance(DOIS_MINUTOS);
    await andamento(aba, (e) => e.state === "retrying");
    t.clock.advance(10_000);
    await andamento(aba, (e) => e.state === "done");
    const depois = await cancelar(t, juliana, geral.id, origem.id);
    expect(depois.status).toBe(409);
    expect(await depois.json()).toMatchObject({ error: "nothing_to_cancel" });
    expect((await cancelar(t, juliana, geral.id, crypto.randomUUID())).status).toBe(404);
  });
});

describe("Tentar de novo", () => {
  const tentarDeNovo = (t: TestApp, quem: typeof juliana, conversa: string, execucao: string) =>
    t.as(quem).post(`/api/conversations/${conversa}/executions/${execucao}/retry`);

  /** Manda a mensagem e deixa as duas tentativas falharem (sobrecarga), até a falha de vez. */
  async function falhaDeVez(t: TestApp, aba: EventSocket, channelId: string) {
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" }, { status: 529, errorType: "overloaded_error" });
    const origem = await enviar(t, channelId, "@Faro tá aí?");
    await andamento(aba, (e) => e.state === "retrying");
    t.clock.advance(10_000);
    const falha = await andamento(aba, (e) => e.state === "failed");
    return { origem, falha };
  }

  test("a nova tentativa automática decide de novo quem paga", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" });
    await enviar(t, geral.id, "@Faro tá aí?");
    await andamento(aba, (e) => e.state === "retrying");

    await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-chave-nova" });
    t.clock.advance(10_000);

    const [primeira, segunda] = await t.anthropic.waitForRequests(2);
    expect(primeira!.apiKey).toBe(CHAVE);
    expect(segunda!.apiKey).toBe("sk-ant-api03-chave-nova");
  });

  test("o autor tenta de novo a falha: refaz a execução, com o contexto e o pagador decididos de novo", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    const { origem, falha } = await falhaDeVez(t, aba, geral.id);
    await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-chave-nova" });
    t.anthropic.reply({ text: "Agora sim." });

    const res = await tentarDeNovo(t, juliana, geral.id, falha.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: falha.id, state: "queued", attempt: 0, reason: null, retryAt: null });
    const escrevendo = await andamento(aba, (e) => e.state === "running");
    expect(escrevendo).toMatchObject({ id: falha.id, attempt: 1, since: "2026-11-24T12:00:10.000Z" });
    await aba.next("message.created"); // a da Juliana
    const resposta = (await aba.next("message.created")).message;
    expect(resposta).toMatchObject({ originMessageId: origem.id, body: "Agora sim." });
    expect((await andamento(aba, () => true)).state).toBe("done");
    const chamadas = await t.anthropic.waitForRequests(3);
    expect(chamadas.map((c) => c.apiKey)).toEqual([CHAVE, CHAVE, "sk-ant-api03-chave-nova"]);
  });

  test('se o "Tentar de novo" falha, ele também ganha a nova tentativa automática', async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);
    const { falha } = await falhaDeVez(t, aba, geral.id);
    t.anthropic.reply({ status: 529, errorType: "overloaded_error" });

    await tentarDeNovo(t, juliana, geral.id, falha.id);

    expect(await andamento(aba, (e) => e.state === "retrying")).toMatchObject({ attempt: 1 });
  });

  test("só quem escreveu tenta de novo, e só uma falha", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    const aba = await t.socket(juliana);
    const { falha } = await falhaDeVez(t, aba, geral.id);

    const doBruno = await tentarDeNovo(t, bruno, geral.id, falha.id);
    expect(doBruno.status).toBe(403);
    expect(await doBruno.json()).toMatchObject({ error: "not_author" });

    t.anthropic.reply({ hang: true });
    expect((await tentarDeNovo(t, juliana, geral.id, falha.id)).status).toBe(200);
    await t.anthropic.waitForRequests(3);
    const deNovo = await tentarDeNovo(t, juliana, geral.id, falha.id);
    expect(deNovo.status).toBe(409);
    expect(await deNovo.json()).toMatchObject({ error: "not_failed" });
    expect((await tentarDeNovo(t, juliana, geral.id, crypto.randomUUID())).status).toBe(404);
  });
});

describe("Dreno", () => {
  test('no SIGTERM, para de pegar trabalho e espera até 20 s; o que ficou rodando vira "o servidor reiniciou" na subida', async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    t.anthropic.reply({ hang: true });
    await enviar(t, geral.id, "@Faro tá aí?");
    await t.anthropic.waitForRequests(1);

    let drenou = false;
    const dreno = t.drain().then(() => {
      drenou = true;
    });
    const nova = await enviar(t, geral.id, "@Faro chegou durante o dreno");
    t.clock.advance(19_999);
    await new Promise((r) => setTimeout(r, 50));
    expect(drenou).toBe(false);
    t.clock.advance(1);
    await dreno;

    expect(t.anthropic.requests).toHaveLength(1);
    const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    expect(abertas.map((e) => e.state)).toEqual(["running", "queued"]);
    expect(abertas[1]!.originMessageId).toBe(nova.id);

    await t.restart();
    const depois = await eventually("a execução interrompida virar falha", async () => {
      const lista: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return lista[0]?.state === "retrying" && lista;
    });
    expect(depois[0]).toMatchObject({ reason: "o servidor reiniciou" });
  });

  test("o dreno termina assim que o que estava rodando termina, e a resposta sai", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspaceComFaro(t);
    const origem = await enviar(t, geral.id, "@Faro termina antes de desligar");
    const chamada = await cerebro.nextRun();

    const dreno = t.drain();
    await chamada.emit({ type: "text", text: "Deu tempo." });
    await chamada.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
    await dreno;

    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens.find((m) => m.originMessageId === origem.id)?.body).toBe("Deu tempo.");
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([]);
  });
});
