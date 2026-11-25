/**
 * A Memória do Workspace (spec #60, ticket #66; ADR 0012): o que vale em todo o Workspace. Quem a
 * escreve é o Admin, direto ou promovendo um item da Memória da Conversa de um Canal público; a
 * extração nunca guarda nela. Todo Membro a vê; escrever, promover, desfazer e corrigir é só do
 * Admin. Ela entra primeiro no resumo de toda resposta, em todo Canal e DM.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

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

async function novoCanal(t: TestApp, who: Person, name: string, kind: "public" | "private" = "public") {
  const res = await t.as(who).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return (await res.json()) as ChannelDto;
}

/** Juliana (Admin) com a Chave, o Bruno Membro e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro = await novoAgente(t, "Faro");
  const produto = await novoCanal(t, juliana, "produto");
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

async function memoriaDaConversa(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get(`/api/conversations/${conversationId}/memory`);
  expect(res.status).toBe(200);
  return res.json();
}

async function memoriaDoWorkspace(t: TestApp, who: Person): Promise<MemoryItemDto[]> {
  const res = await t.as(who).get("/api/workspace-memory");
  expect(res.status).toBe(200);
  return res.json();
}

async function escrever(t: TestApp, text: string): Promise<MemoryItemDto> {
  const res = await t.as(juliana).post("/api/workspace-memory", { text });
  expect(res.status).toBe(201);
  return res.json();
}

/** Guarda `textos` na Memória de `conversationId` pela troca de `who` com o Faro. */
async function guardarNaConversa(t: TestApp, who: Person, conversationId: string, textos: string[]) {
  const antes = await memoriaDaConversa(t, who, conversationId);
  t.anthropic.remember(operacoes(...textos.map((texto) => ({ acao: "criar", texto }))));
  await enviar(t, who, conversationId, "@faro anota isso");
  const depois = await eventually("os itens guardados", async () => {
    const itens = await memoriaDaConversa(t, who, conversationId);
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

describe("o Admin escreve na Memória do Workspace", () => {
  test("o item, sem conversa nem mensagem de origem e do Admin, chega a todo Membro na lista e pelo WebSocket", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const aba = await t.socket(bruno);

    const res = await t.as(juliana).post("/api/workspace-memory", { text: "  O reembolso sai pelo Flouz.  " });

    expect(res.status).toBe(201);
    const item: MemoryItemDto = await res.json();
    expect(item).toEqual({
      id: item.id,
      scope: "workspace",
      conversationId: null,
      origin: null,
      agent: null,
      text: "O reembolso sai pelo Flouz.",
      createdBy: "admin",
      state: "active",
      replacedById: null,
      createdAt: t.clock.now().toISOString(),
      archivedAt: null,
    });
    expect((await aba.next("memory.updated")).item).toEqual(item);
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([item]);
  });

  test("sem texto, ou com mais de 500 caracteres, é recusado", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    for (const body of [{}, { text: "   " }, { text: 3 }, { text: "x".repeat(501) }]) {
      const res = await t.as(juliana).post("/api/workspace-memory", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
    expect(await memoriaDoWorkspace(t, juliana)).toEqual([]);
  });

  test("um Membro que não é Admin vê a lista, mas não escreve (403)", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const item = await escrever(t, "O reembolso sai pelo Flouz.");

    const res = await t.as(bruno).post("/api/workspace-memory", { text: "O almoço é às 12h." });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin" });
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([item]);
  });
});

describe("a Memória do Workspace no resumo", () => {
  test("entra em toda resposta, num Canal e numa DM, antes da Memória da Conversa", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    await escrever(t, "O reembolso sai pelo Flouz.");
    await guardarNaConversa(t, juliana, produto.id, ["O preço sobe em janeiro."]);
    const dm: DmDto = await (await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id })).json();

    await enviar(t, bruno, produto.id, "@faro como sai o reembolso?");
    const noCanal = await systemDaChamada(t, 2);
    await enviar(t, bruno, dm.id, "como sai o reembolso?");
    const naDm = await systemDaChamada(t, 3);

    const posicoes = [
      noCanal.indexOf("## Memória"),
      noCanal.indexOf("Memória do Workspace"),
      noCanal.indexOf("- O reembolso sai pelo Flouz."),
      noCanal.indexOf("Memória da Conversa"),
      noCanal.indexOf("- O preço sobe em janeiro."),
      noCanal.indexOf("## Quem é quem"),
    ];
    expect(posicoes.every((p) => p >= 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
    expect(naDm).toContain("Memória do Workspace");
    expect(naDm).toContain("- O reembolso sai pelo Flouz.");
    expect(naDm).not.toContain("O preço sobe em janeiro.");
  });

  test("divide o mesmo orçamento: o Workspace entra primeiro, e a Memória da Conversa fica com o que sobra", async () => {
    // Cada linha ("- Fato do Workspace.\n") tem até 21 caracteres: cabem duas em 45.
    const t = await testApp({ memory: { summaryChars: 45 } });
    const { produto } = await produtoComFaro(t);
    await escrever(t, "Fato do Workspace.");
    await guardarNaConversa(t, juliana, produto.id, ["Fato da conversa.", "Outro da conversa."]);

    await enviar(t, bruno, produto.id, "@faro o que você sabe?");

    const system = await systemDaChamada(t, 2);
    expect(system).toContain("- Fato do Workspace.");
    expect(system).toContain("- Outro da conversa.");
    expect(system).not.toContain("- Fato da conversa.");
  });

  test("item arquivado do Workspace não entra", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const item = await escrever(t, "O reembolso sai pelo Flouz.");
    expect((await t.as(juliana).post(`/api/memory/${item.id}/undo`)).status).toBe(200);

    await enviar(t, bruno, produto.id, "@faro como sai o reembolso?");

    expect(await systemDaChamada(t, 1)).not.toContain("Flouz");
  });
});

describe("o Admin promove um item de Canal público", () => {
  test("a versão do Workspace guarda a origem, vale em toda resposta, e a da Conversa fica arquivada apontando para ela", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const vendas = await novoCanal(t, juliana, "vendas");
    await t.as(juliana).post(`/api/channels/${vendas.id}/agents`, { agentId: faro.id });
    const [item] = await guardarNaConversa(t, bruno, produto.id, ["O reembolso sai pelo Flouz."]);
    const aba = await t.socket(bruno);
    t.clock.advance(60_000);

    const res = await t.as(juliana).post(`/api/memory/${item!.id}/promote`);

    expect(res.status).toBe(201);
    const promovido: MemoryItemDto = await res.json();
    const agora = t.clock.now().toISOString();
    expect(promovido).toEqual({
      id: promovido.id,
      scope: "workspace",
      conversationId: produto.id,
      origin: item!.origin,
      agent: null,
      text: "O reembolso sai pelo Flouz.",
      createdBy: "admin",
      state: "active",
      replacedById: null,
      createdAt: agora,
      archivedAt: null,
    });
    const anterior: MemoryItemDto = { ...item!, state: "archived", replacedById: promovido.id, archivedAt: agora };
    expect((await aba.next("memory.updated")).item).toEqual(anterior);
    expect((await aba.next("memory.updated")).item).toEqual(promovido);
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([promovido]);
    // Na lista "Memória" do #produto, o item promovido aparece com o escopo do Workspace.
    expect(await memoriaDaConversa(t, bruno, produto.id)).toEqual([promovido, anterior]);

    await enviar(t, bruno, vendas.id, "@faro como sai o reembolso?");
    const emVendas = await systemDaChamada(t, 2);
    await enviar(t, bruno, produto.id, "@faro e aqui?");
    const emProduto = await systemDaChamada(t, 3);
    for (const system of [emVendas, emProduto]) {
      expect(system).toContain("Memória do Workspace");
      // Uma vez só: a da Conversa está arquivada.
      expect(system.split("- O reembolso sai pelo Flouz.").length).toBe(2);
      expect(system).not.toContain("Memória da Conversa");
    }
  });

  test("item de Canal privado ou de DM é recusado, e nada muda", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const financeiro = await novoCanal(t, juliana, "financeiro", "private");
    await t.as(juliana).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id });
    const dm: DmDto = await (await t.as(juliana).post("/api/dms", { memberIds: [], agentId: faro.id })).json();
    const [doPrivado] = await guardarNaConversa(t, juliana, financeiro.id, ["O caixa fecha dia 5."]);
    const [daDm] = await guardarNaConversa(t, juliana, dm.id, ["Prefiro respostas curtas."]);

    for (const [item, conversa] of [
      [doPrivado!, financeiro.id],
      [daDm!, dm.id],
    ] as const) {
      const res = await t.as(juliana).post(`/api/memory/${item.id}/promote`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("not_promotable");
      expect(await memoriaDaConversa(t, juliana, conversa)).toEqual([item]);
    }
    expect(await memoriaDoWorkspace(t, juliana)).toEqual([]);
  });

  test("um Membro que não é Admin não promove (403)", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaConversa(t, bruno, produto.id, ["O reembolso sai pelo Flouz."]);

    const res = await t.as(bruno).post(`/api/memory/${item!.id}/promote`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin" });
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([]);
    expect(await memoriaDaConversa(t, bruno, produto.id)).toEqual([item!]);
  });

  test("item já arquivado, item do Workspace ou que não existe não se promove", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [item] = await guardarNaConversa(t, bruno, produto.id, ["O reembolso sai pelo Flouz."]);
    expect((await t.as(juliana).post(`/api/memory/${item!.id}/undo`)).status).toBe(200);
    const doWorkspace = await escrever(t, "O almoço é às 12h.");

    const arquivado = await t.as(juliana).post(`/api/memory/${item!.id}/promote`);
    const jaNoWorkspace = await t.as(juliana).post(`/api/memory/${doWorkspace.id}/promote`);

    expect(arquivado.status).toBe(409);
    expect(await arquivado.json()).toEqual({ error: "archived" });
    expect(jaNoWorkspace.status).toBe(409);
    expect((await jaNoWorkspace.json()).error).toBe("not_promotable");
    for (const id of [crypto.randomUUID(), "nao-e-um-uuid"]) {
      expect((await t.as(juliana).post(`/api/memory/${id}/promote`)).status).toBe(404);
    }
    expect(await memoriaDoWorkspace(t, juliana)).toEqual([doWorkspace]);
  });

  test("o Admin que não participa de um Canal privado não alcança o item de lá (404)", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);
    const financeiro = await novoCanal(t, bruno, "financeiro", "private");
    await t.as(bruno).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id });
    const [item] = await guardarNaConversa(t, bruno, financeiro.id, ["O caixa fecha dia 5."]);

    const res = await t.as(juliana).post(`/api/memory/${item!.id}/promote`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("desfazer e corrigir na Memória do Workspace", () => {
  test("o Admin corrige: a versão nova, dele, substitui a anterior, que fica arquivada e aponta para ela", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const item = await escrever(t, "O reembolso sai pelo Flouz.");
    t.clock.advance(60_000);

    const res = await t.as(juliana).post(`/api/memory/${item.id}/correct`, { text: "O reembolso sai pelo Sankhya." });

    expect(res.status).toBe(201);
    const nova: MemoryItemDto = await res.json();
    const agora = t.clock.now().toISOString();
    expect(nova).toEqual({ ...item, id: nova.id, text: "O reembolso sai pelo Sankhya.", createdAt: agora });
    const anterior: MemoryItemDto = { ...item, state: "archived", replacedById: nova.id, archivedAt: agora };
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([nova, anterior]);
    await enviar(t, bruno, produto.id, "@faro como sai o reembolso?");
    const system = await systemDaChamada(t, 1);
    expect(system).toContain("- O reembolso sai pelo Sankhya.");
    expect(system).not.toContain("Flouz");
  });

  test("o Admin desfaz: o item fica arquivado", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const item = await escrever(t, "O reembolso sai pelo Flouz.");

    const res = await t.as(juliana).post(`/api/memory/${item.id}/undo`);

    expect(res.status).toBe(200);
    const desfeito: MemoryItemDto = { ...item, state: "archived", archivedAt: t.clock.now().toISOString() };
    expect(await res.json()).toEqual(desfeito);
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([desfeito]);
  });

  test("um Membro que não é Admin não desfaz nem corrige (403), e nada muda", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const item = await escrever(t, "O reembolso sai pelo Flouz.");

    const desfazer = await t.as(bruno).post(`/api/memory/${item.id}/undo`);
    const corrigir = await t.as(bruno).post(`/api/memory/${item.id}/correct`, { text: "Pelo Sankhya." });

    for (const r of [desfazer, corrigir]) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "not_admin" });
    }
    expect(await memoriaDoWorkspace(t, bruno)).toEqual([item]);
  });
});

describe("a extração nunca guarda na Memória do Workspace", () => {
  test("nem substituindo um item do Workspace que entrou na resposta, nem pedindo o escopo Workspace", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const doWorkspace = await escrever(t, "O reembolso sai pelo Flouz.");
    t.anthropic.remember(
      operacoes(
        { acao: "substituir", id: doWorkspace.id, texto: "O reembolso sai pelo Sankhya." },
        { acao: "criar", texto: "O almoço é às 12h.", escopo: "workspace" },
      ),
    );

    await enviar(t, bruno, produto.id, "@faro agora o reembolso sai pelo Sankhya, e o almoço é às 12h");

    await t.anthropic.waitForExtractions(1, 5_000);
    await t.drain();
    expect(await systemDaChamada(t, 1)).toContain("- O reembolso sai pelo Flouz.");
    expect(await memoriaDoWorkspace(t, juliana)).toEqual([doWorkspace]);
    const naConversa = await memoriaDaConversa(t, juliana, produto.id);
    expect(naConversa.every((i) => i.scope !== "workspace")).toBe(true);
  });
});
