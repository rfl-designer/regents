/**
 * Validade da Conta e religação (Spec, módulo 8, "Validade" e "Religar"; ADR 0005; histórias 36 a 40),
 * pela borda do servidor, com o relógio injetável e o `fake-claude`.
 *
 * - A validade é a data mais cedo em que o login pode cair: `loginExpiresAt` − 3 dias, lida com
 *   `claude auth status --json` ao ligar e uma vez por dia, e antecipada pelo `credential_expires_at`
 *   de cada execução. 3 dias antes dela: um único push, o selo e o destaque (`validity.state: "soon"`);
 *   depois dela, "pode vencer a qualquer momento" (`any_time`).
 * - "Ligar de novo" é o mesmo fluxo, numa pasta nova que só entra em uso depois de validada. A pasta
 *   antiga é apagada quando terminam as execuções dela, sem `claude auth logout`. Desistir no meio não
 *   muda a Conta.
 * - "usando uso extra": a execução passou do plano com o uso extra ligado.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { AccountDto, AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { FAKE_LOGIN_CODE, type FakeRun, fakeLogin } from "./fake-claude";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;
const CHAVE = "sk-ant-api03-chave-do-workspace";
const HORA = 60 * 60_000;
const DIA = 24 * HORA;

/** O relógio dos testes começa em 2026-11-24T12:00Z; o login do dublê vale até 2026-12-24T12:00Z. */
const VALE_ATE = "2026-12-21T12:00:00.000Z";
const AVISO_EM = "2026-12-18T12:00:00.000Z";

/** Juliana vira Admin, grava a Chave (se `chave`), cria o Faro e o põe no #geral; Bruno entra. */
async function workspace(t: TestApp, opts: { chave?: boolean } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const criado = await t.as(juliana).post("/api/agents", {
    name: "Faro",
    photo: null,
    description: "Comercial.",
    instructions: "Você é o Faro, do comercial.",
    model: "claude-sonnet-5-5",
  });
  expect(criado.status).toBe(201);
  const faro: AgentDto = await criado.json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** O fim (resposta, falha ou "Agentes não agem") da execução desta origem, visto nesta aba. */
async function fim(aba: EventSocket, origem: MessageDto): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (execution.originMessageId === origem.id && ["done", "failed", "not_acting"].includes(execution.state)) {
      return execution;
    }
  }
}

async function conta(t: TestApp, who: Person = bruno): Promise<AccountDto> {
  return (await t.as(who).get("/api/account")).json();
}

/** Lê `account.updated` na conexão até um que satisfaça `done`; devolve esse. */
async function ate(aba: EventSocket, done: (a: AccountDto) => boolean): Promise<AccountDto> {
  for (;;) {
    const { account } = await aba.next("account.updated", ESPERA);
    if (done(account)) return account;
  }
}

/** Uma DM de Juliana para Bruno: o push dela é o sentinela de que nada saiu antes (os pushes saem em fila). */
async function dm(t: TestApp, body: string) {
  const destino = await (await t.as(bruno).get("/api/me")).json();
  const conversa = await (await t.as(juliana).post("/api/dms", { memberIds: [destino.id] })).json();
  await t.as(juliana).post(`/api/conversations/${conversa.id}/messages`, { body });
}

/** `21/12`, na hora local do servidor (`TZ`), como o push e "Minha Conta" mostram a validade. */
const diaLocal = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date(iso));

/** A pasta (`CLAUDE_CONFIG_DIR`) dos `claude -p` de execução até agora, em ordem. */
const pastasDosRuns = (t: TestApp) => t.claude.callsOf("-p").map((c) => c.env.CLAUDE_CONFIG_DIR);

/** "Ligar de novo" até a URL aparecer; devolve a pasta nova do login. */
async function comecarDeNovo(t: TestApp, aba: EventSocket) {
  expect((await t.as(bruno).post("/api/account/linking")).status).toBe(202);
  await ate(aba, (a) => a.linking?.state === "waiting_code");
  return t.claude.callsOf("auth login").at(-1)!.env.CLAUDE_CONFIG_DIR!;
}

describe("a validade da Conta", () => {
  test(
    'ao ligar, "Minha Conta" mostra a data mais cedo: loginExpiresAt menos 3 dias',
    async () => {
      const t = await testApp();
      await workspace(t);

      await t.linkAccount(bruno);

      expect((await conta(t)).status).toEqual({
        state: "linked",
        email: "fulana@exemplo.com",
        plan: "Claude Max",
        validity: { until: VALE_ATE, state: "ok", afterwards: "key" },
        extraUsage: false,
      });
    },
    LONGO,
  );

  test(
    "o credential_expires_at de uma execução antecipa a validade, e a aba fica sabendo",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ text: "Ok." }],
          end: { result: "success", credentialExpiresAt: "2026-12-20T09:00:00.000Z" },
        },
      });

      await enviar(t, geral.id, "@Faro oi");

      const nova = await ate(aba, (a) => a.status.state === "linked" && a.status.validity?.until !== VALE_ATE);
      expect(nova.status).toMatchObject({ validity: { until: "2026-12-17T09:00:00.000Z", state: "ok" } });
    },
    LONGO,
  );

  test(
    "uma vez por dia, o Shearim relê o auth status de cada Conta Ligada",
    async () => {
      const t = await testApp();
      await workspace(t);
      const pasta = await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      const lidas = t.claude.callsOf("auth status").length;

      // O login foi renovado por fora (outra data no `auth status`).
      fakeLogin(pasta, { loginExpiresAt: "2027-01-10T12:00:00.000Z" });
      t.clock.advance(DIA - 60_000);
      // Antes de um dia, nada.
      expect(t.claude.callsOf("auth status")).toHaveLength(lidas);
      t.clock.advance(60_000);

      const nova = await ate(aba, (a) => a.status.state === "linked" && a.status.validity?.until !== VALE_ATE);
      expect(nova.status).toMatchObject({ validity: { until: "2027-01-07T12:00:00.000Z", state: "ok" } });
      expect(
        t.claude
          .callsOf("auth status")
          .slice(lidas)
          .map((c) => c.env.CLAUDE_CONFIG_DIR),
      ).toEqual([pasta]);
    },
    LONGO,
  );

  test(
    "3 dias antes da data: um único push, o selo e o destaque; com Chave, o texto diz que segue pela Chave",
    async () => {
      const t = await testApp();
      await workspace(t);
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      const aba = await t.socket(bruno);

      t.clock.set(new Date(new Date(AVISO_EM).getTime() - 60_000));
      // A releitura diária terminou (o `auth status` tem prazo no relógio: andar antes o mataria).
      await ate(aba, () => true);
      await dm(t, "antes do aviso");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("antes do aviso");
      expect((await conta(t)).status).toMatchObject({ validity: { state: "ok" } });

      t.clock.advance(60_000);

      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: `Ligue sua Conta do Claude de novo até ${diaLocal(VALE_ATE)}`,
        body: "Depois disso, ela pode parar a qualquer momento, e suas mensagens passam a seguir pela Chave do Workspace.",
        navigate: expect.stringMatching(/\/conta$/),
        tag: "conta",
      });
      expect(push.urgency).toBe("normal");
      const destaque = await ate(aba, (a) => a.status.state === "linked" && a.status.validity?.state === "soon");
      expect(destaque.status).toMatchObject({ validity: { until: VALE_ATE, state: "soon", afterwards: "key" } });

      // Os dias seguintes (com a releitura diária) e um reinício não mandam outro.
      await eventually("a releitura do dia", async () => t.claude.callsOf("auth status").length >= 2, 15_000);
      const lidas = t.claude.callsOf("auth status").length;
      t.clock.advance(DIA);
      await eventually(
        "a releitura do dia seguinte",
        async () => t.claude.callsOf("auth status").length > lidas,
        15_000,
      );
      await t.restart();
      await dm(t, "depois do aviso");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toEndWith("depois do aviso");
    },
    LONGO,
  );

  test(
    "sem Chave, o aviso diz que as mensagens esperam na fila até ligar de novo",
    async () => {
      const t = await testApp();
      await workspace(t, { chave: false });
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);

      t.clock.set(AVISO_EM);

      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: `Ligue sua Conta do Claude de novo até ${diaLocal(VALE_ATE)}`,
        body: "Depois disso, ela pode parar a qualquer momento, e suas mensagens com Agentes esperam na fila até você ligar de novo.",
        tag: "conta",
      });
      expect((await conta(t)).status).toMatchObject({ validity: { state: "soon", afterwards: "queue" } });
    },
    LONGO,
  );

  test(
    'depois da data, "Minha Conta" diz que pode vencer a qualquer momento',
    async () => {
      const t = await testApp();
      await workspace(t);
      await t.linkAccount(bruno);
      const aba = await t.socket(bruno);

      t.clock.set(AVISO_EM);
      await ate(aba, (a) => a.status.state === "linked" && a.status.validity?.state === "soon");
      t.clock.advance(3 * DIA + 60_000);

      const depois = await ate(aba, (a) => a.status.state === "linked" && a.status.validity?.state === "any_time");
      expect(depois.status).toMatchObject({ state: "linked", validity: { until: VALE_ATE, state: "any_time" } });
    },
    LONGO,
  );

  test(
    "um login que já vence em menos de 3 dias avisa logo ao ligar",
    async () => {
      const t = await testApp();
      await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      t.claude.script({ login: { account: { loginExpiresAt: "2026-11-29T12:00:00.000Z" } } });

      await t.linkAccount(bruno);

      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification.title).toBe(
        `Ligue sua Conta do Claude de novo até ${diaLocal("2026-11-26T12:00:00.000Z")}`,
      );
      expect((await conta(t)).status).toMatchObject({ validity: { state: "soon" } });
    },
    LONGO,
  );
});

describe("Ligar de novo", () => {
  test(
    "com a Conta Ligada, abre um login numa pasta nova; as execuções só passam a usá-la depois da validação",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const antiga = await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      t.claude.script({ login: { account: { loginExpiresAt: "2027-01-20T12:00:00.000Z" } } });

      const nova = await comecarDeNovo(t, aba);
      expect(nova).not.toBe(antiga);
      expect((await conta(t)).status.state).toBe("linked");

      // No meio da religação, a mensagem sai pela pasta antiga.
      expect((await fim(aba, await enviar(t, geral.id, "@Faro um"))).state).toBe("done");
      expect(pastasDosRuns(t).at(-1)).toBe(antiga);

      await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
      const religada = await ate(aba, (a) => a.linking === null);
      expect(religada.status).toMatchObject({
        state: "linked",
        validity: { until: "2027-01-17T12:00:00.000Z", state: "ok" },
      });
      // A validação rodou na pasta nova.
      expect(pastasDosRuns(t).at(-1)).toBe(nova);

      expect((await fim(aba, await enviar(t, geral.id, "@Faro dois"))).state).toBe("done");
      expect(pastasDosRuns(t).at(-1)).toBe(nova);
      // A pasta antiga sai sem `claude auth logout` (ele revogaria o login no servidor).
      await eventually("a pasta antiga ser apagada", async () => !existsSync(antiga), 15_000);
      expect(existsSync(nova)).toBe(true);
      expect(t.claude.callsOf("auth logout")).toEqual([]);
    },
    LONGO,
  );

  test(
    "a pasta antiga só é apagada quando termina a execução que ainda roda nela",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const antiga = await t.linkAccount(bruno);
      const travada: FakeRun = { kind: "hang" };
      t.claude.script({ runs: [travada] });

      const origem = await enviar(t, geral.id, "@Faro demora");
      await eventually("a execução subir pela Conta", async () => pastasDosRuns(t).at(-1) === antiga, 15_000);
      await t.linkAccount(bruno);
      expect(pastasDosRuns(t).at(-1)).not.toBe(antiga);

      // Ainda roda na pasta antiga: ela fica.
      expect(existsSync(antiga)).toBe(true);

      await t.as(bruno).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`);
      await eventually("a pasta antiga ser apagada", async () => !existsSync(antiga), 15_000);
      expect(t.claude.callsOf("auth logout")).toEqual([]);
    },
    LONGO,
  );

  test(
    '"Cancelar" no meio não muda a Conta: ela segue ligada, na pasta antiga',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const antiga = await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      const antes = await conta(t);

      const nova = await comecarDeNovo(t, aba);
      const res = await t.as(bruno).delete("/api/account/linking");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(antes);
      expect(existsSync(nova)).toBe(false);
      expect(existsSync(antiga)).toBe(true);
      expect((await fim(aba, await enviar(t, geral.id, "@Faro um"))).state).toBe("done");
      expect(pastasDosRuns(t).at(-1)).toBe(antiga);
    },
    LONGO,
  );

  test(
    "deixar o código vencer, ou a validação falhar, também não muda a Conta",
    async () => {
      const t = await testApp();
      await workspace(t);
      const antiga = await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      const antes = (await conta(t)).status;

      await comecarDeNovo(t, aba);
      t.clock.advance(10 * 60_000);
      const vencida = await ate(aba, (a) => a.linking?.state === "expired");
      expect(vencida.status).toEqual(antes);

      await comecarDeNovo(t, aba);
      t.claude.script({ runs: [{ kind: "error", error: "billing_error", apiErrorStatus: 403 }] });
      await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
      const falhou = await ate(aba, (a) => a.linking?.state === "failed");
      expect(falhou.status).toEqual(antes);
      expect(existsSync(antiga)).toBe(true);
    },
    LONGO,
  );

  test(
    'ligar de novo a partir de "Precisa ligar de novo" apaga a pasta que caiu, sem logout',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const antiga = await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      t.claude.script({ runs: [{ kind: "error", error: "authentication_failed", apiErrorStatus: 401 }] });
      t.anthropic.reply({ text: "Pela Chave." });
      await fim(aba, await enviar(t, geral.id, "@Faro um"));
      expect((await conta(t)).status.state).toBe("needs_relink");

      const nova = await t.linkAccount(bruno);

      expect(nova).not.toBe(antiga);
      await eventually("a pasta que caiu ser apagada", async () => !existsSync(antiga), 15_000);
      expect(t.claude.callsOf("auth logout")).toEqual([]);
    },
    LONGO,
  );

  test(
    "religar recomeça a validade, e o aviso volta a valer para o login novo",
    async () => {
      const t = await testApp();
      await workspace(t);
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      t.clock.set(AVISO_EM);
      expect((await doBruno.next(ESPERA)).payload.notification.title).toContain(diaLocal(VALE_ATE));

      // O login novo vale mais um mês: aviso 6 dias antes dele.
      t.claude.script({ login: { account: { loginExpiresAt: "2027-01-18T12:00:00.000Z" } } });
      await t.linkAccount(bruno);
      expect((await conta(t)).status).toMatchObject({
        validity: { until: "2027-01-15T12:00:00.000Z", state: "ok" },
      });

      t.clock.set("2027-01-12T12:00:00.000Z");
      expect((await doBruno.next(ESPERA)).payload.notification.title).toContain(diaLocal("2027-01-15T12:00:00.000Z"));
    },
    LONGO,
  );
});

describe("usando uso extra", () => {
  test(
    "uma execução que passou do plano com o uso extra ligado aparece em Minha Conta; a próxima, sem ele, apaga",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(bruno);
      const aba = await t.socket(bruno);
      const comUsoExtra = (isUsingOverage: boolean): FakeRun => ({
        kind: "steps",
        steps: [{ rateLimit: { status: "allowed", rateLimitType: "five_hour", isUsingOverage } }, { text: "Ok." }],
        end: { result: "success" },
      });
      t.claude.script({ runs: [comUsoExtra(true), comUsoExtra(false)] });

      expect((await fim(aba, await enviar(t, geral.id, "@Faro um"))).state).toBe("done");
      expect((await conta(t)).status).toMatchObject({ state: "linked", extraUsage: true });

      expect((await fim(aba, await enviar(t, geral.id, "@Faro dois"))).state).toBe("done");
      expect((await conta(t)).status).toMatchObject({ state: "linked", extraUsage: false });
    },
    LONGO,
  );
});
