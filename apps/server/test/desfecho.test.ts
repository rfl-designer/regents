import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto, OutcomeDto } from "@shearim/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";

/** O que o roteamento da Articuladora devolve (o contrato de roteamento, em JSON). */
function desfecho(decisao: "responder" | "delegar" | "nenhum", motivo: string, agentes: [string, string][] = []) {
  return { json: { decisao, agentes: agentes.map(([agente, cobrir]) => ({ agente, cobrir })), motivo } };
}

async function novoAgente(t: TestApp, name: string, description = ""): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana (Admin) com a Chave e o Faro no #geral. Devolve também a Articuladora. */
async function canalComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro = await novoAgente(t, "Faro", "Comercial: propostas e preços.");
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  const sophya = ((await (await t.as(juliana).get("/api/agents")).json()) as AgentDto[]).find((a) => a.builtin)!;
  return { faro, sophya, geral: geral! };
}

async function enviar(t: TestApp, who: Person, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** O `system` e a conversa da chamada `n` (a partir de 1) que chegou à Messages API falsa. */
async function chamada(t: TestApp, n: number) {
  const body = (await t.anthropic.waitForRequests(n))[n - 1]!.body;
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n");
  const conversa = body.messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")))
    .join("\n");
  return { body, system, conversa };
}

describe("o Desfecho nenhum", () => {
  test("num Canal com outros Agentes, a mensagem sem Menção recebe o Desfecho nenhum, com o motivo, e ninguém responde", async () => {
    const t = await testApp();
    const { sophya, geral } = await canalComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply(desfecho("nenhum", "É conversa entre pessoas."));

    const origem = await enviar(t, juliana, geral.id, "Bom dia, pessoal!");

    const { outcome } = await aba.next("outcome.created");
    const esperado: OutcomeDto = {
      messageId: origem.id,
      channelId: geral.id,
      decision: "none",
      reason: "É conversa entre pessoas.",
      by: { id: sophya.id, displayName: "Sophya" },
      delegates: [],
    };
    expect(outcome).toEqual(esperado);
    expect(await (await t.as(juliana).get(`/api/conversations/${geral.id}/outcomes`)).json()).toEqual([esperado]);
    await eventually("o roteamento terminar", async () => {
      const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return abertas.length === 0 || undefined;
    });
    expect(t.anthropic.requests).toHaveLength(1);
    const mensagens: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(mensagens).toEqual([origem]);
  });

  test('enquanto o roteamento roda, o Andamento é "Sophya decidindo", pela Articuladora', async () => {
    const t = await testApp();
    const { sophya, geral } = await canalComFaro(t);
    t.anthropic.reply({ hang: true });

    const origem = await enviar(t, juliana, geral.id, "Alguém sabe do prazo?");
    await t.anthropic.waitForRequests(1);

    const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    expect(abertas).toMatchObject([
      {
        originMessageId: origem.id,
        agent: { id: sophya.id, displayName: "Sophya" },
        state: "running",
        step: "deciding",
      },
    ]);
  });

  test("o roteamento usa o modelo barato fixo, pede o contrato em JSON e recebe a mensagem, poucas anteriores, as Instruções do Canal e os Agentes do Canal", async () => {
    const t = await testApp();
    const { geral } = await canalComFaro(t);
    await t.as(juliana).patch(`/api/channel-settings/${geral.id}`, { instructions: "Aqui se fala de vendas." });
    t.anthropic.reply(desfecho("nenhum", "Ok."), desfecho("nenhum", "Ok."));
    await enviar(t, juliana, geral.id, "A proposta da Acme vence sexta.");
    await t.anthropic.waitForRequests(1);

    await enviar(t, juliana, geral.id, "Alguém revisa o preço?");

    const { body, system, conversa } = await chamada(t, 2);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toMatchObject({ format: { type: "json_schema" } });
    expect(JSON.stringify(body.output_config)).toContain("responder");
    expect(system).toContain("Aqui se fala de vendas.");
    expect(system).toContain("@faro");
    expect(system).toContain("Comercial: propostas e preços.");
    expect(system).toContain("Na dúvida entre responder e nenhum");
    expect(conversa).toContain("Juliana (pessoa): A proposta da Acme vence sexta.");
    expect(conversa).toContain("Juliana (pessoa): Alguém revisa o preço?");
  });

  test("a Articuladora só conhece os Canais que o autor pode ver", async () => {
    const t = await testApp();
    const { geral } = await canalComFaro(t);
    await t.addMember(bruno, { by: juliana });
    await t.as(juliana).post("/api/channels", { name: "diretoria-secreta", kind: "private" });
    const doBruno: ChannelDto = await (
      await t.as(bruno).post("/api/channels", { name: "obras", kind: "private" })
    ).json();
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    expect(doBruno.name).toBe("obras");

    await enviar(t, bruno, geral.id, "Quem cuida das obras?");

    const { system } = await chamada(t, 1);
    expect(system).toContain("#geral");
    expect(system).toContain("#obras");
    expect(system).not.toContain("diretoria-secreta");
  });
});

/** Faro e Prisma no #geral, e o Lince no Workspace, fora do Canal. */
async function canalComFaroEPrisma(t: TestApp) {
  const base = await canalComFaro(t);
  const prisma = await novoAgente(t, "Prisma", "Design e marca.");
  const lince = await novoAgente(t, "Lince", "Pesquisa de mercado.");
  await t.as(juliana).post(`/api/channels/${base.geral.id}/agents`, { agentId: prisma.id });
  return { ...base, prisma, lince };
}

describe("o Desfecho delegar", () => {
  test("a Articuladora passa para até 2 Agentes do Canal; cada um responde ancorado, com a frase do que cobrir", async () => {
    const t = await testApp();
    const { sophya, faro, prisma, geral } = await canalComFaroEPrisma(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply(
      desfecho("delegar", "Tem preço e tem visual.", [
        ["faro", "O preço da proposta."],
        ["@Prisma", "O visual da capa."],
      ]),
      { text: "Fica em R$ 10 mil." },
      { text: "A capa vai em azul." },
    );

    const origem = await enviar(t, juliana, geral.id, "Como fica a proposta da Acme?");

    const { outcome } = await aba.next("outcome.created");
    expect(outcome).toEqual({
      messageId: origem.id,
      channelId: geral.id,
      decision: "delegate",
      reason: "Tem preço e tem visual.",
      by: { id: sophya.id, displayName: "Sophya" },
      delegates: [
        { agent: { id: faro.id, displayName: "Faro" }, cover: "O preço da proposta." },
        { agent: { id: prisma.id, displayName: "Prisma" }, cover: "O visual da capa." },
      ],
    });
    const respostas = await eventually("os dois delegados responderem", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      const ancoradas = lista.filter((m) => m.originMessageId === origem.id);
      return ancoradas.length === 2 ? ancoradas : undefined;
    });
    expect(respostas.map((m) => [m.author.displayName, m.body])).toEqual([
      ["Faro", "Fica em R$ 10 mil."],
      ["Prisma", "A capa vai em azul."],
    ]);

    const doFaro = await chamada(t, 2);
    expect(doFaro.body.model).toBe("claude-sonnet-5-5");
    expect(doFaro.system).toContain("Você é o Faro.");
    expect(doFaro.system).toContain("Sophya, a Articuladora, passou para você a mensagem de Juliana no Canal #geral.");
    expect(doFaro.system).toContain("Cubra isto: O preço da proposta.");
    expect((await chamada(t, 3)).system).toContain("Cubra isto: O visual da capa.");
  });

  test("os delegados entram juntos na fila, assim que sai o Desfecho", async () => {
    const t = await testApp();
    const { faro, prisma, geral } = await canalComFaroEPrisma(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply(
      desfecho("delegar", "Os dois.", [
        ["faro", "Preço."],
        ["prisma", "Visual."],
      ]),
      { hang: true },
    );

    const origem = await enviar(t, juliana, geral.id, "Proposta da Acme?");
    await aba.next("outcome.created");
    await t.anthropic.waitForRequests(2);

    const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
    expect(abertas.map((e) => [e.agent.id, e.originMessageId])).toEqual([
      [faro.id, origem.id],
      [prisma.id, origem.id],
    ]);
  });

  test("ela só delega a Agentes do Canal, e a no máximo 2: quem está fora sai da lista", async () => {
    const t = await testApp();
    const { faro, prisma, geral } = await canalComFaroEPrisma(t);
    const terceiro = await novoAgente(t, "Tico", "Contas.");
    await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: terceiro.id });
    const aba = await t.socket(juliana);
    t.anthropic.reply(
      desfecho("delegar", "Vários.", [
        ["lince", "Fora do Canal."],
        ["faro", "Preço."],
        ["prisma", "Visual."],
        ["tico", "Contas."],
      ]),
    );

    await enviar(t, juliana, geral.id, "Todo mundo opina?");

    const { outcome } = await aba.next("outcome.created");
    expect(outcome.delegates.map((d) => d.agent.id)).toEqual([faro.id, prisma.id]);
  });

  test("um Desfecho que não dá para entender vira falha visível da Articuladora", async () => {
    const t = await testApp();
    const { sophya, geral } = await canalComFaroEPrisma(t);
    t.anthropic.reply(desfecho("delegar", "Para o Lince.", [["lince", "Pesquisa."]]), { text: "isto não é JSON" });

    const primeira = await enviar(t, juliana, geral.id, "Pesquisa de mercado?");
    const segunda = await enviar(t, juliana, geral.id, "E agora?");

    const falhas = await eventually("as duas falharem", async () => {
      const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return abertas.filter((e) => e.state === "failed").length === 2 ? abertas : undefined;
    });
    expect(falhas).toMatchObject([
      {
        originMessageId: primeira.id,
        agent: { id: sophya.id },
        reason: "a Articuladora não devolveu um Desfecho válido",
      },
      {
        originMessageId: segunda.id,
        agent: { id: sophya.id },
        reason: "a Articuladora não devolveu um Desfecho válido",
      },
    ]);
    expect(await (await t.as(juliana).get(`/api/conversations/${geral.id}/outcomes`)).json()).toEqual([]);
  });
});

describe("o Desfecho responder", () => {
  test("a Articuladora responde ela mesma, numa segunda chamada com o modelo dela e o contexto completo", async () => {
    const t = await testApp();
    const { sophya, geral } = await canalComFaroEPrisma(t);
    await t.as(juliana).patch(`/api/agents/${sophya.id}`, { model: "claude-opus-5-5" });
    await t.as(juliana).put("/api/workspace-context", { context: "Somos a Acme." });
    const aba = await t.socket(juliana);
    t.anthropic.reply(desfecho("responder", "É sobre o time."), { text: "O Faro cuida de preço." });

    const origem = await enviar(t, juliana, geral.id, "Quem cuida do quê aqui?");

    expect((await aba.next("outcome.created")).outcome).toMatchObject({ decision: "reply", delegates: [] });
    const resposta = await eventually("a Articuladora responder", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(resposta).toMatchObject({ body: "O Faro cuida de preço.", author: { kind: "agent", id: sophya.id } });
    const { body, system, conversa } = await chamada(t, 2);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toBeUndefined();
    expect(system).toContain("Você é Sophya, um Agente do Shearim");
    expect(system).toContain("Você é a Articuladora do Workspace");
    expect(system).toContain(
      "Você decidiu responder você mesma à mensagem de Juliana no Canal #geral. Por quê: É sobre o time.",
    );
    expect(system).toContain("Somos a Acme.");
    expect(system).toContain("- Faro: Comercial: propostas e preços.");
    expect(conversa).toContain("Juliana (pessoa): Quem cuida do quê aqui?");
  });

  test("para sugerir em texto um Agente de fora do Canal, ela o conhece, mas só pelos Canais que o autor vê", async () => {
    const t = await testApp();
    const { lince, geral } = await canalComFaroEPrisma(t);
    await t.addMember(bruno, { by: juliana });
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    const pesquisa: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "pesquisa", kind: "public" })
    ).json();
    const segredo: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "segredo-da-diretoria", kind: "private" })
    ).json();
    await t.as(juliana).post(`/api/channels/${pesquisa.id}/agents`, { agentId: lince.id });
    await t.as(juliana).post(`/api/channels/${segredo.id}/agents`, { agentId: lince.id });
    t.anthropic.reply(desfecho("responder", "O Lince, de fora, serve melhor."), { text: "Chame o @lince." });

    await enviar(t, bruno, geral.id, "Alguém faz pesquisa de mercado?");

    const roteamento = await chamada(t, 1);
    const resposta = await chamada(t, 2);
    for (const { system } of [roteamento, resposta]) {
      expect(system).toContain("@lince (Lince): Pesquisa de mercado. · está em #pesquisa");
      expect(system).not.toContain("segredo-da-diretoria");
    }
    const sugestao = await eventually("a sugestão sair em texto", async () => {
      const lista: MessageDto[] = await (await t.as(bruno).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.author.kind === "agent");
    });
    // A sugestão é só texto: a Menção escrita pela Articuladora não chama o Lince.
    expect(sugestao.body).toBe("Chame o @lince.");
    await t.anthropic.waitForRequests(2);
    expect(await (await t.as(bruno).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([]);
    expect(t.anthropic.requests).toHaveLength(2);
  });
});

describe("a Menção pula o roteamento", () => {
  test("com Menção, todos os mencionados respondem direto, sem Desfecho, inclusive @Sophya", async () => {
    const t = await testApp();
    const { sophya, faro, geral } = await canalComFaroEPrisma(t);
    t.anthropic.reply({ text: "Sou a Sophya." }, { text: "Sou o Faro." });

    const origem = await enviar(t, juliana, geral.id, "@Sophya e @faro, vocês estão aí?");

    const respostas = await eventually("os dois mencionados responderem", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      const ancoradas = lista.filter((m) => m.originMessageId === origem.id);
      return ancoradas.length === 2 ? ancoradas : undefined;
    });
    expect(respostas.map((m) => m.author.id)).toEqual([sophya.id, faro.id]);
    const [daSophya, doFaro] = [await chamada(t, 1), await chamada(t, 2)];
    expect(daSophya.body.output_config).toBeUndefined();
    expect(daSophya.system).toContain("Juliana chamou você com uma Menção no Canal #geral.");
    expect(doFaro.system).toContain("Você é o Faro.");
    expect(t.anthropic.requests).toHaveLength(2);
    expect(await (await t.as(juliana).get(`/api/conversations/${geral.id}/outcomes`)).json()).toEqual([]);
  });

  test("uma Menção escrita por um Agente não faz outro Agente agir", async () => {
    const t = await testApp();
    const { geral } = await canalComFaroEPrisma(t);
    t.anthropic.reply(desfecho("responder", "Pergunta geral."), { text: "Pergunte ao @faro e ao @prisma." });

    const origem = await enviar(t, juliana, geral.id, "Por onde começo?");

    await eventually("a Articuladora responder", async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    });
    expect(await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).toEqual([]);
    expect(t.anthropic.requests).toHaveLength(2);
  });
});

describe("um Canal só com a Articuladora", () => {
  test("não tem Desfecho: sem Menção, ninguém age e nada é gasto", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    const aba = await t.socket(juliana);

    await enviar(t, juliana, geral!.id, "Bom dia!");
    // Prova de que nada saiu: o próximo evento é o da segunda mensagem, já com Menção.
    const comMencao = await enviar(t, juliana, geral!.id, "@sophya bom dia!");

    await aba.next("message.created");
    await aba.next("message.created");
    expect((await aba.next("execution.updated")).execution).toMatchObject({ originMessageId: comMencao.id });
    await t.anthropic.waitForRequests(1);
    expect(t.anthropic.requests).toHaveLength(1);
    expect(t.anthropic.requests[0]!.body.output_config).toBeUndefined();
    expect(await (await t.as(juliana).get(`/api/conversations/${geral!.id}/outcomes`)).json()).toEqual([]);
  });

  test("sem a Chave, o roteamento também não age: a mensagem mostra Agentes não agem", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const faro = await novoAgente(t, "Faro");
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
    const aba = await t.socket(juliana);

    await enviar(t, juliana, geral!.id, "Alguém aí?");

    await aba.next("execution.updated");
    const aviso = (await aba.next("execution.updated")).execution;
    expect(aviso).toMatchObject({
      state: "not_acting",
      reason: "o Workspace não tem Chave",
      agent: { displayName: "Sophya" },
    });
    expect(t.anthropic.requests).toHaveLength(0);
  });
});
