/**
 * Memória da Conversa (spec #60, ticket #61; ADR 0012 e 0013): depois que a resposta de um Agente
 * é entregue, o Shearim lê aquela troca numa execução de extração e guarda o que uma pessoa disse
 * que vale lembrar, com a origem. Quem vê a conversa vê o item na lista "Memória" e recebe
 * `memory.updated`; o Andamento da mensagem de origem mostra "guardou na Memória: …" (o item com
 * `createdBy: "extraction"` e a mensagem de origem).
 *
 * Os dublês reconhecem a extração pelo schema (`operacoes`): `t.anthropic.remember(...)` a
 * roteiriza pela Chave, `memoryRuns` a roteiriza no `fake-claude`, e sem roteiro ela não guarda nada.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MemoryItemDto, MessageDto } from "@regents/contracts";
import { configFrom } from "../src/config";
import { DEFAULT_MEMORY_MODEL, MEMORY_SCHEMA, memoryFromEnv } from "../src/memory/extraction";
import { type ScriptedRun, scriptedBrain } from "./fakes/scripted-brain";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";

/** O que a extração devolve para guardar estes textos na Memória da Conversa. */
function guardar(...textos: string[]) {
  return { json: { operacoes: textos.map((texto) => ({ acao: "criar", texto })) } };
}

async function novoAgente(t: TestApp, name: string): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description: `O ${name}.`,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function novoCanal(t: TestApp, name: string, kind: "public" | "private" = "public"): Promise<ChannelDto> {
  const res = await t.as(juliana).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana (Admin) com a Chave, o Bruno Membro e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro = await novoAgente(t, "Faro");
  const produto = await novoCanal(t, "produto");
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string, threadRootId?: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body, threadRootId });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

/** As mensagens que a chamada levou no contexto. */
function contexto(run: ScriptedRun) {
  return run.request.messages.map((m) => m.content).join("\n");
}

async function responder(run: ScriptedRun, text: string) {
  await run.emit({ type: "text", text });
  await run.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
}

/** O próximo Andamento que satisfaz `quando`. */
async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated");
    if (quando(execution)) return execution;
  }
}

async function memoria(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/conversations/${conversationId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("a extração depois da resposta", () => {
  test("o Faro respondeu em #produto: o Shearim guarda o que a pessoa disse, com a origem, e quem vê a conversa recebe o item", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const aba = await t.socket(bruno);
    t.anthropic.reply({ text: "Combinado, aviso os clientes." });
    t.anthropic.remember(guardar("O preço sobe em janeiro."));

    const origem = await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro, avisa os clientes");

    const { item } = await aba.next("memory.updated");
    const esperado: MemoryItemDto = {
      id: item.id,
      scope: "conversation",
      conversationId: produto.id,
      origin: { messageId: origem.id, threadRootId: null, author: "Juliana", excerpt: origem.body },
      agent: null,
      text: "O preço sobe em janeiro.",
      createdBy: "extraction",
      state: "active",
      replacedById: null,
      createdAt: item.createdAt,
      archivedAt: null,
    };
    expect(item).toEqual(esperado);
    expect(await memoria(t, bruno, produto.id)).toEqual([esperado]);
    // A extração roda depois de entregue a resposta.
    const mensagens: MessageDto[] = await (await t.as(bruno).get(`/api/conversations/${produto.id}/messages`)).json();
    expect(mensagens.map((m) => m.body)).toContain("Combinado, aviso os clientes.");
  });

  test("pela Chave, a extração usa o modelo pequeno da Instalação e pede as operações em JSON", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);

    await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

    const [extracao] = await t.anthropic.waitForExtractions(1, 5_000);
    expect(extracao!.apiKey).toBe(CHAVE);
    expect(extracao!.body.model).toBe(DEFAULT_MEMORY_MODEL);
    expect(DEFAULT_MEMORY_MODEL).toBe("claude-haiku-5-5");
    expect(extracao!.body.output_config).toEqual({ format: { type: "json_schema", schema: MEMORY_SCHEMA } });
    expect(extracao!.body.tools).toBeUndefined();
  });

  test("o modelo da extração é ajustável na Instalação (SHEARIM_MEMORY_MODEL)", async () => {
    expect(memoryFromEnv(configFrom({}))).toEqual({});
    expect(memoryFromEnv(configFrom({ SHEARIM_MEMORY_MODEL: "claude-sonnet-5-5" }))).toEqual({
      model: "claude-sonnet-5-5",
    });
    expect(() => memoryFromEnv(configFrom({ SHEARIM_MEMORY_MODEL: "gpt" }))).toThrow(
      "SHEARIM_MEMORY_MODEL=gpt não é um modelo aceito",
    );

    const t = await testApp({ memory: { model: "claude-sonnet-5-5" } });
    const { produto } = await produtoComFaro(t);
    await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
    const [extracao] = await t.anthropic.waitForExtractions(1, 5_000);
    expect(extracao!.body.model).toBe("claude-sonnet-5-5");
  });

  test("pela Conta do autor, como a resposta: o claude -p leva o modelo pequeno e o --json-schema", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    await t.linkAccount(juliana);
    const aba = await t.socket(juliana);
    t.claude.script({
      runs: [{ kind: "steps", steps: [{ text: "Combinado." }] }],
      memoryRuns: [
        {
          kind: "steps",
          steps: [{ thinking: true }],
          end: { result: "success", text: "", structuredOutput: guardar("O preço sobe em janeiro.").json },
        },
      ],
    });

    const origem = await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

    const { item } = await aba.next("memory.updated", { timeoutMs: 15_000 });
    expect(item).toMatchObject({ text: "O preço sobe em janeiro.", origin: { messageId: origem.id } });
    const [extracao] = t.claude.extractions();
    const flag = (name: string) => extracao!.argv[extracao!.argv.indexOf(name) + 1];
    expect(flag("--model")).toBe(DEFAULT_MEMORY_MODEL);
    expect(JSON.parse(flag("--json-schema")!)).toEqual(MEMORY_SCHEMA);
    expect(extracao!.env.CLAUDE_CONFIG_DIR).toBe(t.claude.callsOf("-p").at(-1)!.env.CLAUDE_CONFIG_DIR);
    expect(t.anthropic.extractions).toHaveLength(0);
  });
});

describe("só o que uma pessoa disse", () => {
  test("a extração lê as mensagens de pessoa da troca e a resposta só como contexto, nunca o que outro Agente disse antes", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    t.anthropic.reply({ text: "O frete é grátis para sempre!" }, { text: "Anotado, Bruno." });
    await enviar(t, juliana, produto.id, "@faro oi");
    await t.anthropic.waitForExtractions(1, 5_000);

    await enviar(t, bruno, produto.id, "@faro o frete passa a ser cobrado em março");

    const extracao = (await t.anthropic.waitForExtractions(2, 5_000))[1]!;
    const system = typeof extracao.body.system === "string" ? extracao.body.system : "";
    expect(system).toContain("Você é a extração da Memória do Regents");
    expect(system).not.toContain("Shearim");
    expect(system).toContain("Guarde só o que uma pessoa disse");
    expect(system).toContain("nunca guarde algo só porque o Agente disse");
    const entrada = extracao.body.messages.map((m) => m.content).join("\n");
    expect(entrada).toContain("Juliana (pessoa): @faro oi");
    expect(entrada).toContain("Bruno (pessoa): @faro o frete passa a ser cobrado em março");
    expect(entrada).toContain("## A resposta de Faro (Agente), só como contexto\n\nAnotado, Bruno.");
    expect(entrada).not.toContain("grátis");
  });

  test("quando não há nada a guardar, nada é guardado e ninguém recebe item", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const aba = await t.socket(bruno);

    await enviar(t, juliana, produto.id, "@faro bom dia!");
    await t.anthropic.waitForExtractions(1, 5_000);
    // A próxima troca guarda: o primeiro item que chega é o dela.
    t.anthropic.remember(guardar("A reunião de produto é às terças."));
    await enviar(t, juliana, produto.id, "@faro a reunião de produto é às terças");

    const { item } = await aba.next("memory.updated");
    expect(item.text).toBe("A reunião de produto é às terças.");
    expect((await memoria(t, bruno, produto.id)).map((i) => i.text)).toEqual(["A reunião de produto é às terças."]);
  });
});

describe("a lista Memória da conversa", () => {
  test("o item que nasceu numa Thread fica na Memória da Conversa do Canal, com a mensagem de origem na Thread", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const raiz = await enviar(t, juliana, produto.id, "Lançamento do plano anual");
    t.anthropic.remember(guardar("O plano anual sai com 20% de desconto."));

    const naThread = await enviar(t, bruno, produto.id, "@faro o desconto do anual é 20%", raiz.id);

    const [item] = await eventually("o item da Thread", async () => {
      const lista = await memoria(t, juliana, produto.id);
      return lista.length ? lista : undefined;
    });
    expect(item).toMatchObject({
      conversationId: produto.id,
      text: "O plano anual sai com 20% de desconto.",
      origin: { messageId: naThread.id, threadRootId: raiz.id, author: "Bruno", excerpt: naThread.body },
    });
  });

  test("os itens vêm do mais novo para o mais velho", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    t.anthropic.remember(guardar("Primeiro fato.", "Segundo fato."), guardar("Terceiro fato."));
    await enviar(t, juliana, produto.id, "@faro dois fatos");
    await t.anthropic.waitForExtractions(1, 5_000);
    await enviar(t, juliana, produto.id, "@faro mais um");

    const lista = await eventually("os três itens", async () => {
      const itens = await memoria(t, juliana, produto.id);
      return itens.length === 3 ? itens : undefined;
    });
    expect(lista.map((i) => i.text)).toEqual(["Terceiro fato.", "Segundo fato.", "Primeiro fato."]);
  });

  test("num Canal privado, só quem participa vê a lista e recebe o item; os outros, Admin inclusive, recebem 404", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const faro = ((await (await t.as(juliana).get("/api/agents")).json()) as AgentDto[]).find(
      (a) => a.name === "Faro",
    )!;
    // O #financeiro é do Bruno: a Juliana (Admin) não participa.
    const res = await t.as(bruno).post("/api/channels", { name: "financeiro", kind: "private" });
    const financeiro: ChannelDto = await res.json();
    await t.as(bruno).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id });
    const abaJuliana = await t.socket(juliana);
    const abaBruno = await t.socket(bruno);
    t.anthropic.remember(guardar("O reembolso sai pelo Flouz."));

    await enviar(t, bruno, financeiro.id, "@faro o reembolso sai pelo Flouz");

    const { item } = await abaBruno.next("memory.updated");
    expect(item).toMatchObject({ conversationId: financeiro.id, text: "O reembolso sai pelo Flouz." });
    expect(await memoria(t, bruno, financeiro.id)).toEqual([item]);
    expect((await t.as(juliana).get(`/api/conversations/${financeiro.id}/memory`)).status).toBe(404);
    expect((await t.as(juliana).get(`/api/conversations/${crypto.randomUUID()}/memory`)).status).toBe(404);
    expect((await t.as(juliana).get("/api/conversations/nada/memory")).status).toBe(404);
    // O próximo item que chega à Juliana é o do #produto: o do #financeiro não chegou.
    const produto = ((await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[]).find(
      (c) => c.name === "produto",
    )!;
    t.anthropic.remember(guardar("O preço sobe em janeiro."));
    await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
    expect((await abaJuliana.next("memory.updated")).item.text).toBe("O preço sobe em janeiro.");
  });

  test("numa DM com o Agente, a lista é da DM", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const res = await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id });
    expect(res.status).toBeLessThan(300);
    const dm: { id: string } = await res.json();
    t.anthropic.remember(guardar("O Bruno prefere respostas curtas."));

    await enviar(t, bruno, dm.id, "prefiro respostas curtas");

    const [item] = await eventually("o item da DM", async () => {
      const lista = await memoria(t, bruno, dm.id);
      return lista.length ? lista : undefined;
    });
    expect(item).toMatchObject({ conversationId: dm.id, text: "O Bruno prefere respostas curtas." });
    expect((await t.as(juliana).get(`/api/conversations/${dm.id}/memory`)).status).toBe(404);
  });
});

describe("quando a extração entra na fila", () => {
  test("o roteamento (Desfecho) não põe extração na fila; a resposta que ele delega, sim", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    t.anthropic.reply(
      { json: { decisao: "nenhum", agentes: [], motivo: "Conversa entre pessoas." } },
      { json: { decisao: "delegar", agentes: [{ agente: "faro", cobrir: "o preço" }], motivo: "É com ele." } },
      { text: "O preço sobe em janeiro, Bruno." },
    );

    await enviar(t, juliana, produto.id, "Bom dia, pessoal");
    await t.anthropic.waitForRequests(1);
    await enviar(t, bruno, produto.id, "Quando sobe o preço?");

    const [extracao] = await t.anthropic.waitForExtractions(1, 5_000);
    expect(extracao!.body.messages.map((m) => m.content).join("\n")).toContain("O preço sobe em janeiro, Bruno.");
    // Uma troca a mais, de sentinela: a extração seguinte é a dela, não uma de roteamento.
    t.anthropic.reply({ text: "Sentinela." });
    await enviar(t, juliana, produto.id, "@faro sentinela");
    const extracoes = await t.anthropic.waitForExtractions(2, 5_000);
    expect(extracoes[1]!.body.messages.map((m) => m.content).join("\n")).toContain("Sentinela.");
    expect(t.anthropic.extractions).toHaveLength(2);
  });

  test("uma conversa só entre pessoas, sem resposta de Agente, não gera extração", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const social = await novoCanal(t, "social");
    await enviar(t, juliana, social.id, "Decidimos: happy hour na sexta");
    await enviar(t, bruno, social.id, "Fechado, eu levo o bolo");

    await enviar(t, juliana, produto.id, "@faro sentinela");

    const [extracao] = await t.anthropic.waitForExtractions(1, 5_000);
    expect(extracao!.body.messages.map((m) => m.content).join("\n")).toContain("@faro sentinela");
    expect(t.anthropic.extractions).toHaveLength(1);
    expect(await memoria(t, juliana, social.id)).toEqual([]);
  });
});

describe("a ordem da extração na fila", () => {
  /** Juliana com a Chave e o Faro e a Lia no #produto, pelo cérebro roteirizado. */
  async function comFaroELia(t: TestApp) {
    await t.as(juliana).get("/api/me");
    await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
    const produto = await novoCanal(t, "produto");
    for (const nome of ["Faro", "Lia"]) {
      const agente = await novoAgente(t, nome);
      await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: agente.id });
    }
    return produto;
  }

  test("a extração não segura a série do Agente: a próxima resposta dele sai enquanto ela roda", async () => {
    const cerebro = scriptedBrain({ scriptExtractions: true });
    const t = await testApp({ keyBrain: cerebro.brain });
    const produto = await comFaroELia(t);

    await enviar(t, juliana, produto.id, "@faro primeira");
    await responder(await cerebro.nextRun(), "Resposta 1.");
    const extracao = await cerebro.nextExtraction();

    await enviar(t, juliana, produto.id, "@faro segunda");

    const segunda = await cerebro.nextRun();
    expect(contexto(segunda)).toContain("@faro segunda");
    expect(extracao.signal.aborted).toBe(false);
  });

  test("na Prioridade, a extração fica abaixo das respostas, mesmo das que chegaram depois dela", async () => {
    const cerebro = scriptedBrain({ scriptExtractions: true });
    // Um lugar só na Chave: a fila anda uma de cada vez e a ordem fica à vista.
    const t = await testApp({ keyBrain: cerebro.brain, limits: { key: 1 } });
    const produto = await comFaroELia(t);
    const aba = await t.socket(juliana);

    await enviar(t, juliana, produto.id, "@faro primeira");
    const faro = await cerebro.nextRun();
    const lia = await enviar(t, juliana, produto.id, "@lia segunda");
    await andamento(aba, (e) => e.originMessageId === lia.id && e.waitingTurn);
    await responder(faro, "Resposta do Faro.");
    // Com o lugar livre, sai a resposta da Lia, que chegou antes da extração do Faro.
    const daLia = await cerebro.nextRun();
    expect(contexto(daLia)).toContain("@lia segunda");
    const terceira = await enviar(t, juliana, produto.id, "@faro terceira");
    await andamento(aba, (e) => e.originMessageId === terceira.id && e.waitingTurn);

    await responder(daLia, "Resposta da Lia.");

    // A extração do Faro chegou antes da terceira mensagem, mas a resposta passa na frente.
    const depois = await cerebro.nextRun();
    expect(contexto(depois)).toContain("@faro terceira");
    expect(cerebro.extractions).toHaveLength(0);
  });

  test("a extração vê o que outra extração guardou depois que a resposta dela começou: não duplica", async () => {
    const cerebro = scriptedBrain({ scriptExtractions: true });
    const t = await testApp({ keyBrain: cerebro.brain });
    const produto = await comFaroELia(t);

    await enviar(t, juliana, produto.id, "@faro @lia decidimos usar Postgres");
    // As duas respostas começam (e montam o contexto) antes de qualquer extração guardar.
    const primeira = await cerebro.nextRun();
    const segunda = await cerebro.nextRun();
    t.clock.advance(1_000);
    await responder(primeira, "Anotado.");
    const extracao = await cerebro.nextExtraction();
    await extracao.emit({
      type: "text",
      text: JSON.stringify({ operacoes: [{ acao: "criar", texto: "Decidimos usar Postgres." }] }),
    });
    await extracao.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
    const [item] = await eventually("o item na Memória", async () => {
      const lista = await memoria(t, juliana, produto.id);
      return lista.length ? lista : undefined;
    });

    await responder(segunda, "Anotado também.");

    const outra = await cerebro.nextExtraction();
    expect(contexto(outra)).toContain(`[${item!.id}] Decidimos usar Postgres.`);
  });
});
