import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MentionDto, MessageDto } from "@shearim/contracts";
import { eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana", profilePicUrl: "https://pic/j.png" };
const bruno = { id: "2002", name: "Bruno" };
const carla = { id: "3003", name: "Carla" };
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
      mentions: [],
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

  test("mensagem sem Menção não chama o Agente: vai ao roteamento da Articuladora", async () => {
    const t = await testApp();
    const { faro, geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);

    const semMencao = await enviar(t, geral.id, "Faro é bom, mas ninguém chamou. email@Faro também não.");
    const comMencao = await enviar(t, geral.id, "Agora sim, @Faro.");

    // A primeira mensagem não chama o Faro; ela recebe o Desfecho da Articuladora (o padrão do falso: nenhum).
    expect((await aba.next("execution.updated")).execution).toMatchObject({
      originMessageId: semMencao.id,
      kind: "route",
    });
    expect((await aba.next("execution.updated")).execution).toMatchObject({
      originMessageId: comMencao.id,
      kind: "mention",
      agent: { id: faro.id },
    });
    await eventually("as duas execuções terminarem", async () => {
      const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return abertas.length === 0 || undefined;
    });
    const doFaro = t.anthropic.requests.filter((r) => !r.body.output_config);
    expect(doFaro).toHaveLength(1);
    expect(JSON.stringify(doFaro[0]!.body.messages)).toContain("Agora sim, @Faro.");
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

describe("Menção a um Agente pelo identificador de Menção", () => {
  test("a Menção ao Agente fica registrada na mensagem, ao lado das pessoas, na ordem do texto", async () => {
    const t = await testApp();
    const { faro, geral } = await workspaceComFaro(t);
    const doBruno = await t.addMember(bruno, { by: juliana });
    const aba = await t.socket(bruno, "aba do Bruno");

    const enviada = await enviar(t, geral.id, "@bruno e @Faro, vejam isso");
    const { message: chegou } = await aba.next("message.created");
    const lidas: MessageDto[] = await (await t.as(bruno).get(`/api/channels/${geral.id}/messages`)).json();

    const esperado: MentionDto[] = [
      { kind: "member", id: doBruno.id },
      { kind: "agent", id: faro.id },
    ];
    for (const m of [enviada, chegou, lidas[0]!]) expect(m.mentions).toEqual(esperado);
  });

  test("o Agente responde pelo identificador dele, que pode ter sufixo; o nome sozinho não basta", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const doFaroPessoa = await t.addMember({ id: "4004", name: "Faro Silva" }, { by: juliana });
    const { faro, geral } = await workspaceComFaro(t);
    const aba = await t.socket(juliana);

    const paraPessoa = await enviar(t, geral.id, "@faro, é com você");
    const paraAgente = await enviar(t, geral.id, `@${faro.handle} agora é com o Agente`);

    expect(faro.handle).toBe("faro2");
    expect(paraPessoa.mentions).toEqual([{ kind: "member", id: doFaroPessoa.id }]);
    expect(paraAgente.mentions).toEqual([{ kind: "agent", id: faro.id }]);
    // Só a segunda mensagem chama o Faro; a primeira vai ao roteamento da Articuladora.
    expect((await aba.next("execution.updated")).execution).toMatchObject({
      originMessageId: paraPessoa.id,
      kind: "route",
    });
    expect((await aba.next("execution.updated")).execution).toMatchObject({
      originMessageId: paraAgente.id,
      kind: "mention",
    });
  });
});

async function canalGeral(t: TestApp) {
  const channels: ChannelDto[] = await (await t.as(juliana).get("/api/channels")).json();
  return channels.find((c) => c.name === "geral")!;
}

async function send(t: TestApp, who: typeof juliana | typeof bruno, channelId: string, body: string) {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

describe("Menção a pessoa", () => {
  test("uma mensagem com @nome registra a Menção, na resposta, na lista e no WebSocket", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const canal = await canalGeral(t);
    const abaDoBruno = await t.socket(bruno, "aba do Bruno");

    const enviada = await send(t, juliana, canal.id, "@bruno olha isso");
    const { message: chegou } = await abaDoBruno.next("message.created");
    const [lida] = await (await t.as(bruno).get(`/api/channels/${canal.id}/messages`)).json();

    for (const m of [enviada, chegou, lida]) expect(m.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
    expect(lida.author).toMatchObject({ displayName: "Juliana", profilePicUrl: "https://pic/j.png" });
  });

  test("a Menção ignora maiúsculas, acento e pontuação em volta, e vale uma vez por pessoa", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const daCarla = await t.addMember({ id: "3003", name: "Cárla" }, { by: juliana });
    const canal = await canalGeral(t);

    const m = await send(t, juliana, canal.id, "Oi @Bruno, e você (@CÁRLA)? @bruno.");

    expect(m.mentions).toEqual([
      { kind: "member", id: doBruno.id },
      { kind: "member", id: daCarla.id },
    ]);
  });

  test("e-mail, identificador de ninguém e @ solto não são Menção", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const canal = await canalGeral(t);

    const m = await send(t, juliana, canal.id, "manda para bruno@exemplo.com, @ninguem e @ sozinho");

    expect(m.mentions).toEqual([]);
  });

  test("num Canal privado, só conta a Menção a quem participa dele", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    await t.addMember(carla, { by: juliana });
    const privado: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "diretoria", kind: "private" })
    ).json();
    await t.as(juliana).post(`/api/channels/${privado.id}/participants`, { memberId: doBruno.id });

    const m = await send(t, juliana, privado.id, "@bruno e @carla, vejam");

    expect(m.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
  });

  test("numa DM, a Menção vale para quem está nela, e não para quem está de fora", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    await t.addMember(carla, { by: juliana });
    const dm = await (await t.as(juliana).post("/api/dms", { memberIds: [doBruno.id] })).json();

    const res = await t.as(juliana).post(`/api/conversations/${dm.id}/messages`, { body: "@bruno, chama a @carla?" });

    expect(res.status).toBe(201);
    expect((await res.json()).mentions).toEqual([{ kind: "member", id: doBruno.id }]);
  });

  test("a Menção continua da pessoa depois que ela troca o identificador", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const canal = await canalGeral(t);
    await send(t, juliana, canal.id, "@bruno pode ver?");

    await t.as(bruno).patch("/api/me", { handle: "bl" });
    const [lida] = await (await t.as(juliana).get(`/api/channels/${canal.id}/messages`)).json();

    expect(lida.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
  });
});
