/**
 * Ligar e desligar a Memória por Agente (spec #60, ticket #67): o Admin liga ou desliga a Memória
 * de cada Agente, inclusive a da Articuladora, e ela vem ligada. Desligada, as respostas do Agente
 * não põem extração na fila e não recebem o resumo de Memória; o que ele já guardou continua na
 * conversa. O que se confere é o DTO do Agente, a lista da Memória e o pedido que chega ao cérebro.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/client";
import { type ScriptedRun, scriptedBrain } from "./fakes/scripted-brain";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

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

/** Juliana (Admin) com a Chave, o Bruno Membro e o Faro no #produto. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro = await novoAgente(t, "Faro");
  const produto: ChannelDto = await (
    await t.as(juliana).post("/api/channels", { name: "produto", kind: "public" })
  ).json();
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  return { faro, produto };
}

async function agentes(t: TestApp, who: Person): Promise<AgentDto[]> {
  const res = await t.as(who).get("/api/agents");
  expect(res.status).toBe(200);
  return res.json();
}

async function memoriaDe(t: TestApp, who: Person, agentId: string, enabled: boolean) {
  return t.as(who).patch(`/api/agents/${agentId}`, { memoryEnabled: enabled });
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

/** Espera a resposta de um Agente a `origem` aparecer na conversa. */
async function respostaA(t: TestApp, conversationId: string, origem: MessageDto) {
  return eventually("a resposta do Agente", async () => {
    const res = await t.as(juliana).get(`/api/channels/${conversationId}/messages`);
    const messages = (await res.json()) as MessageDto[];
    return messages.find((m) => m.originMessageId === origem.id && m.author.kind === "agent");
  });
}

async function memoria(t: TestApp, conversationId: string): Promise<MemoryItemDto[]> {
  return (await t.as(juliana).get(`/api/conversations/${conversationId}/memory`)).json();
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

/** O texto que a extração `n` (a partir de 1) recebeu. */
function entradaDaExtracao(t: TestApp, n: number) {
  return JSON.stringify(t.anthropic.extractions[n - 1]!.body.messages);
}

describe("a Memória vem ligada", () => {
  test("um Agente novo e a Articuladora vêm com a Memória ligada, e todo Membro vê isso no DTO", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);

    expect(faro.memoryEnabled).toBe(true);
    for (const who of [juliana, bruno]) {
      const lista = await agentes(t, who);
      expect(lista.find((a) => a.builtin)?.memoryEnabled).toBe(true);
      expect(lista.find((a) => a.id === faro.id)?.memoryEnabled).toBe(true);
    }
  });
});

describe("só o Admin liga e desliga", () => {
  test("o Admin desliga a Memória do Faro e todo Membro vê no DTO que ela está desligada; ligar de novo volta", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);

    const desligou = await memoriaDe(t, juliana, faro.id, false);
    expect(desligou.status).toBe(200);
    expect(((await desligou.json()) as AgentDto).memoryEnabled).toBe(false);
    expect((await agentes(t, bruno)).find((a) => a.id === faro.id)?.memoryEnabled).toBe(false);

    await memoriaDe(t, juliana, faro.id, true);
    expect((await agentes(t, bruno)).find((a) => a.id === faro.id)?.memoryEnabled).toBe(true);
  });

  test("o Admin desliga a Memória da Articuladora", async () => {
    const t = await testApp();
    await produtoComFaro(t);
    const articuladora = (await agentes(t, juliana)).find((a) => a.builtin)!;

    const res = await memoriaDe(t, juliana, articuladora.id, false);

    expect(res.status).toBe(200);
    expect((await agentes(t, bruno)).find((a) => a.builtin)?.memoryEnabled).toBe(false);
  });

  test("um Membro não liga nem desliga (403), e a Memória fica como estava", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);

    const res = await memoriaDe(t, bruno, faro.id, false);

    expect(res.status).toBe(403);
    expect((await agentes(t, bruno)).find((a) => a.id === faro.id)?.memoryEnabled).toBe(true);
  });

  test("ligar e desligar pede sim ou não", async () => {
    const t = await testApp();
    const { faro } = await produtoComFaro(t);

    const res = await t.as(juliana).patch(`/api/agents/${faro.id}`, { memoryEnabled: "não" });

    expect(res.status).toBe(400);
    expect((await agentes(t, juliana)).find((a) => a.id === faro.id)?.memoryEnabled).toBe(true);
  });
});

describe("desligada, o Agente não guarda nem lê", () => {
  test("com a Memória do Faro desligada, a resposta dele não põe extração na fila; ligada de novo, põe", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    await memoriaDe(t, juliana, faro.id, false);

    const um = await enviar(t, bruno, produto.id, "@faro a pergunta um");
    await respostaA(t, produto.id, um);
    await memoriaDe(t, juliana, faro.id, true);
    const dois = await enviar(t, bruno, produto.id, "@faro a pergunta dois");
    await respostaA(t, produto.id, dois);
    await t.anthropic.waitForExtractions(1);

    // A extração da primeira resposta teria chegado antes, e sem a pergunta dois na troca.
    expect(t.anthropic.extractions.map((_, i) => entradaDaExtracao(t, i + 1).includes("a pergunta dois"))).toEqual([
      true,
    ]);
  });

  test("a extração que já estava na fila quando o Admin desligou a Memória do Faro não chega ao cérebro", async () => {
    const cerebro = scriptedBrain({ scriptExtractions: true });
    // Um lugar só na Chave: a extração do Faro espera enquanto a resposta da Lia roda.
    const t = await testApp({ keyBrain: cerebro.brain, limits: { key: 1 } });
    const { faro, produto } = await produtoComFaro(t);
    const lia = await novoAgente(t, "Lia");
    await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: lia.id });
    const aba = await t.socket(juliana);

    await enviar(t, juliana, produto.id, "@faro primeira");
    const doFaro = await cerebro.nextRun();
    const segunda = await enviar(t, juliana, produto.id, "@lia segunda");
    await andamento(aba, (e) => e.originMessageId === segunda.id && e.waitingTurn);
    await responder(doFaro, "Resposta do Faro.");
    const daLia = await cerebro.nextRun();
    await memoriaDe(t, juliana, faro.id, false);
    await responder(daLia, "Resposta da Lia.");

    // As extrações da conversa saem na ordem em que chegaram: a do Faro seria a primeira.
    const extracao = await cerebro.nextExtraction();
    expect(contexto(extracao)).toContain("Resposta da Lia.");
    expect(cerebro.extractions).toHaveLength(1);
  });

  test("a extração que já lia quando o Admin desligou a Memória do Faro termina sem guardar nada", async () => {
    const cerebro = scriptedBrain({ scriptExtractions: true });
    const t = await testApp({ keyBrain: cerebro.brain });
    const { faro, produto } = await produtoComFaro(t);

    await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
    await responder(await cerebro.nextRun(), "Anotado.");
    const extracao = await cerebro.nextExtraction();
    expect((await memoriaDe(t, juliana, faro.id, false)).status).toBe(200);
    await extracao.emit({
      type: "text",
      text: JSON.stringify(guardar("O preço sobe em janeiro.").json),
    });
    await extracao.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });

    const fim = await eventually("a extração terminar", async () => {
      const [row] = await t.db.select().from(schema.executions).where(eq(schema.executions.kind, "memory"));
      return row?.state === "done" ? row : undefined;
    });
    expect(fim.reason).toBeNull();
    expect(await memoria(t, produto.id)).toEqual([]);
  });

  test("com a Memória do Faro desligada, a resposta dele não recebe o resumo de Memória", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    t.anthropic.remember(guardar("O preço sobe em janeiro."));
    await enviar(t, juliana, produto.id, "@faro anota isso");
    await eventually("o item na Memória", async () => ((await memoria(t, produto.id)).length ? true : undefined));
    await memoriaDe(t, juliana, faro.id, false);

    await enviar(t, bruno, produto.id, "@faro quando o preço muda?");

    const system = await systemDaChamada(t, 2);
    expect(system).not.toContain("## Memória");
    expect(system).not.toContain("O preço sobe em janeiro.");
  });

  test("a Memória que o Faro guardou continua na lista da conversa e no resumo do Lume depois que a dele é desligada", async () => {
    const t = await testApp();
    const { faro, produto } = await produtoComFaro(t);
    const lume = await novoAgente(t, "Lume");
    await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: lume.id });
    t.anthropic.remember(guardar("O preço sobe em janeiro."));
    await enviar(t, juliana, produto.id, "@faro anota isso");
    await eventually("o item na Memória", async () => ((await memoria(t, produto.id)).length ? true : undefined));

    await memoriaDe(t, juliana, faro.id, false);
    await enviar(t, bruno, produto.id, "@lume quando o preço muda?");

    expect((await memoria(t, produto.id)).map((i) => [i.text, i.state])).toEqual([
      ["O preço sobe em janeiro.", "active"],
    ]);
    expect(await systemDaChamada(t, 2)).toContain("- O preço sobe em janeiro.");
  });
});
