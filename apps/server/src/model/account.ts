/**
 * O cérebro da Conta (Spec, módulo 7, "Pela Conta"; ADR 0006): um `claude -p` novo por execução,
 * sem sessão, na pasta da Conta do Membro, com o `stream-json` traduzido para os eventos da porta.
 *
 * - O contexto fixo vai em `--system-prompt` (no lugar do prompt de programação do Claude Code);
 *   as mensagens vão pelo stdin, que fecha em seguida.
 * - As tools, os settings, o MCP e os slash commands ficam desligados.
 * - O `env` é o de `accountEnv`: `CLAUDE_CONFIG_DIR`, as novas tentativas (3) e as esperas (90 s).
 * - A falha se lê por `result.is_error`, `assistant.error` e `terminal_reason`; nunca por
 *   `subtype` nem só pelo exit code (nota 02: token inválido sai 1 com `subtype: "success"`).
 * - O encerramento (vigia, cancelamento, parada) é `SIGINT`, espera, `SIGTERM`, espera, `SIGKILL`:
 *   matar à força no meio de uma renovação pode deslogar a pasta (anthropics/claude-code#102985).
 *
 * O parse depende da versão do Claude Code: a imagem o fixa, com `DISABLE_AUTOUPDATER=1`.
 */
import { ClaudeMissing, type ClaudeProcess, drain, type ProcessTracker, spawnClaude } from "../accounts/claude-cli";
import {
  type ModelBrain,
  type ModelEvent,
  type ModelRequest,
  NOT_STRUCTURED_REASON,
  type TerminalModelEvent,
} from "./port";

/** Quanto o encerramento espera depois do `SIGINT` antes do `SIGTERM`. */
export const SIGINT_GRACE_MS = 10_000;
/** Quanto espera depois do `SIGTERM` antes do `SIGKILL`. */
export const SIGTERM_GRACE_MS = 5_000;

export interface StopGrace {
  sigintMs: number;
  sigtermMs: number;
}

/** No Linux, um argumento só passa de 128 KiB (`MAX_ARG_STRLEN`); o contexto fixo vai num. */
const MAX_SYSTEM_PROMPT_BYTES = 120_000;

export function accountBrain(opts: {
  /** O binário `claude` (nos testes, o `fake-claude`). */
  claudeBin: string;
  procs: ProcessTracker;
  /** Os prazos do encerramento. Padrão: 10 s e 5 s; os testes injetam limites curtos. */
  stopGrace?: StopGrace;
}): ModelBrain {
  const grace = opts.stopGrace ?? { sigintMs: SIGINT_GRACE_MS, sigtermMs: SIGTERM_GRACE_MS };

  return {
    async *run(request, signal) {
      const { payer } = request;
      if (payer.kind !== "account") throw new Error("accountBrain só atende pagamento pela Conta");
      if (signal.aborted) return;
      if (Buffer.byteLength(request.system) > MAX_SYSTEM_PROMPT_BYTES) {
        yield {
          type: "failed",
          reason: "o contexto fixo do Agente é grande demais para o Claude Code",
          retryable: false,
        };
        return;
      }

      let proc: ClaudeProcess;
      try {
        proc = opts.procs.track(spawnClaude(opts.claudeBin, argsFor(request), payer.configDir));
      } catch (err) {
        if (!(err instanceof ClaudeMissing)) throw err;
        yield { type: "failed", reason: "o Claude Code não está instalado neste servidor", retryable: false };
        return;
      }
      let stopped: Promise<void> | undefined;
      const stop = () => {
        stopped ??= terminate(proc, grace);
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        proc.stdin.write(request.messages.map((m) => m.content).join("\n\n"));
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch {
        // o processo já saiu; o fim conta como morte
      }
      void drain(proc.stderr);

      const reading = streamReading(request);
      try {
        for await (const raw of lines(proc.stdout)) {
          // Depois do abort, o resto (o `result` do SIGINT) é drenado sem virar evento.
          if (signal.aborted) continue;
          const event = reading.read(raw);
          if (event) yield event;
          // O `result` é o fim. Um processo que não sai depois dele é encerrado pelo mesmo caminho.
          if (reading.finished()) {
            if (!(await exitsWithin(proc, grace.sigintMs))) stop();
            break;
          }
        }
        await proc.exited;
      } finally {
        signal.removeEventListener("abort", stop);
        // Quem consome parou de ler antes do fim: encerra pelo mesmo caminho.
        if (proc.exitCode === null && proc.signalCode === null) stop();
        await stopped;
      }
      if (signal.aborted) return;
      yield* reading.end();
    },
  };
}

function argsFor(request: ModelRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model",
    request.model,
    "--system-prompt",
    request.system,
  ];
  if (request.output) args.push("--json-schema", JSON.stringify(request.output.schema));
  return args;
}

/** Se o processo sai em até `ms`. */
async function exitsWithin(proc: ClaudeProcess, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([proc.exited.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `SIGINT`, até `sigintMs`; `SIGTERM`, até `sigtermMs`; `SIGKILL`. Resolve quando o processo sai. */
async function terminate(proc: ClaudeProcess, grace: StopGrace) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGINT");
  if (await exitsWithin(proc, grace.sigintMs)) return;
  proc.kill("SIGTERM");
  if (await exitsWithin(proc, grace.sigtermMs)) return;
  proc.kill("SIGKILL");
  await proc.exited;
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        yield buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
      }
    }
  } catch {
    // o processo morreu; o que chegou até aqui conta
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Lê as linhas do `stream-json` uma a uma e, no fim, decide o evento terminal. */
function streamReading(request: ModelRequest) {
  /** Um `rate_limit_event` rejeitado: a Conta bateu no limite até `resetsAt`. */
  let limited: { resetsAt: Date | null } | undefined;
  /** A categoria de `assistant.error`. */
  let category: string | undefined;
  let result: Json | undefined;

  return {
    /** Já chegou o `result`. */
    finished: () => result !== undefined,

    read(raw: string): ModelEvent | undefined {
      let line: Json;
      try {
        line = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (line.type === "stream_event") {
        const event = progress(line.event as Json | undefined);
        // Com saída estruturada, a resposta é o `structured_output` do fim: o texto do caminho só
        // conta como progresso.
        return request.output && event?.type === "text" ? { type: "thinking" } : event;
      }
      if (line.type === "system" && line.subtype === "api_retry") {
        return { type: "api_retry", attempt: num(line.attempt) ?? 1, max: num(line.max_retries) ?? 1 };
      }
      if (line.type === "rate_limit_event") {
        const info = (line.rate_limit_info ?? {}) as Json;
        // `allowed_warning` (85%) e o uso extra (`allowed`, `isUsingOverage`) não mudam nada.
        if (info.status === "rejected") {
          const at = num(info.resetsAt);
          limited = { resetsAt: at === undefined ? null : new Date(at * 1000) };
        }
      } else if (line.type === "assistant") {
        category = str(line.error) ?? category;
      } else if (line.type === "result") {
        result = line;
      }
      return undefined;
    },

    /** O fim: o evento terminal e, com saída estruturada, antes dele o `structured_output` como texto. */
    end(): ModelEvent[] {
      if (result?.is_error === false) {
        let structured: ModelEvent[] = [];
        if (request.output) {
          if (result.structured_output === undefined) {
            return [{ type: "failed", reason: NOT_STRUCTURED_REASON, retryable: true }];
          }
          structured = [{ type: "text", text: JSON.stringify(result.structured_output) }];
        }
        const usage = (result.usage ?? {}) as Json;
        const expires = str(result.credential_expires_at);
        return [
          ...structured,
          {
            type: "done",
            usage: { inputTokens: num(usage.input_tokens) ?? 0, outputTokens: num(usage.output_tokens) ?? 0 },
            costUsd: num(result.total_cost_usd) ?? 0,
            ...(expires && !Number.isNaN(Date.parse(expires)) ? { credentialExpiresAt: new Date(expires) } : {}),
          },
        ];
      }
      return [this.failure()];
    },

    failure(): TerminalModelEvent {
      // O limite vale mesmo sem `result` (o limite semanal pode sair 1 sem nada).
      if (limited || category === "rate_limit") return { type: "limit", resetsAt: limited?.resetsAt ?? null };
      if (category === "authentication_failed" || result?.api_error_status === 401) return { type: "auth_failed" };
      if (!result) return { type: "failed", reason: "o Claude Code parou sem terminar a resposta", retryable: true };
      return failure(category, str(result.terminal_reason), num(result.api_error_status));
    },
  };
}

/** Um `stream_event` (o evento SSE da Messages API): texto e pensamento são progresso. */
function progress(event: Json | undefined): ModelEvent | undefined {
  if (!event) return undefined;
  if (event.type === "content_block_start" && (event.content_block as Json | undefined)?.type === "thinking") {
    return { type: "thinking" };
  }
  if (event.type === "content_block_delta") {
    const delta = (event.delta ?? {}) as Json;
    if (delta.type === "text_delta") {
      const text = str(delta.text);
      return text ? { type: "text", text } : undefined;
    }
    if (delta.type === "thinking_delta" || delta.type === "signature_delta") return { type: "thinking" };
  }
  return undefined;
}

/** A falha comum, em pt-BR, para completar "Faro não respondeu: …". */
function failure(
  category: string | undefined,
  terminal: string | undefined,
  status: number | undefined,
): ModelEvent & {
  type: "failed";
} {
  const failed = (reason: string, retryable: boolean) => ({ type: "failed" as const, reason, retryable });
  if (terminal === "prompt_too_long") return failed("a conversa ficou longa demais para o modelo", false);
  if (terminal === "structured_output_retry_exhausted") return failed(NOT_STRUCTURED_REASON, true);
  switch (category) {
    case "overloaded":
      return failed("a Anthropic está sobrecarregada", true);
    case "model_not_found":
      return failed("o modelo do Agente não existe na Anthropic", false);
    case "invalid_request":
      return failed("a Anthropic recusou o pedido", false);
    case "max_output_tokens":
      return failed("a resposta passou do tamanho máximo", false);
    case "billing_error":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
      return failed("a Conta do Claude não pode ser usada agora", false);
    case "server_error":
    case "unknown":
      // Inclui o lock de renovação ("another Claude Code process is refreshing it"): falha comum.
      return failed("a Anthropic respondeu com erro", true);
  }
  if (status === 529) return failed("a Anthropic está sobrecarregada", true);
  if (status === 404) return failed("o modelo do Agente não existe na Anthropic", false);
  if (terminal === "aborted_streaming") return failed("a resposta parou no meio", true);
  return failed("o Claude Code respondeu com erro", true);
}
