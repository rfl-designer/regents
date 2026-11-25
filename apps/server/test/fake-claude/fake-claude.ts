/**
 * `fake-claude`: um processo de verdade no lugar do binário `claude` (Spec, "Testing Decisions").
 *
 * Chamado como `bun fake-claude.ts --fake-home <pasta> <argv do claude...>`, normalmente
 * pelo wrapper `<pasta>/bin/claude` que `fakeClaude()` cria. Na `<pasta>`:
 * - `script.json`: o roteiro (`FakeClaudeScript`), relido a cada start;
 * - `calls.jsonl`: uma linha por start (argv, cwd, env), para o teste afirmar o que chegou.
 *
 * O "login" fica na pasta de `CLAUDE_CONFIG_DIR`, como no binário real: `.credentials.json`
 * (o token falso, 0600) e `.claude.json` (a conta). Sem `CLAUDE_CONFIG_DIR`, recusa rodar:
 * o Shearim sempre aponta uma pasta de Conta.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_FAKE_ACCOUNT,
  FAKE_ACCESS_TOKEN,
  FAKE_LOGIN_CODE,
  type FakeAccount,
  type FakeClaudeCall,
  type FakeClaudeScript,
  type FakeClaudeSignal,
  type FakeEnd,
  type FakeMcpEntry,
  type FakeRun,
} from "./script";

const [flag, home, ...argv] = process.argv.slice(2);
if (flag !== "--fake-home" || !home) {
  console.error("fake-claude: chame com --fake-home <pasta> <argv>");
  process.exit(2);
}

const isPrint = argv.includes("-p") || argv.includes("--print");

/** Registra o start. O `-p` lê o stdin até o fim antes (o prompt chega por ali). */
function logCall(stdin?: string) {
  const call: FakeClaudeCall = {
    pid: process.pid,
    argv,
    ...(stdin !== undefined ? { stdin } : {}),
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  };
  appendFileSync(join(home!, "calls.jsonl"), `${JSON.stringify(call)}\n`);
}
if (!isPrint) logCall();

const scriptFile = join(home, "script.json");
const script: FakeClaudeScript = existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, "utf8")) : {};

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) {
  console.error("fake-claude: CLAUDE_CONFIG_DIR não definido");
  process.exit(2);
}
const accountFile = join(configDir, ".claude.json");
const credentialsFile = join(configDir, ".credentials.json");

function loggedInAccount(): FakeAccount | undefined {
  if (!existsSync(accountFile) || !existsSync(credentialsFile)) return undefined;
  return JSON.parse(readFileSync(accountFile, "utf8")).oauthAccount;
}

/** Fica vivo sem fazer nada até levar um sinal. */
function hangForever(): Promise<never> {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
}

const write = (text: string) => process.stdout.write(text);

// ---------- auth login ----------

async function authLogin(): Promise<number> {
  const login = script.login ?? {};
  const mode = login.mode ?? "ok";
  if (mode === "silent") return hangForever();
  if (mode === "die") {
    console.error("Error: failed to start the sign-in flow");
    return 1;
  }

  const state = crypto.randomUUID().replaceAll("-", "");
  const url =
    "https://claude.ai/oauth/authorize?code=true&client_id=fake-client&response_type=code" +
    `&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=${state}`;
  // Como o 2.1.30x: a URL vem dentro de um hyperlink OSC 8, e o prompt não termina em \n.
  // O host é o que o 2.1.331 imprimiu num smoke do #25 (claude.ai); o Shearim não depende dele.
  write("Opening browser to sign in…\n");
  write(`If the browser didn't open, visit: \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\\n`);
  write("Paste code here if prompted > ");

  let code = "";
  for await (const line of console) {
    code = line.trim();
    break;
  }
  if (code !== (login.code ?? FAKE_LOGIN_CODE)) {
    write(`\nLogin failed: invalid code ${code}\n`);
    return 1;
  }
  const account: FakeAccount = { ...DEFAULT_FAKE_ACCOUNT, ...login.account };
  mkdirSync(configDir!, { recursive: true });
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS_TOKEN } }), {
    mode: 0o600,
  });
  writeFileSync(accountFile, JSON.stringify({ oauthAccount: account }));
  write("\nLogin successful.\n");
  return 0;
}

// ---------- auth status / logout ----------

function authStatus(): number {
  const account = loggedInAccount();
  const common = {
    apiProvider: "firstParty",
    configDirectory: configDir,
    analyticsDisabled: false,
  };
  if (!account) {
    write(`${JSON.stringify({ loggedIn: false, authMethod: "none", ...common }, null, 2)}\n`);
    return 1;
  }
  write(
    `${JSON.stringify(
      {
        loggedIn: true,
        authMethod: "claude.ai",
        ...common,
        email: account.email,
        orgId: account.orgId,
        orgName: account.orgName,
        subscriptionType: account.subscriptionType,
        planTier: account.planTier,
        loginExpiresAt: account.loginExpiresAt,
        storedClaudeAiLogin: true,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function authLogout(): number {
  rmSync(credentialsFile, { force: true });
  rmSync(accountFile, { force: true });
  write("Successfully logged out from your Anthropic account.\n");
  return 0;
}

// ---------- claude -p (stream-json) ----------

const sessionId = crypto.randomUUID();
const line = (obj: Record<string, unknown>) => write(`${JSON.stringify({ ...obj, session_id: sessionId })}\n`);
const modelArg = () => (argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined) ?? "default";

function streamText(text: string) {
  ev({ type: "message_start", message: { id: "msg_fake", role: "assistant", model: modelArg(), content: [] } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const piece of text.match(/.{1,8}/gs) ?? []) {
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
  }
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

const usage = { input_tokens: 10, output_tokens: 1 };

/** O próximo roteiro do `-p`: o primeiro da fila `runs` (que sai do arquivo), ou `run`. */
function nextRun(): FakeRun {
  const queued = script.runs?.[0];
  if (queued) {
    writeFileSync(scriptFile, JSON.stringify({ ...script, runs: script.runs!.slice(1) }));
    return queued;
  }
  return script.run ?? { kind: "reply", text: "ok" };
}

/** Sinais: registra cada um e reage como o roteiro manda (o padrão é o do binário real). */
function handleSignals(run: FakeRun) {
  const log = (signal: FakeClaudeSignal["signal"]) =>
    appendFileSync(
      join(home!, "signals.jsonl"),
      `${JSON.stringify({ pid: process.pid, signal, at: Date.now() } satisfies FakeClaudeSignal)}\n`,
    );
  process.on("SIGINT", () => {
    log("SIGINT");
    if ((run.onSigint ?? "abort") === "ignore") return;
    line({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      api_error_status: null,
      num_turns: 1,
      total_cost_usd: 0,
      usage,
    });
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("SIGTERM");
    if ((run.onSigterm ?? "exit") === "ignore") return;
    process.exit(143);
  });
}

function errorEnd(end: Extract<FakeEnd, { result: "error" }>): number {
  const message = end.message ?? `API Error: ${end.error ?? "unknown"}`;
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: message }] },
    ...(end.error ? { error: end.error } : {}),
  });
  // Como o binário real: mesmo com erro, `subtype` pode vir "success". Decide-se por `is_error`.
  line({
    type: "result",
    subtype: "success",
    is_error: true,
    result: message,
    terminal_reason: end.terminalReason ?? "api_error",
    api_error_status: end.apiErrorStatus ?? null,
    num_turns: 1,
    total_cost_usd: 0,
    usage,
  });
  return 1;
}

function successEnd(end: Extract<FakeEnd, { result: "success" }>, text: string): number {
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: end.text ?? text,
    terminal_reason: "completed",
    api_error_status: null,
    num_turns: 1,
    total_cost_usd: end.costUsd ?? 0.0001,
    usage: end.usage ?? usage,
    ...(end.credentialExpiresAt ? { credential_expires_at: end.credentialExpiresAt } : {}),
    ...(end.structuredOutput !== undefined ? { structured_output: end.structuredOutput } : {}),
  });
  return 0;
}

let blockIndex = 0;
const ev = (event: Record<string, unknown>) => line({ type: "stream_event", event });

// ---------- o cliente MCP (`{ tool }`) ----------

const logMcp = (entry: Omit<FakeMcpEntry, "pid">) =>
  appendFileSync(join(home!, "mcp.jsonl"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);

/** O servidor do `--mcp-config` (JSON ou caminho de arquivo, como no real); o primeiro, se vários. */
function mcpServer() {
  const raw = argv.includes("--mcp-config") ? argv[argv.indexOf("--mcp-config") + 1] : undefined;
  if (!raw) return undefined;
  const config = JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")) as {
    mcpServers: Record<string, { type?: string; url: string; headers?: Record<string, string> }>;
  };
  const [name, server] = Object.entries(config.mcpServers)[0] ?? [];
  return name && server ? { name, ...server } : undefined;
}

let mcp: { name: string; client: Client; tools: string[] } | undefined;

/** Conecta e lista na primeira chamada, como o Claude Code faz ao subir. */
async function mcpClient() {
  if (mcp) return mcp;
  const server = mcpServer();
  if (!server) throw new Error("sem --mcp-config");
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }),
  );
  const { tools } = await client.listTools();
  mcp = { name: server.name, client, tools: tools.map((t) => t.name) };
  logMcp({ listed: mcp.tools });
  return mcp;
}

let lastToolResult = "";

/**
 * O `tool_use`, a chamada pelo MCP e o `tool_result`, como no `stream-json` do Claude Code
 * (medido no 2.1.331, `docs/research/claude-code-como-motor.md`, item 10): o `tool_use` com o nome
 * `mcp__<servidor>__<Ferramenta>` e `caller: { type: "direct" }`; o `tool_result` numa linha
 * `user`, com o conteúdo em blocos no sucesso e em texto com `is_error: true` na falha; e o turno
 * seguinte começa com outro `message_start`.
 */
async function toolStep(step: { name: string; input?: Record<string, unknown> }) {
  const input = step.input ?? {};
  let conn: Awaited<ReturnType<typeof mcpClient>>;
  try {
    conn = await mcpClient();
  } catch (err) {
    logMcp({ refused: String(err) });
    lastToolResult = "";
    return;
  }
  const id = `toolu_fake_${blockIndex}`;
  const index = blockIndex++;
  const name = `mcp__${conn.name}__${step.name}`;
  const caller = { type: "direct" };
  ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {}, caller } });
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  ev({ type: "content_block_stop", index });
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input, caller }] } });
  let result: { content: string; isError: boolean };
  try {
    const called = await conn.client.callTool({ name: step.name, arguments: input });
    const content = (called.content as { type: string; text?: string }[])
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("");
    result = { content, isError: called.isError === true };
  } catch (err) {
    logMcp({ refused: String(err) });
    result = { content: String(err), isError: true };
  }
  logMcp({ called: step.name, input, result });
  lastToolResult = result.content;
  line({
    type: "user",
    message: {
      role: "user",
      content: [
        result.isError
          ? { type: "tool_result", content: result.content, is_error: true, tool_use_id: id }
          : { tool_use_id: id, type: "tool_result", content: [{ type: "text", text: result.content }] },
      ],
    },
  });
  // O turno seguinte do modelo.
  ev({ type: "message_start", message: { id: "msg_fake_2", role: "assistant", model: modelArg(), content: [] } });
}

/** Uma tool nativa (`{ native }`): o mesmo desenho do `tool_use`/`tool_result` das do MCP. */
function nativeStep(step: { name: string; input?: Record<string, unknown>; error?: string; hang?: true }) {
  const input = step.input ?? {};
  const id = `toolu_fake_${blockIndex}`;
  const index = blockIndex++;
  const caller = { type: "direct" };
  const tools = argv.includes("--tools") ? argv[argv.indexOf("--tools") + 1]!.split(",") : [];
  ev({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: step.name, input: {}, caller },
  });
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  ev({ type: "content_block_stop", index });
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: step.name, input, caller }] },
  });
  if (step.hang) return true;
  const error = tools.includes(step.name)
    ? step.error
    : `<tool_use_error>Error: No such tool available: ${step.name}</tool_use_error>`;
  lastToolResult = error ?? `Resultado de ${step.name}.`;
  line({
    type: "user",
    message: {
      role: "user",
      content: [
        error
          ? { type: "tool_result", content: error, is_error: true, tool_use_id: id }
          : { tool_use_id: id, type: "tool_result", content: [{ type: "text", text: lastToolResult }] },
      ],
    },
  });
  ev({ type: "message_start", message: { id: "msg_fake_2", role: "assistant", model: modelArg(), content: [] } });
  return false;
}

async function steps(run: Extract<FakeRun, { kind: "steps" }>): Promise<number> {
  ev({ type: "message_start", message: { id: "msg_fake", role: "assistant", model: modelArg(), content: [] } });
  let text = "";
  for (const step of run.steps) {
    if ("text" in step) {
      const index = blockIndex++;
      const body = step.text.replaceAll("{resultado}", lastToolResult);
      ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of body.match(/.{1,8}/gs) ?? []) {
        ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
      ev({ type: "content_block_stop", index });
      text += body;
    } else if ("tool" in step) {
      await toolStep(step.tool);
    } else if ("native" in step) {
      if (nativeStep(step.native)) return hangForever();
    } else if ("thinking" in step) {
      const index = blockIndex++;
      ev({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      ev({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "" } });
      ev({ type: "content_block_stop", index });
    } else if ("sleepMs" in step) {
      await Bun.sleep(step.sleepMs);
    } else if ("hang" in step) {
      return hangForever();
    } else if ("apiRetry" in step) {
      line({
        type: "system",
        subtype: "api_retry",
        attempt: step.apiRetry.attempt,
        max_retries: step.apiRetry.max,
        retry_delay_ms: 1000,
        error_status: step.apiRetry.errorStatus ?? 529,
        error: step.apiRetry.error ?? "overloaded",
      });
    } else if ("rateLimit" in step) {
      line({ type: "rate_limit_event", rate_limit_info: step.rateLimit });
    } else if ("die" in step) {
      return step.die;
    }
  }
  const end: FakeEnd = run.end ?? { result: "success" };
  if (end.result === "error") return errorEnd(end);
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const code = successEnd(end, text);
  return end.lingers ? hangForever() : code;
}

async function print(): Promise<number> {
  // O prompt chega pelo stdin (ou como argumento, na validação); lê até o fim antes de começar.
  const stdin = await new Response(Bun.stdin.stream()).text();
  const run: FakeRun = loggedInAccount()
    ? nextRun()
    : { kind: "error", error: "authentication_failed", apiErrorStatus: 401, message: "Not logged in" };
  // Os sinais já são tratados quando o start aparece no log: o teste pode sinalizar dali em diante.
  handleSignals(run);
  logCall(stdin);
  line({ type: "system", subtype: "init", model: modelArg(), tools: [] });

  if (run.kind === "hang") return hangForever();
  if (run.kind === "die") return run.exitCode ?? 1;
  if (run.kind === "steps") return steps(run);
  if (run.kind === "reply") {
    const text = run.text ?? "ok";
    streamText(text);
    return successEnd({ result: "success", credentialExpiresAt: run.credentialExpiresAt }, text);
  }
  return errorEnd({ result: "error", error: run.error, apiErrorStatus: run.apiErrorStatus, message: run.message });
}

// ---------- roteamento do argv ----------

async function main(): Promise<number> {
  const [a, b] = argv;
  if (a === "auth" && b === "login") return authLogin();
  if (a === "auth" && b === "status") return authStatus();
  if (a === "auth" && b === "logout") return authLogout();
  if (isPrint) return print();
  console.error(`fake-claude: argv não roteirizado: ${argv.join(" ")}`);
  return 2;
}

process.exit(await main());
