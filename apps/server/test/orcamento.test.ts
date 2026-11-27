/**
 * Chave e orçamentos (Spec, módulo 9; histórias 47, 48, 51 e 52), pela borda do servidor.
 *
 * - O Admin define o orçamento mensal de cada Agente (inclusive da Articuladora) e vê o gasto
 *   de cada um na Chave no mês. O gasto conta só o que a Chave pagou.
 * - O orçamento é conferido antes de cada execução pela Chave; a que já roda termina. Estourado,
 *   o Agente deixa de usar a Chave (mas segue respondendo a quem tem Conta) e os Admins veem a
 *   faixa. O gancho do push (#34) roda no máximo uma vez por Agente por mês.
 * - Com `authentication_error` ou `billing_error` na Chave, abre um incidente: os Admins veem a
 *   faixa, um por incidente, até a primeira chamada bem-sucedida.
 */
import { describe, expect, test } from "bun:test";
import type { AgentBudgetDto, AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@regents/contracts";
import { keyCoverage } from "../src/key-budget";
import { scriptedBrain } from "./fakes/scripted-brain";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;
/** No Sonnet (US$ 2 / US$ 10 por milhão), US$ 2,00 exatos. */
const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };

/** Juliana vira Admin, grava a Chave, cria o Faro (com `orcamento`) e o põe no #geral; Bruno entra. */
async function workspace(t: TestApp, opts: { orcamento?: number | null } = {}) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const criado = await t.as(juliana).post("/api/agents", {
    name: "Faro",
    photo: null,
    description: "Comercial.",
    instructions: "Você é o Faro, do comercial.",
    model: "claude-sonnet-5-5",
    ...(opts.orcamento !== undefined ? { monthlyBudgetUsd: opts.orcamento } : {}),
  });
  expect(criado.status).toBe(201);
  const faro: AgentDto = await criado.json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${channelId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
  );
}

async function agente(t: TestApp, id: string, who = juliana): Promise<AgentDto> {
  const lista: AgentDto[] = await (await t.as(who).get("/api/agents")).json();
  return lista.find((a) => a.id === id)!;
}

describe("orçamento e gasto na Chave", () => {
  test(
    "o Admin define o orçamento do Agente e vê o gasto do mês na Chave; quem não é Admin não vê nada disso",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t, { orcamento: 5 });
      expect(faro).toMatchObject({ monthlyBudgetUsd: 5, keySpendUsd: 0, overBudget: false });
      const paraBruno = await agente(t, faro.id, bruno);
      expect(paraBruno).not.toHaveProperty("monthlyBudgetUsd");
      expect(paraBruno).not.toHaveProperty("keySpendUsd");

      t.anthropic.reply({ text: "Pela Chave.", usage: DOIS_DOLARES });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro qual o prazo?"));

      expect(await agente(t, faro.id)).toMatchObject({ monthlyBudgetUsd: 5, keySpendUsd: 2, overBudget: false });

      const editado = await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 10 });
      expect(await editado.json()).toMatchObject({ monthlyBudgetUsd: 10, keySpendUsd: 2 });
      for (const ruim of [-1, "dez", true]) {
        expect((await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: ruim })).status).toBe(400);
      }
      expect((await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: null })).status).toBe(200);
      expect(await agente(t, faro.id)).toMatchObject({ monthlyBudgetUsd: null, keySpendUsd: 2 });

      // O mês vira (dezembro): o gasto recomeça do zero.
      t.clock.set("2026-12-01T00:00:00.000Z");
      expect((await agente(t, faro.id)).keySpendUsd).toBe(0);
    },
    LONGO,
  );
});

/** O próximo `key_incident.updated` que chega a esta aba. */
async function incidente(aba: EventSocket) {
  return (await aba.next("key_incident.updated", ESPERA)).incident;
}

async function fim(aba: EventSocket, origem: MessageDto): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (execution.originMessageId === origem.id && ["done", "failed", "not_acting"].includes(execution.state)) {
      return execution;
    }
  }
}

describe("incidente da Chave", () => {
  test(
    "a Chave recusada abre um incidente só para os Admins, um por vez, encerrado na primeira chamada bem-sucedida",
    async () => {
      const abertos: unknown[] = [];
      const t = await testApp({ hooks: { keyIncidentOpened: (incident) => abertos.push(incident) } });
      const { geral } = await workspace(t);
      const daJuliana = await t.socket(juliana, "aba da Juliana (Admin)");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.anthropic.reply(
        { status: 401, errorType: "authentication_error", errorMessage: "invalid x-api-key" },
        { status: 402, errorType: "billing_error", errorMessage: "credit balance too low" },
        { text: "Voltei." },
        { status: 402, errorType: "billing_error", errorMessage: "credit balance too low" },
      );

      const primeira = await enviar(t, geral.id, "@Faro um");
      expect((await fim(doBruno, primeira)).state).toBe("failed");
      const aberto = await incidente(daJuliana);
      expect(aberto).toMatchObject({ kind: "auth_failed", openedAt: "2026-11-24T12:00:00.000Z" });
      expect((await (await t.as(juliana).get("/api/workspace-key")).json()).incident).toEqual(aberto);
      expect(abertos).toEqual([aberto]);

      // Outra recusa com o incidente aberto não abre outro.
      const segunda = await enviar(t, geral.id, "@Faro dois");
      expect((await fim(doBruno, segunda)).state).toBe("failed");
      expect(abertos).toHaveLength(1);

      // A primeira chamada bem-sucedida pela Chave encerra o incidente.
      const terceira = await enviar(t, geral.id, "@Faro três");
      expect((await fim(doBruno, terceira)).state).toBe("done");
      expect(await incidente(daJuliana)).toBeNull();
      expect((await (await t.as(juliana).get("/api/workspace-key")).json()).incident).toBeNull();

      // Sem crédito depois disso é um incidente novo.
      const quarta = await enviar(t, geral.id, "@Faro quatro");
      expect((await fim(doBruno, quarta)).state).toBe("failed");
      const novo = await incidente(daJuliana);
      expect(novo).toMatchObject({ kind: "billing_failed" });
      expect(novo!.id).not.toBe(aberto!.id);
      expect(abertos).toHaveLength(2);

      expect(doBruno.received().some((e) => e.type === "key_incident.updated")).toBe(false);
    },
    LONGO,
  );
});

describe("estouro de orçamento", () => {
  test(
    "estourado, o Agente deixa de usar a Chave e os Admins veem a faixa; o gancho do push roda uma vez por mês",
    async () => {
      const estouros: AgentBudgetDto[] = [];
      const t = await testApp({ hooks: { budgetExceeded: (budget) => estouros.push(budget) } });
      const { faro, geral } = await workspace(t, { orcamento: 3 });
      const daJuliana = await t.socket(juliana, "aba da Juliana (Admin)");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      // A extração da Memória também passa pela Chave (de graça, no falso): o orçamento que ela
      // anuncia é o mesmo, e aqui conta o próximo que mudou.
      let visto: AgentBudgetDto | undefined;
      const orcamento = async () => {
        for (;;) {
          const { budget } = await daJuliana.next("agent_budget.updated", ESPERA);
          if (Bun.deepEquals(budget, visto)) continue;
          visto = budget;
          return budget;
        }
      };
      t.anthropic.reply({ text: "Um.", usage: DOIS_DOLARES }, { text: "Dois.", usage: DOIS_DOLARES });

      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro um"))).state).toBe("done");
      expect(await orcamento()).toEqual({
        agentId: faro.id,
        name: "Faro",
        monthlyBudgetUsd: 3,
        keySpendUsd: 2,
        overBudget: false,
      });
      // Ainda havia orçamento quando a segunda começou: ela sai, e o estouro aparece depois dela.
      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro dois"))).state).toBe("done");
      expect(await orcamento()).toMatchObject({ keySpendUsd: 4, overBudget: true });
      expect(estouros).toEqual([expect.objectContaining({ agentId: faro.id, overBudget: true })]);
      expect(await agente(t, faro.id)).toMatchObject({ keySpendUsd: 4, overBudget: true });

      const terceira = await fim(doBruno, await enviar(t, geral.id, "@Faro três"));
      expect(terceira).toMatchObject({ state: "not_acting", reason: "Faro estourou o orçamento do mês na Chave" });
      expect(t.anthropic.requests).toHaveLength(2);

      // O Admin aumenta o orçamento: a faixa some e o Faro volta a usar a Chave.
      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 10 });
      expect(await orcamento()).toMatchObject({ monthlyBudgetUsd: 10, overBudget: false });
      t.anthropic.reply({ text: "Quatro.", usage: DOIS_DOLARES });
      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro quatro"))).state).toBe("done");

      // Estourar de novo no mesmo mês não chama o gancho outra vez.
      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 5 });
      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro cinco"))).state).toBe("not_acting");
      expect(estouros).toHaveLength(1);
      expect(doBruno.received().some((e) => e.type === "agent_budget.updated")).toBe(false);

      // No mês seguinte, o gasto recomeça e o Faro responde pela Chave.
      t.clock.set("2026-12-01T00:00:00.000Z");
      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro seis"))).state).toBe("done");
    },
    LONGO,
  );
});

describe("a Articuladora", () => {
  test(
    "o orçamento dela conta o roteamento e as respostas; estourado, não sai Desfecho e a mensagem mostra o aviso",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const sophya = ((await (await t.as(juliana).get("/api/agents")).json()) as AgentDto[]).find((a) => a.builtin)!;
      await t.as(juliana).patch(`/api/agents/${sophya.id}`, { model: "claude-sonnet-5-5", monthlyBudgetUsd: 3 });
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.anthropic.reply(
        // O roteamento, no Haiku (US$ 0,10 por milhão de entrada): US$ 1,00.
        {
          json: { decisao: "responder", agentes: [], motivo: "Pergunta geral." },
          usage: { input_tokens: 10_000_000, output_tokens: 0 },
        },
        { text: "Bom dia!", usage: DOIS_DOLARES },
      );

      const primeira = await enviar(t, geral.id, "bom dia, alguém por aí?");
      expect((await respostaA(t, geral.id, primeira)).body).toBe("Bom dia!");
      const gasto = await agente(t, sophya.id);
      expect(gasto.keySpendUsd).toBeCloseTo(3, 6);
      expect(gasto.overBudget).toBe(true);

      const segunda = await enviar(t, geral.id, "e agora?");
      const roteamento = await fim(doBruno, segunda);
      expect(roteamento).toMatchObject({
        kind: "route",
        state: "not_acting",
        reason: `${sophya.name} estourou o orçamento do mês na Chave`,
      });
      expect(t.anthropic.requests).toHaveLength(2);
      expect((await (await t.as(bruno).get(`/api/conversations/${geral.id}/outcomes`)).json()).length).toBe(1);
    },
    LONGO,
  );
});

describe("a execução que já roda", () => {
  test(
    "termina mesmo que o orçamento acabe no meio; a próxima já não usa a Chave",
    async () => {
      const cerebro = scriptedBrain();
      const t = await testApp({ keyBrain: cerebro.brain });
      const { faro, geral } = await workspace(t, { orcamento: 10 });
      const doBruno = await t.socket(bruno, "aba do Bruno");

      const primeira = await enviar(t, geral.id, "@Faro um");
      const run = await cerebro.nextRun(10_000);
      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 0 });
      await run.emit({ type: "text", text: "Terminei." });
      await run.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.5 });
      expect((await fim(doBruno, primeira)).state).toBe("done");
      expect((await agente(t, faro.id)).keySpendUsd).toBe(0.5);

      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro dois"))).state).toBe("not_acting");
      expect(cerebro.runs).toHaveLength(1);
    },
    LONGO,
  );
});

describe("estourado, com Conta", () => {
  test(
    "o Agente estourado segue respondendo a quem tem Conta; se ela bate no limite no meio, a mensagem espera na fila",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t, { orcamento: 0 });
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      t.claude.script({
        runs: [
          { kind: "reply", text: "Pela Conta." },
          {
            kind: "steps",
            steps: [
              { text: "Parcial" },
              { rateLimit: { status: "rejected", resetsAt: Date.parse("2026-11-24T15:45:00.000Z") / 1000 } },
            ],
            end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
          },
        ],
      });

      const primeira = await enviar(t, geral.id, "@Faro um", juliana);
      expect((await respostaA(t, geral.id, primeira)).body).toBe("Pela Conta.");
      // O que a Conta paga não entra no gasto na Chave.
      expect((await agente(t, faro.id)).keySpendUsd).toBe(0);

      const segunda = await enviar(t, geral.id, "@Faro dois", juliana);
      for (;;) {
        const { execution } = await daJuliana.next("execution.updated", ESPERA);
        if (execution.originMessageId !== segunda.id || !execution.held) continue;
        expect(execution).toMatchObject({
          state: "queued",
          yourAccount: { state: "limited", until: "2026-11-24T15:45:00.000Z" },
        });
        break;
      }
      expect(t.anthropic.requests).toHaveLength(0);
    },
    LONGO,
  );
});

describe("a fila decide de novo quando o orçamento muda", () => {
  const loginCaiu = { kind: "error", error: "authentication_failed", apiErrorStatus: 401 } as const;

  /** A Conta da Juliana cai no meio e a Chave está sem orçamento para o Faro: a mensagem espera, sem hora. */
  async function naFilaSemHora(t: TestApp, geral: ChannelDto) {
    await t.linkAccount(juliana);
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    t.claude.script({ runs: [loginCaiu] });
    const origem = await enviar(t, geral.id, "@Faro qual o prazo?", juliana);
    for (;;) {
      const { execution } = await daJuliana.next("execution.updated", ESPERA);
      if (execution.originMessageId === origem.id && execution.held) {
        expect(execution).toMatchObject({ state: "queued", yourAccount: { state: "needs_relink" } });
        break;
      }
    }
    return origem;
  }

  test(
    "o Admin aumenta o orçamento: quem esperava na fila sai pela Chave",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t, { orcamento: 0 });
      const origem = await naFilaSemHora(t, geral);
      t.anthropic.reply({ text: "Pela Chave, agora." });

      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 10 });

      expect((await respostaA(t, geral.id, origem)).body).toBe("Pela Chave, agora.");
    },
    LONGO,
  );

  test(
    "o mês vira: o orçamento recomeça e quem esperava na fila sai pela Chave",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { orcamento: 2 });
      t.anthropic.reply({ text: "Gastei tudo.", usage: DOIS_DOLARES });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro um"));
      const origem = await naFilaSemHora(t, geral);
      t.anthropic.reply({ text: "Mês novo." });

      // Até o fim de novembro, continua na fila.
      t.clock.set("2026-11-30T23:59:00.000Z");
      const abertas: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      expect(abertas.find((e) => e.originMessageId === origem.id)).toMatchObject({ held: true });
      t.clock.advance(60_000);

      expect((await respostaA(t, geral.id, origem)).body).toBe("Mês novo.");
    },
    LONGO,
  );
});

describe("o gasto na Chave conta o que a API informou", () => {
  /**
   * No Sonnet, a entrada de `DOIS_DOLARES` (500 mil tokens) custa US$ 1,00: é o que o
   * `message_start` informa (com 1 token de saída, US$ 0,00001).
   */
  const SO_A_ENTRADA = 1.00001;
  const gastou = (usd: number) => Math.abs(usd - SO_A_ENTRADA) < 1e-9;

  /** O `message_start` da Messages API, como o cérebro da Chave o normaliza. */
  const entradaInformada = {
    type: "usage",
    model: "claude-sonnet-5-5",
    usage: { inputTokens: 500_000, outputTokens: 1 },
    costUsd: SO_A_ENTRADA,
  } as const;

  test(
    "a execução cancelada no meio conta a entrada que a API informou",
    async () => {
      const cerebro = scriptedBrain();
      const t = await testApp({ keyBrain: cerebro.brain });
      const { faro, geral } = await workspace(t);
      const origem = await enviar(t, geral.id, "@Faro um");
      await (await cerebro.nextRun(10_000)).emit(entradaInformada);

      expect((await t.as(bruno).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`)).status).toBe(200);

      await eventually("o gasto aparecer", async () =>
        gastou((await agente(t, faro.id)).keySpendUsd!) ? true : undefined,
      );
    },
    LONGO,
  );

  test(
    "a execução que a vigia parou conta a entrada que a API informou",
    async () => {
      const cerebro = scriptedBrain();
      const t = await testApp({ keyBrain: cerebro.brain });
      const { faro, geral } = await workspace(t);
      const doBruno = await t.socket(bruno, "aba do Bruno");
      await enviar(t, geral.id, "@Faro um");
      await (await cerebro.nextRun(10_000)).emit(entradaInformada);

      t.clock.advance(120_000);
      for (;;) {
        const { execution } = await doBruno.next("execution.updated", ESPERA);
        if (execution.state === "retrying") break;
      }

      await eventually("o gasto aparecer", async () =>
        gastou((await agente(t, faro.id)).keySpendUsd!) ? true : undefined,
      );
    },
    LONGO,
  );

  test(
    "a execução que falha no meio do stream conta o uso que a API informou",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.anthropic.reply({
        text: "Um dois três quatro",
        streamError: { type: "invalid_request_error", message: "pedido ruim" },
        usage: DOIS_DOLARES,
      });

      expect((await fim(doBruno, await enviar(t, geral.id, "@Faro um"))).state).toBe("failed");

      expect((await agente(t, faro.id)).keySpendUsd).toBeCloseTo(SO_A_ENTRADA, 9);
    },
    LONGO,
  );
});

describe("o que a Chave cobre", () => {
  test("o Agente apagado com o orçamento estourado não conta: a Chave volta a cobrir todos", async () => {
    const t = await testApp();
    // Teto zero: estourado desde o começo do mês.
    const { faro } = await workspace(t, { orcamento: 0 });
    expect(await keyCoverage(t.db, t.clock.now())).toBe("some");

    expect((await t.as(juliana).delete(`/api/agents/${faro.id}`)).status).toBe(204);

    expect(await keyCoverage(t.db, t.clock.now())).toBe("all");
  });
});
