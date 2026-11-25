/**
 * Desfazer, corrigir e substituir (spec #60, ticket #63; ADR 0012 e 0013): quem vê a conversa de
 * origem desfaz um item da Memória (ele é arquivado e sai do resumo) ou o corrige (a versão nova
 * substitui a anterior, que fica arquivada e aponta para ela). A extração recebe a Memória que
 * entrou na resposta, com os ids, e substitui um item quando uma pessoa muda um fato guardado; ela
 * nunca apaga nem arquiva sem pôr uma versão nova no lugar.
 *
 * As rotas são por item (`/api/memory/:id/undo` e `/api/memory/:id/correct`): a mesma regra vale
 * para a Memória do Agente e a do Workspace.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

/** O que a extração devolve para guardar estes textos na Memória da Conversa. */
function guardar(...textos: string[]) {
  return { json: { operacoes: textos.map((texto) => ({ acao: "criar", texto })) } };
}

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

/** Juliana (Admin) com a Chave, o Bruno Membro e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro = await novoAgente(t, "Faro");
  const res = await t.as(juliana).post("/api/channels", { name: "produto", kind: "public" });
  const produto: ChannelDto = await res.json();
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

async function memoria(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/conversations/${conversationId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Guarda `textos` pela troca de `who` com o Faro e devolve os itens novos, do mais novo ao mais velho. */
async function guardarNaMemoria(t: TestApp, who: Person, conversationId: string, textos: string[]) {
  const antes = await memoria(t, who, conversationId);
  t.anthropic.remember(guardar(...textos));
  await enviar(t, who, conversationId, "@faro anota isso");
  const depois = await eventually("os itens guardados", async () => {
    const itens = await memoria(t, who, conversationId);
    return itens.length === antes.length + textos.length ? itens : undefined;
  });
  return depois.slice(0, textos.length);
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

describe("desfazer", () => {
  test("o Bruno vê o #produto e desfaz um item: ele fica arquivado, à parte na lista, e sai do resumo", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaMemoria(t, juliana, produto.id, ["O preço sobe em janeiro."]);
    const aba = await t.socket(juliana);
    t.clock.advance(60_000);

    const res = await t.as(bruno).post(`/api/memory/${item!.id}/undo`);

    expect(res.status).toBe(200);
    const desfeito: MemoryItemDto = await res.json();
    expect(desfeito).toEqual({ ...item!, state: "archived", archivedAt: t.clock.now().toISOString() });
    expect((await aba.next("memory.updated")).item).toEqual(desfeito);
    expect(await memoria(t, bruno, produto.id)).toEqual([desfeito]);

    await enviar(t, bruno, produto.id, "@faro quando o preço sobe?");
    expect(await systemDaChamada(t, 2)).not.toContain("O preço sobe em janeiro.");
  });

  test("um item já arquivado não se desfaz de novo (409)", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaMemoria(t, juliana, produto.id, ["O preço sobe em janeiro."]);
    expect((await t.as(bruno).post(`/api/memory/${item!.id}/undo`)).status).toBe(200);

    const res = await t.as(juliana).post(`/api/memory/${item!.id}/undo`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "archived" });
  });
});

describe("corrigir", () => {
  test("o Bruno corrige um item: a versão nova, dele e com a mesma origem, substitui a anterior, que fica arquivada e aponta para ela", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaMemoria(t, juliana, produto.id, ["O preço sobe em janeiro."]);
    const aba = await t.socket(juliana);
    t.clock.advance(60_000);

    const res = await t.as(bruno).post(`/api/memory/${item!.id}/correct`, { text: "  O preço sobe em fevereiro.  " });

    expect(res.status).toBe(201);
    const nova: MemoryItemDto = await res.json();
    const agora = t.clock.now().toISOString();
    expect(nova).toEqual({
      id: nova.id,
      scope: "conversation",
      conversationId: produto.id,
      origin: item!.origin,
      agent: null,
      text: "O preço sobe em fevereiro.",
      createdBy: "member",
      state: "active",
      replacedById: null,
      createdAt: agora,
      archivedAt: null,
    });
    const anterior: MemoryItemDto = { ...item!, state: "archived", replacedById: nova.id, archivedAt: agora };
    expect(await memoria(t, bruno, produto.id)).toEqual([nova, anterior]);
    expect((await aba.next("memory.updated")).item).toEqual(anterior);
    expect((await aba.next("memory.updated")).item).toEqual(nova);

    await enviar(t, bruno, produto.id, "@faro quando o preço sobe?");
    const system = await systemDaChamada(t, 2);
    expect(system).toContain("- O preço sobe em fevereiro.");
    expect(system).not.toContain("janeiro");
  });

  test("a correção do Admin fica como do Admin", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaMemoria(t, bruno, produto.id, ["O preço sobe em janeiro."]);

    const res = await t.as(juliana).post(`/api/memory/${item!.id}/correct`, { text: "O preço sobe em março." });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ createdBy: "admin", text: "O preço sobe em março." });
  });

  test("sem texto, ou com um item já arquivado, a correção é recusada e nada muda", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaMemoria(t, juliana, produto.id, ["O preço sobe em janeiro."]);

    for (const body of [{}, { text: "   " }, { text: 42 }]) {
      const res = await t.as(bruno).post(`/api/memory/${item!.id}/correct`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    const longo = await t.as(bruno).post(`/api/memory/${item!.id}/correct`, { text: "x".repeat(501) });
    expect(longo.status).toBe(400);
    expect(await memoria(t, bruno, produto.id)).toEqual([item!]);

    await t.as(bruno).post(`/api/memory/${item!.id}/undo`);
    const arquivado = await t.as(bruno).post(`/api/memory/${item!.id}/correct`, { text: "O preço sobe em março." });
    expect(arquivado.status).toBe(409);
    expect((await memoria(t, bruno, produto.id)).map((i) => i.state)).toEqual(["archived"]);
  });
});

describe("quem não vê a conversa", () => {
  test("não desfaz nem corrige: o item do #financeiro (privado, do Bruno) dá 404 à Juliana, Admin inclusive", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const res = await t.as(bruno).post("/api/channels", { name: "financeiro", kind: "private" });
    const financeiro: ChannelDto = await res.json();
    await t.as(bruno).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id });
    const [item] = await guardarNaMemoria(t, bruno, financeiro.id, ["O reembolso sai pelo Flouz."]);

    const desfazer = await t.as(juliana).post(`/api/memory/${item!.id}/undo`);
    const corrigir = await t.as(juliana).post(`/api/memory/${item!.id}/correct`, { text: "Pelo Sankhya." });

    for (const r of [desfazer, corrigir]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
    }
    expect(await memoria(t, bruno, financeiro.id)).toEqual([item!]);
  });

  test("um item que não existe dá 404", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    for (const id of [crypto.randomUUID(), "nao-e-um-uuid"]) {
      expect((await t.as(bruno).post(`/api/memory/${id}/undo`)).status).toBe(404);
      expect((await t.as(bruno).post(`/api/memory/${id}/correct`, { text: "x" })).status).toBe(404);
    }
  });
});

describe("a extração substitui", () => {
  test('"o reembolso sai pelo Flouz" está guardado e o Bruno diz "agora sai pelo Sankhya": a extração recebe o item e o substitui, e a versão antiga fica arquivada', async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [flouz] = await guardarNaMemoria(t, juliana, produto.id, ["O reembolso sai pelo Flouz."]);
    const aba = await t.socket(juliana);
    t.anthropic.remember(operacoes({ acao: "substituir", id: flouz!.id, texto: "O reembolso sai pelo Sankhya." }));

    const origem = await enviar(t, bruno, produto.id, "@faro agora o reembolso sai pelo Sankhya");

    const extracao = (await t.anthropic.waitForExtractions(2, 5_000))[1]!;
    const entrada = extracao.body.messages.map((m) => m.content).join("\n");
    expect(entrada).toContain(`- [${flouz!.id}] O reembolso sai pelo Flouz.`);
    const antiga = (await aba.next("memory.updated")).item;
    const nova = (await aba.next("memory.updated")).item;
    // A versão nova é da extração, com a mensagem que mudou o fato: o Andamento dela mostra
    // "atualizou na Memória: …" (a web liga a nova à antiga pelo `replacedById`).
    expect(nova).toMatchObject({
      scope: "conversation",
      conversationId: produto.id,
      text: "O reembolso sai pelo Sankhya.",
      createdBy: "extraction",
      state: "active",
      origin: { messageId: origem.id, author: "Bruno" },
    });
    expect(antiga).toEqual({ ...flouz!, state: "archived", replacedById: nova.id, archivedAt: nova.createdAt });
    expect(await memoria(t, bruno, produto.id)).toEqual([nova, antiga]);
  });

  test("o schema da extração tem a operação substituir, pelo id", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    await enviar(t, juliana, produto.id, "@faro oi");
    const [extracao] = await t.anthropic.waitForExtractions(1, 5_000);
    const { schema } = (extracao!.body.output_config as { format: { schema: unknown } }).format as {
      schema: { properties: { operacoes: { items: { properties: Record<string, { enum?: string[] }> } } } };
    };
    const item = schema.properties.operacoes.items.properties;
    expect(item.acao!.enum).toEqual(["criar", "substituir"]);
    expect(Object.keys(item)).toContain("id");
    const system = typeof extracao!.body.system === "string" ? extracao!.body.system : "";
    expect(system).toContain("substituir");
  });

  test("a extração nunca apaga nem arquiva sem pôr uma versão nova no lugar", async () => {
    // Cabem duas linhas no resumo: o "Primeiro fato." fica de fora da resposta.
    const t = await testApp({ memory: { summaryChars: 40 } });
    const { faro, produto } = await produtoComFaro(t);
    const res = await t.as(juliana).post("/api/channels", { name: "geral2", kind: "public" });
    const outro: ChannelDto = await res.json();
    await t.as(juliana).post(`/api/channels/${outro.id}/agents`, { agentId: faro.id });
    const [deFora] = await guardarNaMemoria(t, juliana, outro.id, ["O almoço é às 12h."]);
    const [terceiro, , primeiro] = await guardarNaMemoria(t, juliana, produto.id, [
      "Primeiro fato.",
      "Segundo fato.",
      "Terceiro fato.",
    ]);
    const antes = await memoria(t, juliana, produto.id);
    t.anthropic.remember(
      operacoes(
        // Fora da resposta: o item que não coube no resumo e o de outra conversa.
        { acao: "substituir", id: primeiro!.id, texto: "Primeiro fato, novo." },
        { acao: "substituir", id: deFora!.id, texto: "O almoço é às 13h." },
        { acao: "substituir", id: crypto.randomUUID(), texto: "Inventado." },
        // Sem versão nova, ou pedindo para apagar ou arquivar.
        { acao: "substituir", id: terceiro!.id, texto: "   " },
        { acao: "substituir", id: terceiro!.id },
        { acao: "apagar", id: terceiro!.id },
        { acao: "arquivar", id: terceiro!.id, texto: "Terceiro fato." },
      ),
    );

    await enviar(t, bruno, produto.id, "@faro esquece tudo isso");

    await t.anthropic.waitForExtractions(3, 5_000);
    await t.drain();
    expect(await memoria(t, juliana, produto.id)).toEqual(antes);
    expect(await memoria(t, juliana, outro.id)).toEqual([deFora!]);
  });
});
