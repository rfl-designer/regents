/**
 * O cérebro da Conta (Spec, módulo 7, "Pela Conta"; ADR 0006): um `claude -p` novo por execução,
 * com o `fake-claude` rodando como processo de verdade. Aqui fica o que a borda do servidor não
 * mostra em detalhe: a linha de comando, a tradução do `stream-json` para os eventos da porta e a
 * escalada de sinais com limites curtos injetados. O caminho pela borda está em
 * `account-executions.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTracker } from "../src/accounts/claude-cli";
import { accountBrain, SIGINT_GRACE_MS, SIGTERM_GRACE_MS } from "../src/model/account";
import type { ModelEvent, ModelRequest } from "../src/model/port";
import { type FakeClaude, type FakeRun, fakeClaude, fakeLogin } from "./fake-claude";
import { eventually, onCleanup } from "./harness";

const GRACE = { sigintMs: 300, sigtermMs: 300 };

function setup(run?: FakeRun) {
  const fake = fakeClaude(run ? { run } : {});
  const configDir = mkdtempSync(join(tmpdir(), "shearim-conta-"));
  fakeLogin(configDir);
  const procs = processTracker();
  onCleanup(async () => {
    await procs.killAll();
    fake.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });
  const brain = accountBrain({ claudeBin: fake.bin, procs, stopGrace: GRACE });
  const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
    model: "claude-sonnet-5-5",
    system: "Você é o Faro, do comercial.",
    messages: [{ role: "user", content: "Juliana (pessoa): qual o prazo?" }],
    payer: { kind: "account", memberId: "m-1", configDir },
    ...extra,
  });
  return { fake, configDir, brain, request };
}

async function collect(events: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Roda até o fim com um `signal` que nunca aborta. */
const runToEnd = (s: ReturnType<typeof setup>, extra?: Partial<ModelRequest>) =>
  collect(s.brain.run(s.request(extra), new AbortController().signal));

const lastCall = (fake: FakeClaude) => fake.callsOf("-p").at(-1)!;

describe("a linha de comando", () => {
  test("um claude -p novo, sem sessão, em stream-json, sem tools, sem settings nem MCP, com o modelo e o contexto fixo", async () => {
    const s = setup();

    await runToEnd(s);

    const { argv } = lastCall(s.fake);
    expect(argv[0]).toBe("-p");
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv).toContain("--no-session-persistence");
    expect(flag("--output-format")).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--include-partial-messages");
    expect(flag("--tools")).toBe("");
    expect(flag("--setting-sources")).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    expect(flag("--model")).toBe("claude-sonnet-5-5");
    expect(flag("--system-prompt")).toBe("Você é o Faro, do comercial.");
    expect(argv).not.toContain("--json-schema");
  });

  test("as mensagens do contexto vão pelo stdin, não pelo argv", async () => {
    const s = setup();

    await runToEnd(s);

    const call = lastCall(s.fake);
    expect(call.stdin).toContain("Juliana (pessoa): qual o prazo?");
    expect(call.argv.join(" ")).not.toContain("qual o prazo");
  });

  test("um contexto grande passa inteiro pelo stdin", async () => {
    const s = setup();
    const grande = `Juliana (pessoa): ${"palavra ".repeat(40_000)}fim`;

    await runToEnd(s, { messages: [{ role: "user", content: grande }] });

    expect(lastCall(s.fake).stdin).toBe(grande);
  });

  test("roda na pasta da Conta, com o env do zero e os limites de nova tentativa e de espera", async () => {
    const s = setup();
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-do-servidor";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-do-servidor";
    try {
      await runToEnd(s);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const { env, cwd } = lastCall(s.fake);
    expect(realpathSync(cwd)).toBe(realpathSync(s.configDir));
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: s.configDir,
      CLAUDE_CODE_MAX_RETRIES: "3",
      API_TIMEOUT_MS: "90000",
      CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "90000",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("um pedido de saída estruturada vai como --json-schema, e a decisão volta como o texto", async () => {
    const decision = { decisao: "nenhum", agentes: [], motivo: "ninguém perguntou nada" };
    const s = setup({
      kind: "steps",
      steps: [{ text: "Vou decidir." }],
      end: { result: "success", text: "", structuredOutput: decision },
    });
    const schema = { type: "object", properties: { decisao: { enum: ["responder", "delegar", "nenhum"] } } };

    const events = await runToEnd(s, { output: { schema } });

    const { argv } = lastCall(s.fake);
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!)).toEqual(schema);
    // Só o `structured_output` vira texto; o que o modelo escreveu no caminho conta só como progresso.
    const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    expect(JSON.parse(text)).toEqual(decision);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("sem a decisão estruturada pedida, é falha que vale nova tentativa", async () => {
    const s = setup({ kind: "steps", steps: [{ text: "acho que nenhum" }] });

    const events = await runToEnd(s, { output: { schema: { type: "object" } } });

    expect(events.at(-1)).toEqual({
      type: "failed",
      reason: "o modelo não devolveu a decisão no formato pedido",
      retryable: true,
    });
  });
});

describe("o stream-json vira os eventos da porta", () => {
  test("pensamento, nova tentativa e texto em pedaços; o fim traz uso, custo e credential_expires_at", async () => {
    const s = setup({
      kind: "steps",
      steps: [{ thinking: true }, { apiRetry: { attempt: 1, max: 3 } }, { text: "O prazo é sexta." }],
      end: {
        result: "success",
        costUsd: 0.0123,
        usage: { input_tokens: 120, output_tokens: 7 },
        credentialExpiresAt: "2026-12-20T09:00:00.000Z",
      },
    });

    const events = await runToEnd(s);

    // Pedaços seguidos do mesmo pensamento contam como um.
    const semTexto = events.filter(
      (e, i) => e.type !== "text" && !(e.type === "thinking" && events[i - 1]?.type === "thinking"),
    );
    expect(semTexto).toEqual([
      { type: "thinking" },
      { type: "api_retry", attempt: 1, max: 3 },
      {
        type: "done",
        usage: { inputTokens: 120, outputTokens: 7 },
        costUsd: 0.0123,
        credentialExpiresAt: new Date("2026-12-20T09:00:00.000Z"),
      },
    ]);
    const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    expect(text).toBe("O prazo é sexta.");
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
  });

  test("o result é o fim: um processo que não sai depois dele não segura a resposta", async () => {
    const s = setup({ kind: "steps", steps: [{ text: "Oi." }], end: { result: "success", lingers: true } });

    const events = await runToEnd(s);

    expect(events.at(-1)?.type).toBe("done");
    expect(s.fake.signals(lastCall(s.fake).pid).map((x) => x.signal)).toEqual(["SIGINT"]);
  });

  test("o aviso de 85% e o uso extra não mudam nada: a resposta sai pela Conta", async () => {
    const s = setup({
      kind: "steps",
      steps: [
        { rateLimit: { status: "allowed_warning", rateLimitType: "five_hour" } },
        { rateLimit: { status: "allowed", rateLimitType: "overage", isUsingOverage: true } },
        { text: "Oi." },
      ],
    });

    const events = await runToEnd(s);

    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("a falha se lê por is_error, assistant.error e terminal_reason", () => {
  const resetsAt = Date.parse("2026-11-24T15:45:00.000Z") / 1000;
  const casos: [string, FakeRun, ModelEvent][] = [
    [
      "token inválido: exit 1 com is_error, mesmo com subtype success",
      { kind: "error", error: "authentication_failed", apiErrorStatus: 401 },
      { type: "auth_failed" },
    ],
    [
      "login vencido no meio (authentication_failed depois de texto)",
      {
        kind: "steps",
        steps: [{ text: "Começando" }],
        end: { result: "error", error: "authentication_failed", message: "OAuth session expired" },
      },
      { type: "auth_failed" },
    ],
    [
      "rate_limit_event rejeitado, com a hora em que volta",
      {
        kind: "steps",
        steps: [{ text: "parcial" }, { rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" } }],
        end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
      },
      { type: "limit", resetsAt: new Date("2026-11-24T15:45:00.000Z") },
    ],
    [
      "assistant.error rate_limit sem rate_limit_event",
      { kind: "error", error: "rate_limit", apiErrorStatus: 429 },
      { type: "limit", resetsAt: null },
    ],
    [
      "rate_limit_event rejeitado e o processo sai sem result (limite semanal)",
      { kind: "steps", steps: [{ rateLimit: { status: "rejected", resetsAt } }, { die: 1 }] },
      { type: "limit", resetsAt: new Date("2026-11-24T15:45:00.000Z") },
    ],
    [
      "o server_error do lock de renovação é falha comum",
      {
        kind: "error",
        error: "server_error",
        message: "Failed to refresh OAuth token: another Claude Code process is refreshing it",
      },
      { type: "failed", reason: "a Anthropic respondeu com erro", retryable: true },
    ],
    [
      "sobrecarga",
      { kind: "error", error: "overloaded", apiErrorStatus: 529 },
      { type: "failed", reason: "a Anthropic está sobrecarregada", retryable: true },
    ],
    [
      "modelo que não existe",
      { kind: "error", error: "model_not_found", apiErrorStatus: 404 },
      { type: "failed", reason: "o modelo do Agente não existe na Anthropic", retryable: false },
    ],
    [
      "contexto grande demais (terminal_reason)",
      { kind: "steps", steps: [], end: { result: "error", terminalReason: "prompt_too_long" } },
      { type: "failed", reason: "a conversa ficou longa demais para o modelo", retryable: false },
    ],
    [
      "o processo morre no meio, sem result",
      { kind: "steps", steps: [{ text: "Vou te" }, { die: 1 }] },
      // Só o autor sabe que a execução corria pela Conta (ADR 0005): os outros veem o neutro.
      {
        type: "failed",
        reason: "a resposta parou no meio",
        authorReason: "o Claude Code parou sem terminar a resposta",
        retryable: true,
      },
    ],
    [
      "erro sem categoria",
      { kind: "steps", steps: [], end: { result: "error" } },
      {
        type: "failed",
        reason: "deu erro ao gerar a resposta",
        authorReason: "o Claude Code respondeu com erro",
        retryable: true,
      },
    ],
  ];
  for (const [caso, run, fim] of casos) {
    test(caso, async () => {
      const s = setup(run);

      const events = await runToEnd(s);

      expect(events.at(-1)).toEqual(fim);
      expect(events.filter((e) => ["done", "failed", "auth_failed", "limit"].includes(e.type))).toHaveLength(1);
    });
  }

  test("sem o binário, é falha que nova tentativa não conserta", async () => {
    const s = setup();
    const brain = accountBrain({ claudeBin: "/nao/existe/claude", procs: processTracker(), stopGrace: GRACE });

    const events = await collect(brain.run(s.request(), new AbortController().signal));

    expect(events).toEqual([
      {
        type: "failed",
        reason: "o Shearim não conseguiu rodar a execução",
        authorReason: "o Claude Code não está instalado neste servidor",
        retryable: false,
      },
    ]);
  });

  test("o contexto fixo grande demais para o Claude Code: só o autor vê que é o Claude Code", async () => {
    const s = setup();

    const events = await collect(s.brain.run(s.request({ system: "x".repeat(200_000) }), new AbortController().signal));

    expect(events).toEqual([
      {
        type: "failed",
        reason: "o contexto fixo do Agente é grande demais",
        authorReason: "o contexto fixo do Agente é grande demais para o Claude Code",
        retryable: false,
      },
    ]);
  });
});

describe("encerramento: SIGINT, espera, SIGTERM, espera, SIGKILL", () => {
  test("os prazos padrão são 10 s e 5 s", () => {
    expect(SIGINT_GRACE_MS).toBe(10_000);
    expect(SIGTERM_GRACE_MS).toBe(5_000);
  });

  /** Começa a rodar, espera o processo de pé e aborta; devolve os eventos e o pid. */
  async function abortWhileRunning(s: ReturnType<typeof setup>) {
    const controller = new AbortController();
    const events = collect(s.brain.run(s.request(), controller.signal));
    const call = await eventually("o claude -p subir", async () => lastCall(s.fake));
    const started = Date.now();
    controller.abort("cancelled");
    return { events: await events, pid: call.pid, elapsed: Date.now() - started };
  }

  test("ao abortar, manda SIGINT; o processo encerra limpo e o fluxo termina sem evento de fim", async () => {
    const s = setup({ kind: "steps", steps: [{ text: "Começando a" }, { hang: true }] });

    const { events, pid } = await abortWhileRunning(s);

    expect(s.fake.signals(pid).map((x) => x.signal)).toEqual(["SIGINT"]);
    expect(events.every((e) => e.type === "text")).toBe(true);
  });

  test("se o SIGINT não basta, manda SIGTERM depois da espera", async () => {
    const s = setup({ kind: "hang", onSigint: "ignore" });

    const { events, pid, elapsed } = await abortWhileRunning(s);

    const signals = s.fake.signals(pid);
    expect(signals.map((x) => x.signal)).toEqual(["SIGINT", "SIGTERM"]);
    expect(signals[1]!.at - signals[0]!.at).toBeGreaterThanOrEqual(GRACE.sigintMs - 20);
    expect(elapsed).toBeLessThan(GRACE.sigintMs + GRACE.sigtermMs);
    expect(events).toEqual([]);
  });

  test("se nem o SIGTERM basta, manda SIGKILL depois da segunda espera", async () => {
    const s = setup({ kind: "hang", onSigint: "ignore", onSigterm: "ignore" });

    const { events, pid, elapsed } = await abortWhileRunning(s);

    expect(s.fake.signals(pid).map((x) => x.signal)).toEqual(["SIGINT", "SIGTERM"]);
    expect(elapsed).toBeGreaterThanOrEqual(GRACE.sigintMs + GRACE.sigtermMs - 20);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events).toEqual([]);
  });

  test("abortado antes de começar, nem sobe o processo", async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort("cancelled");

    expect(await collect(s.brain.run(s.request(), controller.signal))).toEqual([]);
    expect(s.fake.callsOf("-p")).toEqual([]);
  });
});
