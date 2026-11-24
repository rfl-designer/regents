/**
 * Quem paga e fila (Spec, módulo 6, "Quem paga" e "Prioridade"; ADRs 0002, 0003 e 0005), pela
 * borda do servidor. A tabela vale para cada execução ("Chave utilizável" = existe Chave e o
 * Agente tem orçamento; o orçamento é do #28):
 *
 * | Conta do autor        | Chave utilizável | Sem Chave utilizável                       |
 * |-----------------------|------------------|--------------------------------------------|
 * | Ligada                | Conta do autor   | Conta do autor                             |
 * | No limite até HH:MM   | Chave            | espera na fila até HH:MM                   |
 * | Precisa ligar de novo | Chave            | espera na fila sem hora, até ligar de novo |
 * | Não ligada            | Chave            | "Agentes não agem", com o motivo           |
 *
 * Todos veem "pela Chave do Workspace", a fila e o aviso; só o autor vê o motivo ligado à Conta
 * dele (`yourAccount`) e a hora em que ela volta.
 */
import { describe, expect, test } from "bun:test";
import type { AccountDto, AgentDto, ChannelDto, ExecutionDto, MessageDto, YourAccountDto } from "@shearim/contracts";
import type { FakeClaudeCall, FakeRun } from "./fake-claude";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
/** A máquina dos testes é compartilhada: os processos de verdade levam um tempo para subir. */
const ESPERA = { timeoutMs: 10_000 };
/** Cada teste abre o Workspace com duas pessoas e às vezes liga Contas pelo fluxo de verdade. */
const LONGO = 120_000;

/** Juliana vira Admin, grava a Chave (se `chave`), cria o Faro e o põe no #geral; Bruno entra. */
async function workspace(t: TestApp, opts: { chave?: boolean } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial.",
      instructions: "Você é o Faro, do comercial.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string, who = juliana): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** O próximo Andamento que satisfaz `quando` (os anteriores são lidos e deixados para trás). */
async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (quando(execution)) return execution;
  }
}

async function abertas(t: TestApp, channelId: string, who = juliana): Promise<ExecutionDto[]> {
  return (await t.as(who).get(`/api/channels/${channelId}/executions`)).json();
}

describe("Não ligada", () => {
  test(
    "sem Chave: Agentes não agem com o motivo, e só a autora vê que é por não ter ligado a Conta",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");

      await enviar(t, geral.id, "@Faro qual o prazo?");

      const paraEla = await andamento(daJuliana, (e) => e.state === "not_acting");
      expect(paraEla).toMatchObject({ reason: "o Workspace não tem Chave", yourAccount: { state: "not_linked" } });
      const paraEle = await andamento(doBruno, (e) => e.state === "not_acting");
      expect(paraEle).toMatchObject({ reason: "o Workspace não tem Chave", yourAccount: null });
      expect((await abertas(t, geral.id, juliana))[0]!.yourAccount).toEqual({ state: "not_linked" });
      expect((await abertas(t, geral.id, bruno))[0]!.yourAccount).toBeNull();
      expect(t.anthropic.requests).toHaveLength(0);
    },
    LONGO,
  );
});

async function respostaA(t: TestApp, channelId: string, origem: MessageDto, who = juliana) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(who).get(`/api/channels/${channelId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
  );
}

async function conta(t: TestApp, who = juliana): Promise<AccountDto> {
  return (await t.as(who).get("/api/account")).json();
}

/** Os `claude -p` das execuções (sem a chamada mínima da validação, que vem no argv). */
const execucoes = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);

/** 15:45 de hoje (o relógio dos testes começa em 2026-11-24T12:00Z). */
const QUINZE_E_QUARENTA_E_CINCO = "2026-11-24T15:45:00.000Z";
const limiteAte = (iso: string): FakeRun => ({
  kind: "steps",
  steps: [{ text: "Parcial pela Conta" }, { rateLimit: { status: "rejected", resetsAt: Date.parse(iso) / 1000 } }],
  end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
});
/** Liga a Conta do Bruno com outra assinatura (a mesma de outra pessoa pediria "Ligar mesmo assim"). */
async function ligarContaDoBruno(t: TestApp) {
  t.claude.script({ login: { account: { email: "bruno@exemplo.com", orgId: "org-bruno" } } });
  await t.linkAccount(bruno);
}
const loginCaiu: FakeRun = { kind: "error", error: "authentication_failed", apiErrorStatus: 401 };

describe("Não ligada", () => {
  test(
    "com Chave: a Chave paga, todos veem pela Chave do Workspace, e só a autora vê o porquê",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.anthropic.reply({ text: "Pela Chave." });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const paraEla = await andamento(daJuliana, (e) => e.state === "running" && e.payer === "key");
      expect(paraEla.yourAccount).toEqual({ state: "not_linked" });
      const paraEle = await andamento(doBruno, (e) => e.state === "running" && e.payer === "key");
      expect(paraEle.yourAccount).toBeNull();
      expect((await respostaA(t, geral.id, origem, bruno)).payer).toBe("key");
      expect((await respostaA(t, geral.id, origem, juliana)).payer).toBe("key");
    },
    LONGO,
  );
});

describe("depois da resposta pela Chave", () => {
  test(
    "a autora continua vendo o porquê ligado à Conta dela, só ela, mesmo depois que a Conta volta",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });
      t.anthropic.reply({ text: "Pela Chave, inteira." });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const respostaDe = async (aba: EventSocket) => {
        for (;;) {
          const { message } = await aba.next("message.created", ESPERA);
          if (message.originMessageId === origem.id) return message;
        }
      };
      const motivo: YourAccountDto = { state: "limited", until: QUINZE_E_QUARENTA_E_CINCO };
      expect(await respostaDe(daJuliana)).toMatchObject({ payer: "key", yourAccount: motivo });
      const paraEle = await respostaDe(doBruno);
      expect(paraEle.payer).toBe("key");
      expect(paraEle).not.toHaveProperty("yourAccount");

      expect((await respostaA(t, geral.id, origem, juliana)).yourAccount).toEqual(motivo);
      expect(await respostaA(t, geral.id, origem, bruno)).not.toHaveProperty("yourAccount");

      // A Conta volta às 15:45: o porquê daquela resposta continua o mesmo.
      t.clock.set("2026-11-24T16:00:00.000Z");
      expect((await respostaA(t, geral.id, origem, juliana)).yourAccount).toEqual(motivo);
    },
    LONGO,
  );
});

describe("Ligada", () => {
  test(
    "sem Chave: a Conta da autora paga",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      const pasta = await t.linkAccount(juliana);
      t.claude.script({ run: { kind: "reply", text: "Pela Conta." } });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta.body).toBe("Pela Conta.");
      expect(resposta.payer).toBeUndefined();
      expect(execucoes(t)[0]!.env.CLAUDE_CONFIG_DIR).toBe(pasta);
    },
    LONGO,
  );
});

describe("No limite até HH:MM", () => {
  test(
    "com Chave: troca no meio, a Conta fica No limite até 15:45 e a próxima nem tenta por ela",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });
      t.anthropic.reply({ text: "Pela Chave, inteira." }, { text: "Também pela Chave." });

      const primeira = await enviar(t, geral.id, "@Faro qual o prazo?");

      const { account } = await daJuliana.next("account.updated", ESPERA);
      expect(account.status).toMatchObject({ state: "limited", until: QUINZE_E_QUARENTA_E_CINCO });
      const trocada = await andamento(daJuliana, (e) => e.payer === "key");
      expect(trocada).toMatchObject({ state: "running", attempt: 1 });
      expect(trocada.yourAccount).toEqual({ state: "limited", until: QUINZE_E_QUARENTA_E_CINCO });
      expect((await andamento(doBruno, (e) => e.payer === "key")).yourAccount).toBeNull();
      expect((await respostaA(t, geral.id, primeira)).body).toBe("Pela Chave, inteira.");

      const segunda = await enviar(t, geral.id, "@Faro e o valor?");
      expect((await respostaA(t, geral.id, segunda)).body).toBe("Também pela Chave.");
      expect(execucoes(t)).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "às 15:45, a Conta volta sozinha em Minha Conta e a próxima sai por ela",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(juliana);
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)], run: { kind: "reply", text: "Voltei." } });
      t.anthropic.reply({ text: "Pela Chave." });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro oi"));
      const aba = await t.socket(juliana);

      t.clock.set(QUINZE_E_QUARENTA_E_CINCO);

      const { account } = await aba.next("account.updated", ESPERA);
      expect(account.status.state).toBe("linked");
      const origem = await enviar(t, geral.id, "@Faro de novo");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Voltei.");
    },
    LONGO,
  );

  test(
    "sem Chave: ⏸ na fila; só a autora vê até quando; às 15:45 sai pela Conta, sem gastar tentativa",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)], run: { kind: "reply", text: "Voltei." } });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const naFila = await andamento(daJuliana, (e) => e.held);
      expect(naFila).toMatchObject({ state: "queued", attempt: 0, payer: null, reason: null });
      expect(naFila.yourAccount).toEqual({ state: "limited", until: QUINZE_E_QUARENTA_E_CINCO });
      const paraEle = await andamento(doBruno, (e) => e.held);
      expect(paraEle).toMatchObject({ state: "queued", yourAccount: null });
      expect(await abertas(t, geral.id, bruno)).toEqual([paraEle]);

      t.clock.set("2026-11-24T15:44:59.000Z");
      expect((await abertas(t, geral.id))[0]).toMatchObject({ state: "queued", held: true });
      expect(execucoes(t)).toHaveLength(1);

      t.clock.set(QUINZE_E_QUARENTA_E_CINCO);
      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta.body).toBe("Voltei.");
      const fim = await andamento(daJuliana, (e) => e.state === "done");
      expect(fim).toMatchObject({ attempt: 1, held: false });
      expect(t.anthropic.requests).toHaveLength(0);
    },
    LONGO,
  );

  test(
    "sem Chave, já no limite: a próxima mensagem espera na fila sem subir o claude",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });
      await enviar(t, geral.id, "@Faro primeira");
      await andamento(aba, (e) => e.held);

      await enviar(t, geral.id, "@Faro segunda");

      await andamento(aba, (e) => e.held);
      expect((await abertas(t, geral.id)).map((e) => e.held)).toEqual([true, true]);
      expect(execucoes(t)).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "a mensagem de quem espera a própria Conta não segura a dos outros",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      await ligarContaDoBruno(t);
      const aba = await t.socket(juliana);
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)], run: { kind: "reply", text: "Para o Bruno." } });
      await enviar(t, geral.id, "@Faro da Juliana");
      await andamento(aba, (e) => e.held);

      const doBruno = await enviar(t, geral.id, "@Faro do Bruno", bruno);

      expect((await respostaA(t, geral.id, doBruno)).body).toBe("Para o Bruno.");
      expect((await abertas(t, geral.id))[0]).toMatchObject({ held: true });
    },
    LONGO,
  );

  test(
    "quem volta da fila mantém a hora de chegada: passa na frente de quem chegou depois",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      await ligarContaDoBruno(t);
      const aba = await t.socket(juliana);
      t.claude.script({
        runs: [
          limiteAte(QUINZE_E_QUARENTA_E_CINCO),
          // A do Bruno demora: enquanto isso, a Conta da Juliana volta e chega outra do Bruno.
          { kind: "steps", steps: [{ text: "Primeira " }, { sleepMs: 1_500 }, { text: "do Bruno." }] },
        ],
        run: { kind: "reply", text: "ok" },
      });
      await enviar(t, geral.id, "@Faro da Juliana");
      await andamento(aba, (e) => e.held);
      await enviar(t, geral.id, "@Faro primeira do Bruno", bruno);
      await eventually("a do Bruno subir", async () => execucoes(t)[1], 10_000);
      await enviar(t, geral.id, "@Faro segunda do Bruno", bruno);
      t.clock.set(QUINZE_E_QUARENTA_E_CINCO);
      // O salto do relógio deixa a do Bruno 2 min sem progresso: ela vai para a nova tentativa, em
      // 10 s, e segura a segunda dele (as respostas do Faro na conversa saem em série, #42). A da
      // Juliana, que chegou antes de todas, não espera: sai já.
      await eventually("a da Juliana subir de novo", async () => execucoes(t)[2], 10_000);
      t.clock.advance(10_000);

      const ordem = await eventually("as cinco subirem", async () => execucoes(t)[4] && execucoes(t), 15_000);
      // A mensagem de origem é a última de pessoa no contexto.
      const ultima = (c: FakeClaudeCall) =>
        c
          .stdin!.split("\n")
          .filter((l) => l.includes(" (pessoa): "))
          .at(-1);
      expect(ordem.map(ultima)).toEqual([
        "Juliana (pessoa): @Faro da Juliana",
        "Bruno (pessoa): @Faro primeira do Bruno",
        "Juliana (pessoa): @Faro da Juliana",
        "Bruno (pessoa): @Faro primeira do Bruno",
        "Bruno (pessoa): @Faro segunda do Bruno",
      ]);
    },
    LONGO,
  );

  test(
    "a autora cancela a mensagem que espera na fila",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });
      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");
      await andamento(aba, (e) => e.held);

      expect((await t.as(bruno).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`)).status).toBe(403);
      const res = await t.as(juliana).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject([{ state: "cancelled", held: false }]);
      t.clock.set(QUINZE_E_QUARENTA_E_CINCO);
      t.claude.script({ run: { kind: "reply", text: "não devia" } });
      await enviar(t, geral.id, "@Faro outra");
      await eventually("a outra sair", async () => execucoes(t)[1], 10_000);
      expect(execucoes(t)).toHaveLength(2);
    },
    LONGO,
  );

  test(
    "a fila fica no Postgres: depois do reinício, ainda espera e sai às 15:45",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)], run: { kind: "reply", text: "Voltei." } });
      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");
      await andamento(aba, (e) => e.held);

      await t.restart();

      expect((await abertas(t, geral.id))[0]).toMatchObject({ state: "queued", held: true });
      t.clock.set(QUINZE_E_QUARENTA_E_CINCO);
      expect((await respostaA(t, geral.id, origem)).body).toBe("Voltei.");
    },
    LONGO,
  );

  test(
    "a Chave gravada pelo Admin solta a fila: a mensagem sai pela Chave",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });
      t.anthropic.reply({ text: "Pela Chave nova." });
      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");
      await andamento(aba, (e) => e.held);

      await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });

      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta).toMatchObject({ body: "Pela Chave nova.", payer: "key" });
    },
    LONGO,
  );

  test(
    "a Articuladora também espera: sem Chave, o roteamento fica na fila até a Conta voltar",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: limiteAte(QUINZE_E_QUARENTA_E_CINCO) });

      await enviar(t, geral.id, "Qual o prazo da proposta?");

      const naFila = await andamento(aba, (e) => e.held);
      expect(naFila).toMatchObject({ kind: "route", state: "queued" });
      expect(await (await t.as(juliana).get(`/api/conversations/${geral.id}/outcomes`)).json()).toEqual([]);
    },
    LONGO,
  );
});

describe("Precisa ligar de novo", () => {
  test(
    "com Chave: o login caiu no meio, a resposta sai pela Chave e a próxima nem tenta pela Conta",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: loginCaiu });
      t.anthropic.reply({ text: "Pela Chave." }, { text: "De novo pela Chave." });

      const primeira = await enviar(t, geral.id, "@Faro qual o prazo?");

      const { account } = await aba.next("account.updated", ESPERA);
      expect(account.status).toMatchObject({ state: "needs_relink", email: "fulana@exemplo.com" });
      expect((await andamento(aba, (e) => e.payer === "key")).yourAccount).toEqual({ state: "needs_relink" });
      expect((await respostaA(t, geral.id, primeira)).body).toBe("Pela Chave.");
      const segunda = await enviar(t, geral.id, "@Faro e o valor?");
      expect((await respostaA(t, geral.id, segunda)).body).toBe("De novo pela Chave.");
      expect(execucoes(t)).toHaveLength(1);
      expect((await conta(t)).status.state).toBe("needs_relink");
    },
    LONGO,
  );

  test(
    "sem Chave: na fila sem hora, só a autora vê o porquê, e ligar a Conta de novo solta a fila",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.claude.script({ runs: [loginCaiu], run: { kind: "reply", text: "Liguei de novo." } });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const naFila = await andamento(daJuliana, (e) => e.held);
      expect(naFila).toMatchObject({ state: "queued", yourAccount: { state: "needs_relink" } });
      expect((await andamento(doBruno, (e) => e.held)).yourAccount).toBeNull();
      // Seis dias depois (ainda em novembro: a virada do mês também faz a fila decidir de novo).
      t.clock.advance(6 * 24 * 60 * 60_000);
      expect((await abertas(t, geral.id))[0]).toMatchObject({ held: true });

      const pasta = await t.linkAccount(juliana);

      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta.body).toBe("Liguei de novo.");
      expect(execucoes(t).at(-1)!.env.CLAUDE_CONFIG_DIR).toBe(pasta);
    },
    LONGO,
  );

  test(
    "sem Chave, quem desliga a Conta em vez de ligar de novo vê Agentes não agem",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({ run: loginCaiu });
      await enviar(t, geral.id, "@Faro qual o prazo?");
      await andamento(aba, (e) => e.held);

      await t.as(juliana).delete("/api/account");

      const fim = await andamento(aba, (e) => e.state === "not_acting");
      expect(fim).toMatchObject({ reason: "o Workspace não tem Chave", yourAccount: { state: "not_linked" } });
    },
    LONGO,
  );
});

describe("o estado da Conta é só do autor", () => {
  test(
    "a falha por causa da Conta mostra a Conta só à autora; os outros veem a recusa",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(juliana);
      const daJuliana = await t.socket(juliana, "aba da Juliana");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      t.claude.script({ run: { kind: "error", error: "billing_error", apiErrorStatus: 403 } });

      await enviar(t, geral.id, "@Faro qual o prazo?");

      const paraEla = await andamento(daJuliana, (e) => e.state === "failed");
      expect(paraEla.reason).toBe("a sua Conta do Claude não pode ser usada agora");
      const paraEle = await andamento(doBruno, (e) => e.state === "failed");
      expect(paraEle.reason).toBe("a Anthropic recusou o pedido");
      expect((await abertas(t, geral.id, bruno))[0]!.reason).toBe("a Anthropic recusou o pedido");
      expect((await abertas(t, geral.id, juliana))[0]!.reason).toBe("a sua Conta do Claude não pode ser usada agora");
    },
    LONGO,
  );

  test(
    "Tentar de novo é pago pela Conta da autora",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.anthropic.reply({ status: 401, errorType: "authentication_error" });
      await enviar(t, geral.id, "@Faro qual o prazo?");
      const falha = await andamento(aba, (e) => e.state === "failed");
      const pasta = await t.linkAccount(juliana);
      t.claude.script({ run: { kind: "reply", text: "Pela minha Conta." } });

      const res = await t.as(juliana).post(`/api/conversations/${geral.id}/executions/${falha.id}/retry`);

      expect(res.status).toBe(200);
      await andamento(aba, (e) => e.state === "done");
      expect(execucoes(t)).toHaveLength(1);
      expect(execucoes(t)[0]!.env.CLAUDE_CONFIG_DIR).toBe(pasta);
    },
    LONGO,
  );
});
