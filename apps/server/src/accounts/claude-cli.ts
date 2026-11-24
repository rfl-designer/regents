/**
 * Adaptador do binário `claude` para as Contas (ADR 0005): `auth login`, `auth status --json`,
 * `auth logout` e a chamada mínima de validação. Cada processo roda com `CLAUDE_CONFIG_DIR`
 * na pasta da Conta e um `env` montado do zero.
 *
 * O Shearim nunca lê a pasta: só o que o próprio Claude Code imprime. O stdout do login
 * repete o código colado, então nada daqui vai para log.
 */
import type { Clock } from "../clock";

/** Modelo barato da chamada mínima de validação. */
export const VALIDATION_MODEL = "claude-haiku-5-5";

/**
 * O `env` de todo processo do `claude` de uma Conta. Montado do zero: o CLI prefere
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` e `CLAUDE_CODE_OAUTH_TOKEN` à pasta,
 * então nada do ambiente do servidor passa além de `PATH`, `HOME` e o idioma.
 */
export function accountEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "3",
    API_TIMEOUT_MS: "90000",
    CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "90000",
  };
  for (const key of ["PATH", "HOME", "LANG", "TZ"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** O binário não existe ou não pôde ser executado. */
export class ClaudeMissing extends Error {}

type Proc = ReturnType<typeof spawnClaude>;

/** Processos vivos, para o `close()` do app não deixar órfãos. */
export function processTracker() {
  const live = new Set<Proc>();
  return {
    track(proc: Proc) {
      live.add(proc);
      proc.exited.finally(() => live.delete(proc));
      return proc;
    },
    async killAll() {
      const procs = [...live];
      for (const p of procs) p.kill("SIGKILL");
      await Promise.all(procs.map((p) => p.exited));
    },
  };
}
export type ProcessTracker = ReturnType<typeof processTracker>;

function spawnClaude(bin: string, args: string[], configDir: string) {
  try {
    return Bun.spawn([bin, ...args], {
      env: accountEnv(configDir),
      cwd: configDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new ClaudeMissing(String(err));
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: as sequências ESC do terminal são o alvo.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** A URL de login, depois de tirar o hyperlink OSC 8 e as cores. Não depende do texto em volta. */
const LOGIN_URL = /(https:\/\/\S+\/oauth\/authorize\?\S+)\s/;

export interface LoginProcess {
  /** A URL da página de login da Anthropic, ou `null` se o processo saiu sem imprimi-la. */
  url: Promise<string | null>;
  /** Entrega o código colado ao processo que espera por ele. */
  submit(code: string): void;
  exited: Promise<number>;
  kill(): void;
}

export function startLogin(bin: string, configDir: string, procs: ProcessTracker): LoginProcess {
  const proc = procs.track(spawnClaude(bin, ["auth", "login"], configDir));
  const { promise: url, resolve } = Promise.withResolvers<string | null>();
  (async () => {
    const decoder = new TextDecoder();
    let seen = "";
    let found = false;
    try {
      for await (const chunk of proc.stdout) {
        // Depois da URL, o resto (que repete o código) é drenado sem ler, para o processo não travar no pipe.
        if (found) continue;
        seen += decoder.decode(chunk, { stream: true });
        const match = seen.replace(ESCAPES, "").match(LOGIN_URL)?.[1];
        if (match) {
          found = true;
          seen = "";
          resolve(match);
        }
      }
    } catch {
      // o processo morreu
    }
    resolve(null);
  })();
  drain(proc.stderr);
  return {
    url,
    submit(code) {
      try {
        proc.stdin.write(`${code}\n`);
        proc.stdin.end();
      } catch {
        // o processo já saiu; o `exited` conta o fim
      }
    },
    exited: proc.exited,
    kill: () => proc.kill("SIGTERM"),
  };
}

async function drain(stream: ReadableStream<Uint8Array>) {
  try {
    for await (const _ of stream);
  } catch {
    // o processo morreu; nada a ler
  }
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Roda um subcomando até o fim, ou até `timeoutMs` do relógio (aí mata com SIGTERM). */
async function run(
  bin: string,
  args: string[],
  configDir: string,
  opts: { clock: Clock; timeoutMs: number; procs: ProcessTracker },
): Promise<RunResult> {
  const proc = opts.procs.track(spawnClaude(bin, args, configDir));
  proc.stdin.end();
  drain(proc.stderr);
  let timedOut = false;
  const cancel = opts.clock.after(opts.timeoutMs, () => {
    timedOut = true;
    proc.kill("SIGTERM");
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  cancel();
  return { exitCode: timedOut ? null : exitCode, stdout, timedOut };
}

/** O que `claude auth status --json` diz da Conta logada na pasta. */
export interface AuthStatus {
  email: string;
  orgId: string | null;
  subscriptionType: string | null;
  planTier: string | null;
  loginExpiresAt: Date | null;
}

const STATUS_TIMEOUT_MS = 30_000;

/** `null` quando não há login na pasta (ou a saída não é o JSON esperado). Não usa rede. */
export async function authStatus(
  bin: string,
  configDir: string,
  opts: { clock: Clock; procs: ProcessTracker },
): Promise<AuthStatus | null> {
  const r = await run(bin, ["auth", "status", "--json"], configDir, { ...opts, timeoutMs: STATUS_TIMEOUT_MS });
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (s.loggedIn !== true || typeof s.email !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const expires = str(s.loginExpiresAt);
  return {
    email: s.email,
    orgId: str(s.orgId),
    subscriptionType: str(s.subscriptionType),
    planTier: str(s.planTier),
    loginExpiresAt: expires && !Number.isNaN(Date.parse(expires)) ? new Date(expires) : null,
  };
}

export async function authLogout(bin: string, configDir: string, opts: { clock: Clock; procs: ProcessTracker }) {
  await run(bin, ["auth", "logout"], configDir, { ...opts, timeoutMs: STATUS_TIMEOUT_MS });
}

/** O fim da chamada mínima. `category` é o `assistant.error` (ou `timeout` / `no_result`). */
export type Validation = { ok: true } | { ok: false; category: string | null; apiErrorStatus: number | null };

/** A chamada mínima pode passar por até 3 novas tentativas de ~90 s cada. */
const VALIDATION_TIMEOUT_MS = 6 * 60_000;

/**
 * Uma chamada mínima (`claude -p`, Haiku, sem tools) para saber se a Conta usa o Claude Code.
 * Decide por `result.is_error`, nunca por `subtype` nem só pelo exit code (nota 02).
 * Bater no limite do plano não impede ligar: a Conta é válida, só está no limite.
 */
export async function validateAccount(
  bin: string,
  configDir: string,
  opts: { clock: Clock; procs: ProcessTracker },
): Promise<Validation> {
  const args = [
    "-p",
    "Responda apenas: ok",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model",
    VALIDATION_MODEL,
  ];
  const r = await run(bin, args, configDir, { ...opts, timeoutMs: VALIDATION_TIMEOUT_MS });
  if (r.timedOut) return { ok: false, category: "timeout", apiErrorStatus: null };

  let category: string | null = null;
  let result: Record<string, unknown> | undefined;
  let limited = false;
  for (const raw of r.stdout.split("\n")) {
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.type === "assistant" && typeof line.error === "string") category = line.error;
    if (line.type === "rate_limit_event") {
      const info = line.rate_limit_info as { status?: string } | undefined;
      if (info?.status === "rejected") limited = true;
    }
    if (line.type === "result") result = line;
  }
  if (!result) return { ok: false, category: "no_result", apiErrorStatus: null };
  if (result.is_error === false || limited || category === "rate_limit") return { ok: true };
  const status = typeof result.api_error_status === "number" ? result.api_error_status : null;
  return { ok: false, category, apiErrorStatus: status };
}
