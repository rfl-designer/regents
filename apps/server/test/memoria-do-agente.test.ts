/**
 * A Memória do Agente na própria conversa (spec #60, ticket #65; ADR 0012 e 0013): a extração
 * separa o jeito de trabalhar (a correção que uma pessoa deu ao Agente, Memória do Agente) dos
 * fatos e das decisões (Memória da Conversa). A Memória do Agente entra no resumo das respostas
 * dele, depois da Memória da Conversa (o alcance para outras conversas, o #68, está em
 * memoria-do-agente-alcance.test.ts). A tela do Agente a lista a quem vê a origem, Admin
 * inclusive, e apagar o Agente a leva junto, deixando a Memória da Conversa que ele gerou.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/client";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const ana = { id: "1003", login: "ana@exemplo.com", name: "Ana" };

const LICAO = "Não abrir issue sem label.";
const FATO = "O repositório do app é o shearim.";

/** O que a extração devolve com estas operações, como vieram. */
function operacoes(...ops: unknown[]) {
  return { json: { operacoes: ops } };
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

async function novoCanal(t: TestApp, name: string): Promise<ChannelDto> {
  const res = await t.as(juliana).post("/api/channels", { name, kind: "public" });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana (Admin) com a Chave, o Bruno e a Ana Membros e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.addMember(ana, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro = await novoAgente(t, "Faro");
  const produto = await novoCanal(t, "produto");
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

async function memoriaDoAgente(t: TestApp, who: Person, agentId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/agents/${agentId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

async function memoriaDaConversa(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/conversations/${conversationId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * `who` corrige o Faro em `conversationId` e a extração guarda a lição na Memória do Agente e o
 * fato na Memória da Conversa. Devolve a lição como `who` a vê na tela do Agente.
 */
async function corrigirOFaro(t: TestApp, who: Person, faro: AgentDto, conversationId: string) {
  t.anthropic.remember(
    operacoes({ acao: "criar", escopo: "agente", texto: LICAO }, { acao: "criar", escopo: "conversa", texto: FATO }),
  );
  await enviar(t, who, conversationId, "@faro não abra issue sem label, e o repositório é o shearim");
  const [licao] = await eventually("a lição na Memória do Agente", async () => {
    const itens = await memoriaDoAgente(t, who, faro.id);
    return itens.length ? itens : undefined;
  });
  return licao!;
}

/** O `system` da chamada `n` (a partir de 1) a um Agente: sem o roteamento nem a extração. */
async function systemDaChamada(t: TestApp, n: number) {
  const chamadas = await eventually(`a chamada ${n} a um Agente`, async () => {
    const respostas = t.anthropic.requests.filter((r) => !r.body.output_config);
    return respostas.length >= n ? respostas : undefined;
  });
  const { system } = chamadas[n - 1]!.body;
  return typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
}

describe("a extração escolhe o escopo", () => {
  test('a correção "não abra issue sem label" vira Memória do Agente, e o fato da mesma troca vira Memória da Conversa', async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);

    const licao = await corrigirOFaro(t, bruno, faro, produto.id);

    expect(licao).toMatchObject({
      scope: "agent",
      agent: { id: faro.id, name: "Faro" },
      conversationId: produto.id,
      text: LICAO,
      createdBy: "extraction",
      state: "active",
    });
    const daConversa = await memoriaDaConversa(t, bruno, produto.id);
    expect(daConversa.filter((i) => i.scope === "conversation").map((i) => i.text)).toEqual([FATO]);
    expect(daConversa.find((i) => i.scope === "conversation")!.agent).toBeNull();
  });

  test("o pedido da extração oferece só os escopos Conversa e Agente, nunca o Workspace", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);

    await enviar(t, bruno, produto.id, "@faro oi");

    const [extracao] = await t.anthropic.waitForExtractions(1);
    const format = extracao!.body.output_config as { format: { schema: unknown } };
    const schema = format.format.schema as {
      properties: { operacoes: { items: { properties: { escopo: { enum: string[] } } } } };
    };
    expect(schema.properties.operacoes.items.properties.escopo.enum).toEqual(["conversa", "agente"]);
  });

  test("criar sem escopo fica na Memória da Conversa", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    t.anthropic.remember(operacoes({ acao: "criar", texto: FATO }));

    await enviar(t, bruno, produto.id, "@faro o repositório é o shearim");

    const [item] = await eventually("o fato guardado", async () => {
      const itens = await memoriaDaConversa(t, bruno, produto.id);
      return itens.length ? itens : undefined;
    });
    expect(item).toMatchObject({ scope: "conversation", text: FATO });
    expect(await memoriaDoAgente(t, bruno, faro.id)).toEqual([]);
  });
});

describe("a Memória do Agente no resumo", () => {
  test("entra nas próximas respostas dele na mesma conversa, depois da Memória da Conversa", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    await corrigirOFaro(t, bruno, faro, produto.id);

    await enviar(t, ana, produto.id, "@faro abre uma issue para o bug do login");

    const system = await systemDaChamada(t, 2);
    const posicoes = [
      system.indexOf("## Memória"),
      system.indexOf(`- ${FATO}`),
      system.indexOf("Memória do Agente"),
      system.indexOf(`- ${LICAO}`),
      system.indexOf("## Quem é quem"),
    ];
    expect(posicoes.every((p) => p >= 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
  });

  test("não entra nas respostas de outro Agente da mesma conversa", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const lia = await novoAgente(t, "Lia");
    await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: lia.id });
    await corrigirOFaro(t, bruno, faro, produto.id);

    await enviar(t, ana, produto.id, "@lia abre uma issue para o bug do login");

    const system = await systemDaChamada(t, 2);
    expect(system).toContain(`- ${FATO}`);
    expect(system).not.toContain(LICAO);
    expect(system).not.toContain("Memória do Agente");
  });

  test("só a lição, sem Memória da Conversa: o resumo traz só o grupo do Agente", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    t.anthropic.remember(operacoes({ acao: "criar", escopo: "agente", texto: LICAO }));
    await enviar(t, bruno, produto.id, "@faro não abra issue sem label");
    await eventually("a lição", async () => ((await memoriaDoAgente(t, bruno, faro.id)).length ? true : undefined));

    await enviar(t, ana, produto.id, "@faro abre uma issue");

    const system = await systemDaChamada(t, 2);
    expect(system).toContain("## Memória");
    expect(system).toContain(`- ${LICAO}`);
    expect(system).not.toContain("Memória da Conversa");
  });

  test("a extração da resposta seguinte recebe a lição que entrou nela, com o id, e pode substituí-la", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const licao = await corrigirOFaro(t, bruno, faro, produto.id);
    t.anthropic.remember(operacoes({ acao: "substituir", id: licao.id, texto: "Abrir issue sempre com a label bug." }));

    await enviar(t, ana, produto.id, "@faro na verdade, toda issue leva a label bug");

    const [, extracao] = await t.anthropic.waitForExtractions(2);
    const entrada = JSON.stringify(extracao!.body.messages);
    expect(entrada).toContain("## Memória do Agente");
    expect(entrada).toContain(`[${licao.id}] ${LICAO}`);
    const [nova, antiga] = await eventually("a versão nova da lição", async () => {
      const itens = await memoriaDoAgente(t, bruno, faro.id);
      return itens.length === 2 ? itens : undefined;
    });
    expect(nova).toMatchObject({ scope: "agent", agent: { id: faro.id }, text: "Abrir issue sempre com a label bug." });
    expect(antiga).toMatchObject({ id: licao.id, state: "archived", replacedById: nova!.id });
  });
});

describe("a tela do Agente", () => {
  test("lista a Memória dele só com os itens cuja origem quem olha vê: um item nascido na DM da Ana com o Faro não aparece para o Admin", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const noProduto = await corrigirOFaro(t, bruno, faro, produto.id);
    const res = await t.as(ana).post("/api/dms", { memberIds: [], agentId: faro.id });
    const dm: DmDto = await res.json();
    t.anthropic.remember(operacoes({ acao: "criar", escopo: "agente", texto: "Responder à Ana sempre em tópicos." }));
    await enviar(t, ana, dm.id, "me responde sempre em tópicos");
    const [daDm] = await eventually("a lição da DM", async () => {
      const itens = await memoriaDoAgente(t, ana, faro.id);
      return itens.length === 2 ? itens : undefined;
    });

    expect(daDm).toMatchObject({ conversationId: dm.id, text: "Responder à Ana sempre em tópicos." });
    expect(await memoriaDoAgente(t, juliana, faro.id)).toEqual([noProduto]);
    expect(await memoriaDoAgente(t, bruno, faro.id)).toEqual([noProduto]);
  });

  test("um Agente que não existe dá 404", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    expect((await t.as(juliana).get(`/api/agents/${crypto.randomUUID()}/memory`)).status).toBe(404);
    expect((await t.as(juliana).get("/api/agents/nao-e-id/memory")).status).toBe(404);
  });

  test("quem vê a origem desfaz e corrige um item da Memória do Agente; a lição desfeita sai do resumo", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const licao = await corrigirOFaro(t, bruno, faro, produto.id);

    const corrigida = await t.as(ana).post(`/api/memory/${licao.id}/correct`, { text: "Toda issue leva label." });
    expect(corrigida.status).toBe(201);
    const nova: MemoryItemDto = await corrigida.json();
    expect(nova).toMatchObject({ scope: "agent", agent: { id: faro.id, name: "Faro" }, createdBy: "member" });
    const desfeita = await t.as(ana).post(`/api/memory/${nova.id}/undo`);
    expect(desfeita.status).toBe(200);
    expect((await memoriaDoAgente(t, bruno, faro.id)).map((i) => i.state)).toEqual(["archived", "archived"]);

    await enviar(t, ana, produto.id, "@faro abre uma issue");
    const system = await systemDaChamada(t, 2);
    expect(system).not.toContain("Toda issue leva label.");
    expect(system).not.toContain(LICAO);
  });

  test("quem não vê a origem não desfaz nem corrige (404), Admin inclusive", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const res = await t.as(ana).post("/api/dms", { memberIds: [], agentId: faro.id });
    const dm: DmDto = await res.json();
    const licao = await corrigirOFaro(t, ana, faro, dm.id);

    expect((await t.as(juliana).post(`/api/memory/${licao.id}/undo`)).status).toBe(404);
    expect((await t.as(bruno).post(`/api/memory/${licao.id}/correct`, { text: "Outra." })).status).toBe(404);
    expect((await memoriaDoAgente(t, ana, faro.id)).map((i) => i.state)).toEqual(["active"]);
  });

  test("o evento memory.updated da lição vai a quem vê a origem, com o Agente", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const aba = await t.socket(ana);

    await corrigirOFaro(t, bruno, faro, produto.id);

    const eventos = [(await aba.next("memory.updated")).item, (await aba.next("memory.updated")).item];
    expect(eventos.find((i) => i.scope === "agent")).toMatchObject({ agent: { id: faro.id }, text: LICAO });
  });
});

describe("apagar o Agente", () => {
  test("só o Admin apaga (403 para o Membro); a Articuladora não se apaga; Agente que não existe dá 404", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
    const sophya = agentes.find((a) => a.builtin)!;

    const doMembro = await t.as(bruno).delete(`/api/agents/${faro.id}`);
    expect(doMembro.status).toBe(403);
    expect(await doMembro.json()).toEqual({ error: "not_admin" });
    const daArticuladora = await t.as(juliana).delete(`/api/agents/${sophya.id}`);
    expect(daArticuladora.status).toBe(403);
    expect(await daArticuladora.json()).toMatchObject({ error: "builtin_locked" });
    expect((await t.as(juliana).delete(`/api/agents/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await t.as(juliana).delete("/api/agents/nao-e-id")).status).toBe(404);
    const depois: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
    expect(depois.map((a) => a.id)).toEqual([sophya.id, faro.id]);
  });

  test("leva a Memória do Agente junto; a Memória da Conversa que ele gerou fica, e o histórico da conversa também", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    await corrigirOFaro(t, bruno, faro, produto.id);
    const aba = await t.socket(bruno);

    const res = await t.as(juliana).delete(`/api/agents/${faro.id}`);

    expect(res.status).toBe(204);
    expect((await aba.next("agent.deleted")).agentId).toBe(faro.id);
    expect((await t.as(bruno).get(`/api/agents/${faro.id}/memory`)).status).toBe(404);
    const daConversa = await memoriaDaConversa(t, bruno, produto.id);
    expect(daConversa.map((i) => [i.scope, i.text])).toEqual([["conversation", FATO]]);
    const mensagens: MessageDto[] = await (await t.as(bruno).get(`/api/conversations/${produto.id}/messages`)).json();
    expect(mensagens.map((m) => m.author.displayName)).toEqual(["Bruno", "Faro"]);
  });

  test("se a limpeza falhou depois de marcado apagado, apagar de novo leva a Memória do Agente que ficou", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    await corrigirOFaro(t, bruno, faro, produto.id);
    // O primeiro DELETE marcou o Agente e caiu antes de apagar a Memória dele.
    await t.db.update(schema.agents).set({ deletedAt: t.clock.now() }).where(eq(schema.agents.id, faro.id));

    expect((await t.as(juliana).delete(`/api/agents/${faro.id}`)).status).toBe(204);

    const daConversa = await memoriaDaConversa(t, bruno, produto.id);
    expect(daConversa.map((i) => [i.scope, i.text])).toEqual([["conversation", FATO]]);
  });

  test("ele sai da lista de Agentes e dos Canais, a Menção não o chama mais e o nome volta a ficar livre", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const aba = await t.socket(bruno);

    expect((await t.as(juliana).delete(`/api/agents/${faro.id}`)).status).toBe(204);

    const canal = (await aba.next("channel.updated")).channel;
    expect(canal.id).toBe(produto.id);
    expect(canal.participants.map((p) => p.displayName)).not.toContain("Faro");
    const agentes: AgentDto[] = await (await t.as(bruno).get("/api/agents")).json();
    expect(agentes.map((a) => a.name)).toEqual(["Sophya"]);
    await enviar(t, bruno, produto.id, "@faro você está aí?");
    const abertas = await (await t.as(bruno).get(`/api/conversations/${produto.id}/executions`)).json();
    expect(abertas).toEqual([]);
    expect((await t.as(juliana).patch(`/api/agents/${faro.id}`, { model: "claude-haiku-5-5" })).status).toBe(404);
    expect((await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id })).status).toBe(400);
    const outro = await novoAgente(t, "Faro");
    expect(outro.handle).toBe("faro");
  });

  test("o que ele tinha em andamento é cancelado, com o motivo à vista", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    t.anthropic.reply({ hang: true });
    const pergunta = await enviar(t, bruno, produto.id, "@faro qual o prazo?");
    await t.anthropic.waitForRequests(1);

    expect((await t.as(juliana).delete(`/api/agents/${faro.id}`)).status).toBe(204);

    const abertas = await (await t.as(bruno).get(`/api/conversations/${produto.id}/executions`)).json();
    expect(abertas).toMatchObject([
      { originMessageId: pergunta.id, state: "cancelled", reason: "o Agente foi apagado" },
    ]);
  });

  test("na DM com ele, a mensagem nova não fica em silêncio: o Andamento diz que o Agente foi apagado", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const dm: DmDto = await (await t.as(ana).post("/api/dms", { memberIds: [], agentId: faro.id })).json();
    expect((await t.as(juliana).delete(`/api/agents/${faro.id}`)).status).toBe(204);

    const msg = await enviar(t, ana, dm.id, "oi, Faro?");

    const [andamento] = await eventually("o Andamento da DM", async () => {
      const abertas = await (await t.as(ana).get(`/api/conversations/${dm.id}/executions`)).json();
      return abertas.length && abertas[0].state === "not_acting" ? abertas : undefined;
    });
    expect(andamento).toMatchObject({ originMessageId: msg.id, reason: "o Agente foi apagado" });
    const dms: DmDto[] = await (await t.as(ana).get("/api/dms")).json();
    expect(dms.map((d) => d.id)).toEqual([dm.id]);
    expect((await t.as(ana).post("/api/dms", { memberIds: [], agentId: faro.id })).status).toBe(400);
  });
});
