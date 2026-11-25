/**
 * A Memória da Conversa entra na resposta (spec #60, ticket #62; ADR 0012): toda resposta de
 * Agente recebe no `system` um resumo da Memória da Conversa atual (com as Threads), depois das
 * Instruções do Canal e antes de "quem é quem", com a precedência dita ao modelo e um orçamento
 * fixo da Instalação. O que se confere é o pedido que chega ao cérebro.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/client";
import { memoryFromEnv } from "../src/memory/extraction";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

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

async function novoCanal(t: TestApp, name: string): Promise<ChannelDto> {
  const res = await t.as(juliana).post("/api/channels", { name, kind: "public" });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana (Admin) com a Chave, o Bruno Membro e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
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

/** Espera a Memória da Conversa ter `n` itens (do mais novo para o mais velho). */
async function memoriaCom(t: TestApp, conversationId: string, n: number): Promise<MemoryItemDto[]> {
  return eventually(`${n} item(ns) na Memória`, async () => {
    const res = await t.as(juliana).get(`/api/conversations/${conversationId}/memory`);
    const itens = (await res.json()) as MemoryItemDto[];
    return itens.filter((i) => i.state === "active").length >= n ? itens : undefined;
  });
}

/** Guarda `textos` na Memória de `conversationId` por uma troca com o Faro (a extração roteirizada). */
async function guardarNaMemoria(t: TestApp, conversationId: string, textos: string[], threadRootId?: string) {
  const antes = (await (await t.as(juliana).get(`/api/conversations/${conversationId}/memory`)).json()) as unknown[];
  t.anthropic.remember(guardar(...textos));
  // A mensagem não repete o texto: o que aparecer dele no contexto veio da Memória.
  await enviar(t, juliana, conversationId, "@faro anota isso", threadRootId);
  return memoriaCom(t, conversationId, antes.length + textos.length);
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

describe("o resumo da Memória no contexto", () => {
  test('em #produto foi guardado "o preço sobe em janeiro": a próxima resposta o recebe depois das Instruções do Canal e antes de quem é quem', async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    await t.as(juliana).patch(`/api/channel-settings/${produto.id}`, { instructions: "Aqui se fala de produto." });
    await guardarNaMemoria(t, produto.id, ["O preço sobe em janeiro."]);

    await enviar(t, bruno, produto.id, "@faro quando o preço muda?");

    const system = await systemDaChamada(t, 2);
    const posicoes = [
      system.indexOf("Aqui se fala de produto."),
      system.indexOf("## Memória"),
      system.indexOf("- O preço sobe em janeiro."),
      system.indexOf("## Quem é quem"),
    ];
    expect(posicoes.every((p) => p >= 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
  });

  test("o resumo diz ao modelo a precedência: o Contexto do Workspace, as Instruções do Canal e as instruções do Agente valem acima da Memória", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    await guardarNaMemoria(t, produto.id, ["O preço sobe em janeiro."]);

    await enviar(t, bruno, produto.id, "@faro quando o preço muda?");

    const system = await systemDaChamada(t, 2);
    expect(system).toContain(
      "O Contexto do Workspace, as Instruções do Canal e as suas instruções valem acima da Memória: quando se contradizem, siga-os.",
    );
  });

  test("um item guardado numa Thread entra nas respostas no Canal e nas outras Threads dele", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const lancamento = await enviar(t, juliana, produto.id, "Lançamento do plano anual");
    const outra = await enviar(t, juliana, produto.id, "Campanha de Natal");
    await guardarNaMemoria(t, produto.id, ["O plano anual sai com 20% de desconto."], lancamento.id);

    await enviar(t, bruno, produto.id, "@faro qual o desconto do anual?");
    const noCanal = await systemDaChamada(t, 2);
    await enviar(t, bruno, produto.id, "@faro e no Natal, o anual tem desconto?", outra.id);
    const naOutraThread = await systemDaChamada(t, 3);

    expect(noCanal).toContain("- O plano anual sai com 20% de desconto.");
    expect(naOutraThread).toContain("- O plano anual sai com 20% de desconto.");
  });

  test("a Memória de outra conversa não entra no resumo", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const vendas = await novoCanal(t, "vendas");
    await t.as(juliana).post(`/api/channels/${vendas.id}/agents`, { agentId: faro.id });
    await guardarNaMemoria(t, produto.id, ["O preço sobe em janeiro."]);

    await enviar(t, juliana, vendas.id, "@faro quando o preço muda?");

    const system = await systemDaChamada(t, 2);
    expect(system).not.toContain("O preço sobe em janeiro.");
    expect(system).not.toContain("## Memória");
  });

  test("item arquivado não entra", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const [velho] = await guardarNaMemoria(t, produto.id, ["O reembolso sai pelo Flouz."]);
    await guardarNaMemoria(t, produto.id, ["A reunião é às terças."]);
    // Ainda não há o Desfazer (#63): o item é arquivado como o Desfazer faria.
    await t.db
      .update(schema.memoryItems)
      .set({ state: "archived", archivedAt: t.clock.now() })
      .where(eq(schema.memoryItems.id, velho!.id));

    await enviar(t, bruno, produto.id, "@faro como sai o reembolso?");

    const system = await systemDaChamada(t, 3);
    expect(system).toContain("- A reunião é às terças.");
    expect(system).not.toContain("Flouz");
  });

  test("o contexto do roteamento (Desfecho) não muda: sem Memória", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    await guardarNaMemoria(t, produto.id, ["O preço sobe em janeiro."]);

    await enviar(t, bruno, produto.id, "Alguém sabe quando o preço muda?");

    const [roteamento] = await eventually("o roteamento", async () => {
      const desfechos = t.anthropic.requests.filter((r) => r.body.output_config);
      return desfechos.length ? desfechos : undefined;
    });
    expect(JSON.stringify(roteamento!.body)).not.toContain("O preço sobe em janeiro.");
    expect(JSON.stringify(roteamento!.body)).not.toContain("## Memória");
  });
});

describe("o orçamento do resumo", () => {
  test("é ajustável na Instalação (SHEARIM_MEMORY_SUMMARY_CHARS)", () => {
    expect(memoryFromEnv({})).toEqual({});
    expect(memoryFromEnv({ SHEARIM_MEMORY_SUMMARY_CHARS: "1500" })).toEqual({ summaryChars: 1500 });
    for (const errado of ["0", "-3", "1.5", "muito"]) {
      expect(() => memoryFromEnv({ SHEARIM_MEMORY_SUMMARY_CHARS: errado })).toThrow(
        `SHEARIM_MEMORY_SUMMARY_CHARS=${errado} não é um número inteiro maior que zero.`,
      );
    }
  });

  test("passando dele, entram os itens mais recentes e o resto fica de fora", async () => {
    // Cada linha ("- Primeiro fato.\n") tem até 17 caracteres: cabem duas.
    const t = await testApp({ memory: { summaryChars: 40 } });
    const { produto } = await produtoComFaro(t);
    await guardarNaMemoria(t, produto.id, ["Primeiro fato.", "Segundo fato.", "Terceiro fato."]);

    await enviar(t, bruno, produto.id, "@faro o que você sabe?");

    const system = await systemDaChamada(t, 2);
    expect(system).toContain("- Segundo fato.\n- Terceiro fato.");
    expect(system).not.toContain("Primeiro fato.");
  });

  test("a resposta guarda os itens que entraram nela, e a extração dela recebe só esses", async () => {
    const t = await testApp({ memory: { summaryChars: 40 } });
    const { produto } = await produtoComFaro(t);
    const [terceiro, segundo, primeiro] = await guardarNaMemoria(t, produto.id, [
      "Primeiro fato.",
      "Segundo fato.",
      "Terceiro fato.",
    ]);

    await enviar(t, bruno, produto.id, "@faro o que você sabe?");

    const extracao = (await t.anthropic.waitForExtractions(2, 5_000))[1]!;
    const entrada = extracao.body.messages.map((m) => m.content).join("\n");
    expect(entrada).toContain(`- [${segundo!.id}] Segundo fato.\n- [${terceiro!.id}] Terceiro fato.`);
    expect(entrada).not.toContain(primeiro!.id);
  });
});
