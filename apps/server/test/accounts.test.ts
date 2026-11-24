import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { AccountDto } from "@shearim/contracts";
import { FAKE_ACCESS_TOKEN, FAKE_LOGIN_CODE } from "./fake-claude";
import { type EventSocket, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };

/** Juliana abre o Workspace (vira Admin); Bruno entra pelo Pedido de entrada, aprovado por ela. */
async function workspace(t: TestApp) {
  await t.addMember(bruno, { by: juliana });
}

async function account(t: TestApp, who: Person): Promise<AccountDto> {
  return (await t.as(who).get("/api/account")).json();
}

/** Lê `account.updated` na conexão até um que satisfaça `done`; devolve esse. */
async function until(aba: EventSocket, done: (a: AccountDto) => boolean): Promise<AccountDto> {
  for (;;) {
    const { account } = await aba.next("account.updated", { timeoutMs: 5_000 });
    if (done(account)) return account;
  }
}
const linkingIs = (state: string) => (a: AccountDto) => a.linking?.state === state;

/** "Ligar minha Conta do Claude" até a URL aparecer. */
async function startLinking(t: TestApp, who: Person, aba: EventSocket) {
  const res = await t.as(who).post("/api/account/linking");
  expect(res.status).toBe(202);
  return until(aba, linkingIs("waiting_code"));
}

/** O fluxo inteiro: ligar, colar o código certo e esperar o fim (ligada ou não). */
async function link(t: TestApp, who: Person, aba: EventSocket) {
  await startLinking(t, who, aba);
  await t.as(who).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
  return until(aba, (a) => a.linking === null || ["failed", "duplicate"].includes(a.linking.state));
}

describe("Minha Conta", () => {
  test("um Membro novo vê a Conta como Não ligada, com a ligação oferecida", async () => {
    const t = await testApp();
    await workspace(t);

    expect(await account(t, bruno)).toEqual({ status: { state: "not_linked" }, linking: null, offer: true });
  });

  test('"Agora não" deixa de oferecer a ligação ao entrar, e "Minha Conta" continua com ela', async () => {
    const t = await testApp();
    await workspace(t);

    const res = await t.as(bruno).post("/api/account/not-now");

    expect(res.status).toBe(200);
    expect(await account(t, bruno)).toEqual({ status: { state: "not_linked" }, linking: null, offer: false });
    expect((await account(t, juliana)).offer).toBe(true);
  });
});

describe("Ligar minha Conta do Claude", () => {
  test("mostra a URL da Anthropic, entrega o código colado e a Conta fica Ligada com e-mail e plano", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);

    const esperando = await startLinking(t, bruno, aba);
    expect(esperando.linking).toEqual({
      state: "waiting_code",
      url: expect.stringMatching(/^https:\/\/claude\.ai\/oauth\/authorize\?\S+$/),
      expiresAt: "2026-11-24T12:10:00.000Z",
    });

    const res = await t.as(bruno).post("/api/account/linking/code", { code: `  ${FAKE_LOGIN_CODE}\n` });
    expect(res.status).toBe(202);
    expect((await res.json()).linking).toEqual({ state: "checking" });

    const ligada = await until(aba, (a) => a.linking === null);
    expect(ligada).toEqual({
      status: { state: "linked", email: "fulana@exemplo.com", plan: "Claude Max" },
      linking: null,
      offer: false,
    });
    expect(await account(t, bruno)).toEqual(ligada);
    expect(JSON.stringify(aba.received())).not.toContain(FAKE_ACCESS_TOKEN);
  });

  test("o login roda numa pasta nova do Membro, com o env montado do zero, e a validação usa a mesma pasta", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    process.env.ANTHROPIC_API_KEY = "sk-ant-do-servidor";
    try {
      await link(t, bruno, aba);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }

    const [login] = t.claude.callsOf("auth login");
    const dir = login!.env.CLAUDE_CONFIG_DIR!;
    expect(dir.startsWith(`${t.accountsRoot}/`)).toBe(true);
    expect(login!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(t.claude.callsOf("auth status").map((c) => c.env.CLAUDE_CONFIG_DIR)).toEqual([dir]);
    const [validacao] = t.claude.callsOf("-p");
    expect(validacao!.env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(validacao!.argv).toContain("--no-session-persistence");
    expect(validacao!.argv[validacao!.argv.indexOf("--tools") + 1]).toBe("");
  });

  test("cada ligação começa numa pasta nova", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);

    await startLinking(t, bruno, aba);
    await t.as(bruno).post("/api/account/linking"); // "Começar de novo" no meio
    await until(aba, linkingIs("waiting_code"));

    const [primeira, segunda] = t.claude.callsOf("auth login").map((c) => c.env.CLAUDE_CONFIG_DIR!);
    expect(primeira).not.toBe(segunda);
    expect(existsSync(primeira!)).toBe(false);
    expect(existsSync(segunda!)).toBe(true);
  });

  test("um código errado aparece como falha, e a pasta nova é apagada", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await startLinking(t, bruno, aba);

    await t.as(bruno).post("/api/account/linking/code", { code: "outro-codigo" });

    const falhou = await until(aba, linkingIs("failed"));
    expect(falhou.linking).toEqual({
      state: "failed",
      message: "Esse código não funcionou. Comece de novo e cole o código que a página da Anthropic mostrar.",
    });
    expect(falhou.status).toEqual({ state: "not_linked" });
    expect(existsSync(t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  test("colar um código sem login esperando é recusado", async () => {
    const t = await testApp();
    await workspace(t);

    const res = await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      message: "Nenhum login está esperando um código. Comece de novo.",
    });
  });

  test("se o Claude Code não consegue abrir o login, a tela diz isso", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    t.claude.script({ login: { mode: "die" } });

    await t.as(bruno).post("/api/account/linking");

    expect((await until(aba, linkingIs("failed"))).linking).toEqual({
      state: "failed",
      message: "Não conseguimos abrir o login da Anthropic. Tente de novo em alguns minutos.",
    });
  });
});

describe("a espera pelo código", () => {
  test("dura 10 minutos; depois o processo é encerrado e a tela oferece começar de novo", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await startLinking(t, bruno, aba);

    t.clock.advance(10 * 60_000 - 1);
    t.clock.advance(1);

    const vencida = await until(aba, linkingIs("expired"));
    expect(vencida.linking).toEqual({ state: "expired" });
    expect(existsSync(t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!)).toBe(false);
    const res = await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
    expect(res.status).toBe(409);
  });

  test("vale também quando o Claude Code fica mudo e nunca mostra a URL", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    t.claude.script({ login: { mode: "silent" } });
    const res = await t.as(bruno).post("/api/account/linking");
    expect((await res.json()).linking).toEqual({ state: "starting" });

    t.clock.advance(10 * 60_000);

    expect((await until(aba, linkingIs("expired"))).linking).toEqual({ state: "expired" });
  });

  test("um minuto antes do fim, ainda dá para colar o código", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await startLinking(t, bruno, aba);

    t.clock.advance(9 * 60_000);
    await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
    t.clock.advance(90_000); // passa dos 10 minutos do começo

    expect((await until(aba, (a) => a.linking === null)).status.state).toBe("linked");
  });

  test('"Começar de novo" depois de vencida abre um login novo', async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await startLinking(t, bruno, aba);
    t.clock.advance(10 * 60_000);
    await until(aba, linkingIs("expired"));

    const outra = await startLinking(t, bruno, aba);

    expect(outra.linking?.state).toBe("waiting_code");
    expect(t.claude.callsOf("auth login")).toHaveLength(2);
  });
});

describe("a chamada mínima de validação", () => {
  const casos: [string, Parameters<TestApp["claude"]["script"]>[0]["run"], string][] = [
    [
      "a assinatura sem Claude Code",
      { kind: "error", error: "billing_error", apiErrorStatus: 403 },
      "Sua assinatura do Claude não inclui uso pelo Claude Code.",
    ],
    [
      "um 403 sem categoria",
      { kind: "error", error: "unknown", apiErrorStatus: 403 },
      "Sua assinatura do Claude não inclui uso pelo Claude Code.",
    ],
    [
      "a organização que não permite",
      { kind: "error", error: "oauth_org_not_allowed", apiErrorStatus: 403 },
      "A sua organização no Claude não permite uso pelo Claude Code.",
    ],
    [
      "o login recusado",
      { kind: "error", error: "authentication_failed", apiErrorStatus: 401 },
      "A Anthropic não aceitou o login. Comece de novo.",
    ],
    [
      "a API fora do ar",
      { kind: "error", error: "overloaded", apiErrorStatus: 529 },
      "Não conseguimos conferir a sua Conta agora. Tente de novo em alguns minutos.",
    ],
    [
      "o processo que morre sem resultado",
      { kind: "die", exitCode: 137 },
      "Não conseguimos conferir a sua Conta agora. Tente de novo em alguns minutos.",
    ],
  ];
  for (const [caso, run, message] of casos) {
    test(`explica em linguagem simples: ${caso}`, async () => {
      const t = await testApp();
      await workspace(t);
      const aba = await t.socket(bruno);
      t.claude.script({ run });

      const fim = await link(t, bruno, aba);

      expect(fim).toEqual({ status: { state: "not_linked" }, linking: { state: "failed", message }, offer: true });
      expect(existsSync(t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!)).toBe(false);
      expect(t.claude.callsOf("auth logout")).toHaveLength(0);
    });
  }

  test("bater no limite do plano não impede ligar: a Conta é válida", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    t.claude.script({ run: { kind: "error", error: "rate_limit", apiErrorStatus: 429 } });

    expect((await link(t, bruno, aba)).status.state).toBe("linked");
  });

  test("se o Claude não responde, a validação desiste depois de 6 minutos e diz isso", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    t.claude.script({ run: { kind: "hang" } });
    await startLinking(t, bruno, aba);
    await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
    while (t.claude.callsOf("-p").length === 0) await Bun.sleep(10);

    t.clock.advance(6 * 60_000);

    expect((await until(aba, linkingIs("failed"))).linking).toEqual({
      state: "failed",
      message: "Não conseguimos conferir a sua Conta agora. Tente de novo em alguns minutos.",
    });
  });

  test('fechar o aviso de falha volta para "Não ligada"', async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    t.claude.script({ run: { kind: "error", error: "billing_error", apiErrorStatus: 403 } });
    await link(t, bruno, aba);

    const res = await t.as(bruno).delete("/api/account/linking");

    expect(await res.json()).toEqual({ status: { state: "not_linked" }, linking: null, offer: true });
  });
});

describe("assinatura já ligada a outro Membro", () => {
  test('avisa antes de validar; "Ligar mesmo assim" liga', async () => {
    const t = await testApp();
    await workspace(t);
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");
    expect((await link(t, juliana, daJuliana)).status.state).toBe("linked");

    const aviso = await link(t, bruno, doBruno);
    expect(aviso.linking).toEqual({ state: "duplicate" });
    expect(t.claude.callsOf("-p")).toHaveLength(1); // só a validação da Juliana

    const res = await t.as(bruno).post("/api/account/linking/confirm");
    expect(res.status).toBe(202);
    const ligada = await until(doBruno, (a) => a.linking === null);
    expect(ligada.status).toEqual({ state: "linked", email: "fulana@exemplo.com", plan: "Claude Max" });
    expect((await account(t, juliana)).status.state).toBe("linked");
  });

  test('"Cancelar" apaga o login novo sem logout e deixa a Conta Não ligada', async () => {
    const t = await testApp();
    await workspace(t);
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");
    await link(t, juliana, daJuliana);
    await link(t, bruno, doBruno);

    const res = await t.as(bruno).delete("/api/account/linking");

    expect(await res.json()).toEqual({ status: { state: "not_linked" }, linking: null, offer: true });
    const dirDoBruno = t.claude.callsOf("auth login")[1]!.env.CLAUDE_CONFIG_DIR!;
    expect(existsSync(dirDoBruno)).toBe(false);
    expect(t.claude.callsOf("auth logout")).toHaveLength(0);
  });

  test("outra assinatura não dispara o aviso", async () => {
    const t = await testApp();
    await workspace(t);
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");
    await link(t, juliana, daJuliana);
    t.claude.script({ login: { account: { email: "bruno@exemplo.com", subscriptionType: "pro" } } });

    const fim = await link(t, bruno, doBruno);

    expect(fim.status).toEqual({ state: "linked", email: "bruno@exemplo.com", plan: "Claude Pro" });
  });
});

describe("Desligar", () => {
  test("roda claude auth logout na pasta da Conta, apaga a pasta e a Conta volta a Não ligada", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await link(t, bruno, aba);
    const dir = t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!;
    expect(existsSync(dir)).toBe(true);

    const res = await t.as(bruno).delete("/api/account");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toEqual({ state: "not_linked" });
    expect(t.claude.callsOf("auth logout").map((c) => c.env.CLAUDE_CONFIG_DIR)).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect((await until(aba, (a) => a.status.state === "not_linked")).linking).toBeNull();
  });

  test("com a Conta ligada, ligar outra é recusado até desligar (religar é do #35)", async () => {
    const t = await testApp();
    await workspace(t);
    const aba = await t.socket(bruno);
    await link(t, bruno, aba);

    const res = await t.as(bruno).post("/api/account/linking");

    expect(res.status).toBe(409);
    expect(t.claude.callsOf("auth login")).toHaveLength(1);
  });
});

describe("privacidade da Conta", () => {
  test("o Admin não vê nada da Conta de outro Membro, nem pelo HTTP nem pelo WebSocket", async () => {
    const t = await testApp();
    await workspace(t);
    const doAdmin = await t.socket(juliana, "aba da Admin");
    const doBruno = await t.socket(bruno, "aba do Bruno");

    await link(t, bruno, doBruno);
    t.events.publish("everyone", {
      type: "message.created",
      message: {
        id: crypto.randomUUID(),
        channelId: crypto.randomUUID(),
        body: "marca",
        author: { kind: "member", id: crypto.randomUUID(), displayName: "x" },
        originMessageId: null,
        createdAt: "2026-11-24T12:00:00.000Z",
      },
    });

    await doAdmin.next("message.created");
    expect(doAdmin.received().map((e) => e.type)).toEqual(["ready", "message.created"]);
    expect(await account(t, juliana)).toEqual({ status: { state: "not_linked" }, linking: null, offer: true });
    expect(JSON.stringify(await (await t.as(juliana).get("/api/me")).json())).not.toContain("fulana@exemplo.com");
  });
});
