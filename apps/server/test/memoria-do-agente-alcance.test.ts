/**
 * A Memória do Agente acompanha o alcance (spec #60, ticket #68; ADR 0012): uma lição entra nas
 * respostas do Agente em qualquer conversa cujo alcance inclui a conversa de origem dela, e nunca
 * fora dele. O alcance é o mesmo das Ferramentas do Workspace (#47), calculado na hora da resposta:
 * - num Canal público, só os Canais públicos;
 * - numa DM só entre a Ana e o Agente, tudo o que a Ana vê;
 * - numa DM em grupo (ou num Canal privado), só o que todos ali veem.
 * O que está fora do alcance não chega ao modelo de jeito nenhum, nem pelo título.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, MeDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const ana = { id: "1002", login: "ana@exemplo.com", name: "Ana" };
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };

const DO_GERAL = "Responder sempre com um resumo no topo.";
const DO_FINANCEIRO = "Nunca citar o valor do contrato da Acme.";
const DA_DIRETORIA = "Tratar a fusão só pelo codinome Aurora.";

/**
 * Juliana vira Admin e grava a Chave; Ana e Bruno entram e estão no #geral. #produto é público,
 * #financeiro é privado da Ana e do Bruno, #diretoria é privado só do Bruno. O Faro está em todos.
 */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const me: Record<string, MeDto> = {};
  for (const p of [ana, bruno]) me[p.name] = await t.addMember(p, { by: juliana });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "O Faro.",
      instructions: "Você é o Faro.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  for (const p of [ana, bruno]) await t.as(p).post(`/api/channels/${geral!.id}/join`);
  const produto = await canal(t, juliana, "produto", "public");
  const financeiro = await canal(t, ana, "financeiro", "private");
  await t.as(ana).post(`/api/channels/${financeiro.id}/participants`, { memberId: me.Bruno!.id });
  const diretoria = await canal(t, bruno, "diretoria", "private");
  for (const [who, c] of [
    [juliana, geral!],
    [juliana, produto],
    [ana, financeiro],
    [bruno, diretoria],
  ] as const) {
    expect((await t.as(who).post(`/api/channels/${c.id}/agents`, { agentId: faro.id })).status).toBe(200);
  }
  return { me, faro, geral: geral!, produto, financeiro, diretoria };
}

async function canal(t: TestApp, who: Person, name: string, kind: "public" | "private"): Promise<ChannelDto> {
  const res = await t.as(who).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return res.json();
}

async function dm(t: TestApp, who: Person, input: { memberIds: string[]; agentId?: string }): Promise<DmDto> {
  const res = await t.as(who).post("/api/dms", input);
  expect(res.status).toBe(201);
  return res.json();
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function memoriaDoAgente(t: TestApp, who: Person, agentId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/agents/${agentId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

/** As chamadas de resposta de Agente (sem o roteamento da Articuladora nem a extração). */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);

/** `who` ensina ao Faro, em `conversationId`, a lição `texto`, e espera ela estar na Memória do Agente. */
async function ensinar(t: TestApp, who: Person, faro: AgentDto, conversationId: string, texto: string) {
  const antes = (await memoriaDoAgente(t, who, faro.id)).length;
  t.anthropic.remember({ json: { operacoes: [{ acao: "criar", escopo: "agente", texto }] } });
  await enviar(t, who, conversationId, `@faro daqui para a frente: ${texto}`);
  const itens = await eventually("a lição na Memória do Agente", async () => {
    const lista = await memoriaDoAgente(t, who, faro.id);
    return lista.length > antes ? lista : undefined;
  });
  return itens.find((i) => i.text === texto)!;
}

/** `who` chama o Faro em `conversationId`; devolve tudo o que chegou ao modelo nessa resposta. */
async function pedidoAoFaro(t: TestApp, who: Person, conversationId: string, body = "@faro me ajuda com isso?") {
  const antes = respostas(t).length;
  await enviar(t, who, conversationId, body);
  const chamadas = await eventually("a resposta do Faro", async () => {
    const lista = respostas(t);
    return lista.length > antes ? lista : undefined;
  });
  const pedido = chamadas[antes]!.body;
  // Espera a extração dessa resposta, para a próxima troca não cruzar com ela.
  await eventually("a resposta terminar", async () => {
    const abertas = await (await t.as(who).get(`/api/conversations/${conversationId}/executions`)).json();
    return abertas.length === 0 ? true : undefined;
  });
  return JSON.stringify({ system: pedido.system, messages: pedido.messages });
}

describe("a Memória do Agente acompanha o alcance", () => {
  test("uma lição aprendida em #geral (público) entra numa resposta do Agente em #produto (público)", async () => {
    const t = await testApp();
    const { faro, geral, produto } = await workspace(t);
    await ensinar(t, bruno, faro, geral.id, DO_GERAL);

    const pedido = await pedidoAoFaro(t, ana, produto.id);

    expect(pedido).toContain("Memória do Agente");
    expect(pedido).toContain(`- ${DO_GERAL}`);
  });

  test("uma lição aprendida em #financeiro (privado) não entra numa resposta em #geral, nem pelo título, mesmo quando o autor é de #financeiro", async () => {
    const t = await testApp();
    const { faro, geral, financeiro } = await workspace(t);
    await ensinar(t, ana, faro, financeiro.id, DO_FINANCEIRO);
    await ensinar(t, bruno, faro, geral.id, DO_GERAL);

    const pedido = await pedidoAoFaro(t, ana, geral.id);

    expect(pedido).toContain(`- ${DO_GERAL}`);
    expect(pedido).not.toContain(DO_FINANCEIRO);
    expect(pedido).not.toContain("Acme");
  });

  test("quando a Memória não cabe no resumo, a lição de #financeiro também não entra em #geral pelo título (a de #geral entra)", async () => {
    const t = await testApp({ memory: { summaryChars: 1 } });
    const { faro, geral, financeiro } = await workspace(t);
    await ensinar(t, ana, faro, financeiro.id, DO_FINANCEIRO);
    await ensinar(t, bruno, faro, geral.id, DO_GERAL);

    const pedido = await pedidoAoFaro(t, ana, geral.id);

    expect(pedido).toContain("Também na Memória, só pelo começo do texto");
    expect(pedido).toContain("Responder sempre com um resumo");
    expect(pedido).not.toContain("Nunca citar");
    expect(pedido).not.toContain("Acme");
    expect(pedido).not.toContain("e mais 1 item");
  });

  test("numa DM só entre a Ana e o Agente, entram as lições de todos os Canais que a Ana vê, e não as dos que ela não vê", async () => {
    const t = await testApp();
    const { faro, geral, financeiro, diretoria } = await workspace(t);
    await ensinar(t, bruno, faro, geral.id, DO_GERAL);
    await ensinar(t, ana, faro, financeiro.id, DO_FINANCEIRO);
    await ensinar(t, bruno, faro, diretoria.id, DA_DIRETORIA);
    const daAna = await dm(t, ana, { memberIds: [], agentId: faro.id });

    const pedido = await pedidoAoFaro(t, ana, daAna.id, "o que você lembra?");

    expect(pedido).toContain(`- ${DO_GERAL}`);
    expect(pedido).toContain(`- ${DO_FINANCEIRO}`);
    expect(pedido).not.toContain(DA_DIRETORIA);
    expect(pedido).not.toContain("Aurora");
  });

  test("numa DM em grupo (a Ana e o Bruno chamam o Agente por Menção), entra só o que todos ali veem: nem a DM só da Ana com o Agente, nem o Canal privado só do Bruno", async () => {
    const t = await testApp();
    const { me, faro, financeiro, diretoria } = await workspace(t);
    const daAna = await dm(t, ana, { memberIds: [], agentId: faro.id });
    await ensinar(t, ana, faro, daAna.id, "Chamar a Ana de Aninha.");
    await ensinar(t, ana, faro, financeiro.id, DO_FINANCEIRO);
    await ensinar(t, bruno, faro, diretoria.id, DA_DIRETORIA);
    const emGrupo = await dm(t, ana, { memberIds: [me.Bruno!.id] });

    const pedido = await pedidoAoFaro(t, ana, emGrupo.id);

    expect(pedido).toContain(`- ${DO_FINANCEIRO}`);
    expect(pedido).not.toContain("Aninha");
    expect(pedido).not.toContain(DA_DIRETORIA);
  });

  test("o alcance é calculado na hora da resposta: depois que a Ana sai de #financeiro (removida do Workspace e de volta), as lições de lá deixam de entrar na DM dela com o Agente", async () => {
    const t = await testApp();
    const { me, faro, financeiro } = await workspace(t);
    await ensinar(t, bruno, faro, financeiro.id, DO_FINANCEIRO);
    const daAna = await dm(t, ana, { memberIds: [], agentId: faro.id });
    expect(await pedidoAoFaro(t, ana, daAna.id, "o que você lembra?")).toContain(`- ${DO_FINANCEIRO}`);

    // Não há rota para sair de um Canal privado sozinho: o caminho que existe é o Admin remover a
    // Ana do Workspace e ela voltar pelo Pedido de entrada. Ela volta fora de #financeiro e com a
    // DM a dois com o Faro (member-admin.test.ts).
    expect((await t.as(juliana).delete(`/api/members/${me.Ana!.id}`)).status).toBe(204);
    await t.addMember(ana, { by: juliana });
    expect((await t.as(ana).get(`/api/channels/${financeiro.id}`)).status).toBe(404);

    const depois = await pedidoAoFaro(t, ana, daAna.id, "e agora, o que você lembra?");
    expect(depois).not.toContain(DO_FINANCEIRO);
  });

  test("uma lição de #geral substituída numa resposta em #financeiro não leva a versão nova para #geral", async () => {
    const t = await testApp();
    const { faro, geral, financeiro } = await workspace(t);
    const licao = await ensinar(t, bruno, faro, geral.id, DO_GERAL);
    const nova = "Responder com um resumo no topo e o valor da Acme no fim.";
    t.anthropic.remember({ json: { operacoes: [{ acao: "substituir", id: licao.id, texto: nova }] } });

    const emFinanceiro = await pedidoAoFaro(t, ana, financeiro.id, "@faro põe sempre o valor da Acme no fim");
    expect(emFinanceiro).toContain(`- ${DO_GERAL}`);
    await eventually("a versão nova da lição", async () =>
      (await memoriaDoAgente(t, ana, faro.id)).some((i) => i.text === nova && i.state === "active") ? true : undefined,
    );
    // Quem não vê #financeiro não vê a versão nova.
    expect((await memoriaDoAgente(t, juliana, faro.id)).map((i) => i.text)).not.toContain(nova);

    const emGeral = await pedidoAoFaro(t, bruno, geral.id);
    expect(emGeral).not.toContain("Acme");
    expect(await pedidoAoFaro(t, ana, financeiro.id)).toContain(`- ${nova}`);
  });
});
