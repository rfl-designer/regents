/**
 * Extração que falha e extração sem quem pague (spec #60, ticket #64; ADR 0003 e 0013): a resposta
 * já foi entregue, então a extração que não guardou aparece no Andamento ("não guardou na Memória:
 * <motivo>") a quem vê a conversa, sem alarmar ninguém: sem push e sem "Tentar de novo". Ela
 * herda o que as execuções têm (a nova tentativa automática única, a vigia, "o servidor
 * reiniciou", o orçamento do Agente), menos a espera por quem pague: sem Conta nem Chave
 * utilizável, ela não roda e diz por quê.
 *
 * Enquanto a extração roda ou espera a nova tentativa, ela fica fora da vista (#61): a nova
 * tentativa é observada pelas chamadas que chegam aos dublês.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import type { FakeRun } from "./fake-claude/script";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const DOIS_MINUTOS = 120_000;
const LONGO = 30_000;
const SOBRECARGA = { status: 529, errorType: "overloaded_error" };

/** O que a extração devolve para guardar estes textos na Memória da Conversa. */
function guardar(...textos: string[]) {
  return { json: { operacoes: textos.map((texto) => ({ acao: "criar", texto })) } };
}

/** Juliana (Admin, com ou sem a Chave), o Faro no #produto e o Bruno lá dentro. */
async function produtoComFaro(t: TestApp, opts: { chave?: boolean } = {}) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "O Faro.",
      instructions: "Você é o Faro.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const produto: ChannelDto = await (
    await t.as(juliana).post("/api/channels", { name: "produto", kind: "public" })
  ).json();
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  await t.as(bruno).post(`/api/channels/${produto.id}/join`);
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

/** O Andamento da extração que não guardou, como chega a esta aba. */
async function naoGuardou(aba: EventSocket): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.kind === "memory") return execution;
  }
}

async function abertas(t: TestApp, who: Person, conversationId: string): Promise<ExecutionDto[]> {
  return (await t.as(who).get(`/api/conversations/${conversationId}/executions`)).json();
}

async function memoria(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  return (await t.as(who).get(`/api/conversations/${conversationId}/memory`)).json();
}

/**
 * Faz o relógio andar até a `n`-ésima chamada da extração chegar: a nova tentativa sai 10 s
 * depois da falha, e a falha fica fora da vista.
 */
async function ateAChamada(t: TestApp, n: number, chegaram: () => number) {
  await eventually(
    `a chamada ${n} da extração`,
    async () => {
      if (chegaram() >= n) return true;
      t.clock.advance(10_000);
      return undefined;
    },
    10_000,
  );
}

describe("a extração que falha", () => {
  test(
    "a extração falhou (sobrecarga): é tentada de novo uma vez sozinha e, na segunda, guarda sem que ninguém veja a falha",
    async () => {
      const t = await testApp();
      const { produto } = await produtoComFaro(t);
      const doBruno = await t.socket(bruno);
      t.anthropic.remember(SOBRECARGA, guardar("O preço sobe em janeiro."));

      const origem = await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
      await t.anthropic.waitForExtractions(1, 5_000);
      await ateAChamada(t, 2, () => t.anthropic.extractions.length);

      const { item } = await doBruno.next("memory.updated", { timeoutMs: 10_000 });
      expect(item).toMatchObject({ text: "O preço sobe em janeiro.", origin: { messageId: origem.id } });
      expect(doBruno.received().some((e) => e.type === "execution.updated" && e.execution.kind === "memory")).toBe(
        false,
      );
      expect(await abertas(t, bruno, produto.id)).toEqual([]);
      expect(t.anthropic.extractions).toHaveLength(2);
    },
    LONGO,
  );

  test(
    "falhou nas duas tentativas: quem vê a conversa vê 'não guardou na Memória' com o motivo, sem push e sem Tentar de novo",
    async () => {
      const falhas: ExecutionDto[] = [];
      const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
      const { produto } = await produtoComFaro(t);
      const doBruno = await t.socket(bruno);
      t.anthropic.remember(SOBRECARGA, SOBRECARGA);

      const origem = await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
      await t.anthropic.waitForExtractions(1, 5_000);
      await ateAChamada(t, 2, () => t.anthropic.extractions.length);

      const falha = await naoGuardou(doBruno);
      expect(falha).toMatchObject({
        kind: "memory",
        originMessageId: origem.id,
        state: "failed",
        attempt: 2,
        reason: "a Anthropic está sobrecarregada, nas duas tentativas",
      });
      expect(await abertas(t, bruno, produto.id)).toEqual([falha]);
      // Sem push: a resposta já chegou.
      expect(falhas).toEqual([]);
      // Sem "Tentar de novo": nem quem escreveu a refaz.
      const refazer = await t.as(juliana).post(`/api/conversations/${produto.id}/executions/${falha.id}/retry`);
      expect(refazer.status).toBe(409);
      expect(await refazer.json()).toEqual({ error: "not_retryable" });
      t.clock.advance(60_000);
      expect(t.anthropic.extractions).toHaveLength(2);
      expect(await memoria(t, bruno, produto.id)).toEqual([]);
    },
    LONGO,
  );
});

describe("a saída fora do formato", () => {
  test(
    "pela Chave: termina na hora em 'não guardou na Memória', com o motivo, sem nova tentativa",
    async () => {
      const t = await testApp();
      const { produto } = await produtoComFaro(t);
      const doBruno = await t.socket(bruno);
      t.anthropic.remember({ text: "Guardei que o preço sobe em janeiro." });

      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

      expect(await naoGuardou(doBruno)).toMatchObject({
        state: "failed",
        attempt: 1,
        reason: "a extração não devolveu a Memória no formato pedido",
      });
      t.clock.advance(60_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(t.anthropic.extractions).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "pela Conta (--json-schema sem structured_output): o mesmo motivo, sem nova tentativa",
    async () => {
      const t = await testApp();
      const { produto } = await produtoComFaro(t, { chave: false });
      await t.linkAccount(juliana);
      const doBruno = await t.socket(bruno);
      t.claude.script({
        runs: [{ kind: "steps", steps: [{ text: "Combinado." }] }],
        memoryRuns: [{ kind: "steps", steps: [{ text: "Guardei que o preço sobe." }], end: { result: "success" } }],
      });

      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

      expect(await naoGuardou(doBruno)).toMatchObject({
        state: "failed",
        attempt: 1,
        reason: "a extração não devolveu a Memória no formato pedido",
      });
      t.clock.advance(60_000);
      await new Promise((r) => setTimeout(r, 200));
      expect(t.claude.extractions()).toHaveLength(1);
    },
    LONGO,
  );
});

describe("a extração sem quem pague", () => {
  /** A Conta bate no limite (até as 15:45 de hoje) no meio da chamada. */
  const limite: FakeRun = {
    kind: "steps",
    steps: [
      { thinking: true },
      { rateLimit: { status: "rejected", resetsAt: Date.parse("2026-11-24T15:45:00Z") / 1000 } },
    ],
    end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
  };

  test(
    "a Conta da autora bateu no limite e não há Chave: a extração não espera na fila, termina em 'não guardou na Memória' e só ela vê o porquê da Conta",
    async () => {
      const t = await testApp();
      const { produto } = await produtoComFaro(t, { chave: false });
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana);
      const doBruno = await t.socket(bruno);
      t.claude.script({ runs: [{ kind: "steps", steps: [{ text: "Combinado." }] }], memoryRuns: [limite] });

      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

      const paraEle = await naoGuardou(doBruno);
      expect(paraEle).toMatchObject({ state: "not_acting", held: false, reason: "o Workspace não tem Chave" });
      expect(await naoGuardou(daJuliana)).toMatchObject({
        state: "not_acting",
        reason: "a sua Conta do Claude está no limite e o Workspace não tem Chave",
      });
      expect(await abertas(t, bruno, produto.id)).toEqual([paraEle]);
      // A Conta volta: a extração não sai depois (ela não esperava na fila).
      t.clock.set("2026-11-24T16:00:00.000Z");
      await new Promise((r) => setTimeout(r, 200));
      expect(t.claude.extractions()).toHaveLength(1);
      expect(await abertas(t, bruno, produto.id)).toEqual([paraEle]);
    },
    LONGO,
  );
});

describe("o custo da extração", () => {
  test(
    "pela Chave, o que a extração gasta conta no orçamento do Agente que respondeu",
    async () => {
      const t = await testApp();
      const { faro, produto } = await produtoComFaro(t);
      // A resposta de graça; a extração, 10 milhões de tokens de entrada no Haiku: US$ 1,00.
      t.anthropic.reply({ text: "Combinado.", usage: { input_tokens: 0, output_tokens: 0 } });
      t.anthropic.remember({ json: { operacoes: [] }, usage: { input_tokens: 10_000_000, output_tokens: 0 } });

      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");

      const gasto = await eventually(
        "o gasto da extração",
        async () => {
          const lista: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
          return lista.find((a) => a.id === faro.id)?.keySpendUsd || undefined;
        },
        10_000,
      );
      expect(gasto).toBe(1);
    },
    LONGO,
  );
});

describe("o reinício do servidor e a vigia", () => {
  test(
    "o servidor reiniciou no meio da extração: ela é tentada de novo sozinha e guarda",
    async () => {
      const t = await testApp();
      const { produto } = await produtoComFaro(t);
      t.anthropic.remember({ hang: true }, guardar("O preço sobe em janeiro."));
      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
      await t.anthropic.waitForExtractions(1, 5_000);

      await t.restart();
      await ateAChamada(t, 2, () => t.anthropic.extractions.length);

      const [item] = await eventually(
        "o item da segunda tentativa",
        async () => {
          const lista = await memoria(t, bruno, produto.id);
          return lista.length ? lista : undefined;
        },
        10_000,
      );
      expect(item!.text).toBe("O preço sobe em janeiro.");
      expect(await abertas(t, bruno, produto.id)).toEqual([]);
    },
    LONGO,
  );

  test(
    "o reinício pegou a segunda tentativa: 'não guardou na Memória: o servidor reiniciou', sem push",
    async () => {
      const falhas: ExecutionDto[] = [];
      const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
      const { produto } = await produtoComFaro(t);
      t.anthropic.remember(SOBRECARGA, { hang: true });
      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
      await t.anthropic.waitForExtractions(1, 5_000);
      await ateAChamada(t, 2, () => t.anthropic.extractions.length);

      await t.restart();

      const [falha] = await eventually(
        "a falha depois do reinício",
        async () => {
          const lista = await abertas(t, bruno, produto.id);
          return lista[0]?.state === "failed" ? lista : undefined;
        },
        10_000,
      );
      expect(falha).toMatchObject({ kind: "memory", attempt: 2, reason: "o servidor reiniciou" });
      expect(falhas).toEqual([]);
    },
    LONGO,
  );

  test(
    "a extração parada por 2 minutos cai na vigia, é tentada de novo e, parada de novo, não guarda",
    async () => {
      const falhas: ExecutionDto[] = [];
      const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
      const { produto } = await produtoComFaro(t);
      const doBruno = await t.socket(bruno);
      t.anthropic.remember({ hang: true }, { hang: true });
      await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
      await t.anthropic.waitForExtractions(1, 5_000);

      t.clock.advance(DOIS_MINUTOS);
      await ateAChamada(t, 2, () => t.anthropic.extractions.length);
      t.clock.advance(DOIS_MINUTOS);

      expect(await naoGuardou(doBruno)).toMatchObject({
        state: "failed",
        attempt: 2,
        reason: "ficou 2 minutos sem responder, nas duas tentativas",
      });
      expect(falhas).toEqual([]);
    },
    LONGO,
  );
});
