/**
 * Execução pela Conta (Spec, módulos 6 e 7; ADRs 0002 e 0006), pela borda do servidor: quem tem
 * a Conta ligada tem as suas execuções num `claude -p` (o `fake-claude`, processo de verdade);
 * quem não tem, pela Chave (a Messages API falsa).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountDto, AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@regents/contracts";
import { ROUTING_MODEL } from "../src/articuladora";
import { ROUTING_SCHEMA } from "../src/routing";
import type { FakeClaudeCall, FakeRun } from "./fake-claude";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const DOIS_MINUTOS = 120_000;
/** A máquina dos testes é compartilhada: os processos de verdade levam um tempo para subir. */
const ESPERA = { timeoutMs: 10_000 };

/** Juliana vira Admin, grava a Chave (se `chave`), cria o Faro e o põe no #geral. */
async function workspaceComFaro(t: TestApp, opts: { chave?: boolean } = {}) {
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
  return { faro, geral: geral! };
}

/** O Workspace com o Faro e a Conta de Juliana ligada; devolve também a pasta da Conta. */
async function comContaLigada(t: TestApp, opts: { chave?: boolean } = {}) {
  const ws = await workspaceComFaro(t, opts);
  const pasta = await t.linkAccount(juliana);
  return { ...ws, pasta };
}

async function enviar(t: TestApp, channelId: string, body: string, who = juliana): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (quando(execution)) return execution;
  }
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

/** Os `claude -p` das execuções (sem a chamada mínima da validação, que vem no argv). */
const execucoes = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);

/** Espera o `n`-ésimo `claude -p` de execução subir (já com os sinais tratados). */
const subiu = (t: TestApp, n = 1): Promise<FakeClaudeCall> =>
  eventually(`o ${n}º claude -p subir`, async () => execucoes(t)[n - 1], 10_000);

describe("quem paga: a Conta do autor ou a Chave", () => {
  test("com a Conta ligada, a Menção sai por um claude -p na pasta do autor e a resposta entra ancorada", async () => {
    const t = await testApp();
    const { geral, pasta } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    t.claude.script({ run: { kind: "steps", steps: [{ thinking: true }, { text: "Sexta-feira, Juliana." }] } });

    const origem = await enviar(t, geral.id, "@Faro qual o prazo da proposta?");

    const resposta = await respostaA(t, geral.id, origem);
    expect(resposta.body).toBe("Sexta-feira, Juliana.");
    expect(t.anthropic.requests).toHaveLength(0);
    const [call] = execucoes(t);
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe(pasta);
    expect(call!.argv).toContain("--no-session-persistence");
    expect(call!.stdin).toContain("Juliana (pessoa): @Faro qual o prazo da proposta?");
    expect(call!.argv[call!.argv.indexOf("--system-prompt") + 1]).toContain("Você é o Faro, do comercial.");
    // Pela Conta não aparece como "pela Chave do Workspace" (e a Conta não se mostra a ninguém).
    const fim = await andamento(aba, (e) => e.state === "done");
    expect(fim.payer).toBeNull();
  });

  test("sem Conta ligada, a mesma Menção sai pela Chave do Workspace", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    await t.linkAccount(juliana);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ text: "Pela Chave." });

    const origem = await enviar(t, geral.id, "@Faro qual o prazo?", bruno);

    expect((await respostaA(t, geral.id, origem)).body).toBe("Pela Chave.");
    expect(execucoes(t)).toHaveLength(0);
    expect((await andamento(aba, (e) => e.state === "done")).payer).toBe("key");
  });

  test("o credential_expires_at do fim atualiza a validade da Conta", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    t.claude.script({
      run: {
        kind: "steps",
        steps: [{ text: "Ok." }],
        end: { result: "success", credentialExpiresAt: "2026-12-20T09:00:00.000Z" },
      },
    });

    const origem = await enviar(t, geral.id, "@Faro oi");
    await respostaA(t, geral.id, origem);

    // "Minha Conta" mostra a validade 3 dias antes do vencimento da credencial.
    const conta: AccountDto = await (await t.as(juliana).get("/api/account")).json();
    expect(conta.status).toMatchObject({ state: "linked", validity: { until: "2026-12-17T09:00:00.000Z" } });
  });
});

describe("o roteamento da Articuladora pela Conta", () => {
  test("o Desfecho sai do --json-schema do claude -p, e o delegado responde também pela Conta", async () => {
    const t = await testApp();
    const { geral, faro } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    const decisao = {
      decisao: "delegar",
      agentes: [{ agente: "faro", cobrir: "o prazo da proposta" }],
      motivo: "É comercial.",
    };
    t.claude.script({
      runs: [
        { kind: "steps", steps: [{ thinking: true }], end: { result: "success", text: "", structuredOutput: decisao } },
        { kind: "steps", steps: [{ text: "Sexta, Juliana." }] },
      ],
    });

    const origem = await enviar(t, geral.id, "Qual o prazo da proposta?");

    const { outcome } = await aba.next("outcome.created", ESPERA);
    expect(outcome).toMatchObject({
      messageId: origem.id,
      decision: "delegate",
      reason: "É comercial.",
      delegates: [{ agent: { id: faro.id }, cover: "o prazo da proposta" }],
    });
    expect((await respostaA(t, geral.id, origem)).body).toBe("Sexta, Juliana.");
    const [roteamento, delegado] = execucoes(t);
    const flag = (c: FakeClaudeCall, name: string) => c.argv[c.argv.indexOf(name) + 1];
    expect(flag(roteamento!, "--model")).toBe(ROUTING_MODEL);
    expect(JSON.parse(flag(roteamento!, "--json-schema")!)).toEqual(ROUTING_SCHEMA);
    expect(delegado!.argv).not.toContain("--json-schema");
    expect(t.anthropic.requests).toHaveLength(0);
  });
});

describe("a vigia, a morte do processo e o cancelamento pela Conta", () => {
  test("2 minutos mudo: o processo leva SIGINT e a falha segue para a nova tentativa", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    t.claude.script({ runs: [{ kind: "hang" }], run: { kind: "reply", text: "Agora foi." } });

    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    const primeira = await subiu(t);
    t.clock.advance(DOIS_MINUTOS);

    const falha = await andamento(aba, (e) => e.state === "retrying");
    expect(falha).toMatchObject({ reason: "ficou 2 minutos sem escrever nada", attempt: 1 });
    expect(t.claude.signals(primeira.pid).map((s) => s.signal)).toEqual(["SIGINT"]);

    t.clock.advance(10_000);
    expect((await respostaA(t, geral.id, origem)).body).toBe("Agora foi.");
  });

  test("texto, pensamento e api_retry contam como progresso", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    t.claude.script({ run: { kind: "steps", steps: [{ apiRetry: { attempt: 1, max: 3 } }, { hang: true }] } });

    await enviar(t, geral.id, "@Faro tá aí?");
    await subiu(t);

    const tentando = await andamento(aba, (e) => e.apiRetry !== null);
    expect(tentando).toMatchObject({ state: "running", apiRetry: { attempt: 1, max: 3 } });
    t.clock.advance(DOIS_MINUTOS - 1_000);
    const [ainda] = (await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()) as ExecutionDto[];
    expect(ainda!.state).toBe("running");
  });

  test("processo que morre no meio é falha na hora, sem esperar a vigia; só a autora vê que é o Claude Code", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    await t.addMember(bruno, { by: juliana });
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    const aba = await t.socket(juliana);
    const doBruno = await t.socket(bruno, "aba do Bruno");
    t.claude.script({ run: { kind: "steps", steps: [{ text: "Vou te" }, { die: 1 }] } });

    await enviar(t, geral.id, "@Faro tá aí?");

    const falha = await andamento(aba, (e) => e.state === "retrying");
    expect(falha).toMatchObject({ reason: "o Claude Code parou sem terminar a resposta", attempt: 1 });
    // A Conta é só da autora (ADR 0005): o Bruno não fica sabendo que a execução corria por ela.
    expect(await andamento(doBruno, (e) => e.state === "retrying")).toMatchObject({
      reason: "a resposta parou no meio",
    });
    expect(t.anthropic.requests).toHaveLength(0);
  });

  test("cancelar pela autora manda SIGINT ao processo e nada sai", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    t.claude.script({ run: { kind: "steps", steps: [{ text: "Começando" }, { hang: true }] } });

    const origem = await enviar(t, geral.id, "@Faro tá aí?");
    const call = await subiu(t);
    const res = await t.as(juliana).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`);
    expect(res.status).toBe(200);

    await andamento(aba, (e) => e.state === "cancelled");
    await eventually("o SIGINT chegar", async () => t.claude.signals(call.pid).length > 0, 10_000);
    expect(t.claude.signals(call.pid).map((s) => s.signal)).toEqual(["SIGINT"]);
    const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    expect(lista.some((m) => m.originMessageId === origem.id)).toBe(false);
  });
});

describe("troca no meio: refeita pela Chave, sem gastar a nova tentativa", () => {
  const resetsAt = Date.parse("2026-11-24T15:45:00.000Z") / 1000;
  const casos: [string, FakeRun][] = [
    [
      "rate_limit_event rejeitado",
      {
        kind: "steps",
        steps: [
          { text: "Parcial pela Conta" },
          { rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" } },
        ],
        end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
      },
    ],
    ["assistant.error rate_limit", { kind: "error", error: "rate_limit", apiErrorStatus: 429 }],
    [
      "authentication_failed",
      {
        kind: "steps",
        steps: [{ text: "Parcial pela Conta" }],
        end: { result: "error", error: "authentication_failed", apiErrorStatus: 401 },
      },
    ],
  ];
  for (const [caso, run] of casos) {
    test(caso, async () => {
      const t = await testApp();
      const { geral } = await comContaLigada(t);
      const aba = await t.socket(juliana);
      t.claude.script({ run });
      t.anthropic.reply({ text: "Pela Chave, inteira." });

      const origem = await enviar(t, geral.id, "@Faro qual o prazo?");

      const trocada = await andamento(aba, (e) => e.payer === "key");
      expect(trocada).toMatchObject({ state: "running", attempt: 1, reason: null });
      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta.body).toBe("Pela Chave, inteira.");
      expect(t.anthropic.requests).toHaveLength(1);
      expect(execucoes(t)).toHaveLength(1);
      const fim = await andamento(aba, (e) => e.state === "done");
      expect(fim).toMatchObject({ attempt: 1, payer: "key" });
    });
  }

  test("o server_error do lock de renovação é falha comum: nova tentativa, sem trocar de pagador", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t);
    const aba = await t.socket(juliana);
    t.claude.script({
      run: {
        kind: "error",
        error: "server_error",
        message: "Failed to refresh OAuth token: another Claude Code process is refreshing it",
      },
    });

    await enviar(t, geral.id, "@Faro tá aí?");

    const falha = await andamento(aba, (e) => e.state === "retrying");
    expect(falha).toMatchObject({ reason: "a Anthropic respondeu com erro", payer: null });
    expect(t.anthropic.requests).toHaveLength(0);
  });

  test("sem Chave no Workspace, a troca não tem para onde ir: a mensagem espera na fila a Conta voltar (#27)", async () => {
    const t = await testApp();
    const { geral } = await comContaLigada(t, { chave: false });
    const aba = await t.socket(juliana);
    t.claude.script({ run: { kind: "error", error: "rate_limit", apiErrorStatus: 429 } });

    await enviar(t, geral.id, "@Faro tá aí?");

    const naFila = await andamento(aba, (e) => e.held);
    expect(naFila).toMatchObject({ state: "queued", attempt: 0, reason: null });
  });
});

describe("subida do servidor", () => {
  /** Uma pasta `.oauth_refresh.lock` com a idade dada (em ms) e, se `arquivo`, não vazia. */
  function lock(pasta: string, idadeMs: number, arquivo = false) {
    const dir = join(pasta, ".oauth_refresh.lock");
    mkdirSync(dir);
    if (arquivo) writeFileSync(join(dir, "dono"), "123");
    const quando = new Date(Date.now() - idadeMs);
    utimesSync(dir, quando, quando);
    return dir;
  }

  test("apaga o .oauth_refresh.lock órfão: só vazio e com mais de 60 s", async () => {
    const t = await testApp();
    const { pasta } = await comContaLigada(t);
    const velho = lock(pasta, 61_000);
    await t.restart();
    expect(existsSync(velho)).toBe(false);

    const novo = lock(pasta, 30_000);
    await t.restart();
    expect(existsSync(novo)).toBe(true);
  });

  test("não apaga um .oauth_refresh.lock com algo dentro", async () => {
    const t = await testApp();
    const { pasta } = await comContaLigada(t);
    const cheio = lock(pasta, 5 * 60_000, true);

    await t.restart();

    expect(existsSync(cheio)).toBe(true);
  });

  test("varre as pastas de login que ficaram para trás, e mantém a pasta da Conta", async () => {
    const t = await testApp();
    const { pasta } = await comContaLigada(t);
    const sobra = join(dirname(pasta), crypto.randomUUID());
    mkdirSync(sobra);
    writeFileSync(join(sobra, ".claude.json"), "{}");
    const deOutroMembro = join(t.accountsRoot, crypto.randomUUID(), crypto.randomUUID());
    mkdirSync(deOutroMembro, { recursive: true });
    const alheia = join(t.accountsRoot, "nao-e-do-shearim");
    mkdirSync(alheia);

    await t.restart();

    expect(existsSync(sobra)).toBe(false);
    expect(existsSync(deOutroMembro)).toBe(false);
    expect(existsSync(pasta)).toBe(true);
    expect(existsSync(join(pasta, ".credentials.json"))).toBe(true);
    expect(existsSync(alheia)).toBe(true);
  });
});
