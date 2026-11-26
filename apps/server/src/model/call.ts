import type { Clock } from "../clock";
import type { ModelEvent, ModelPort, ModelRequest, ModelUsage, TerminalModelEvent } from "./port";

/**
 * Uma chamada de modelo do Shearim sob a vigia (ADR 0003): o que as execuções (`executions.ts`) e
 * a Sincronização da Wiki (`wiki/sync.ts`) dividem. Quem chama decide o que cada evento mostra
 * (`onEvent`) e o que fazer com o fim; aqui ficam a vigia, o texto e o que a API informou que a
 * chamada gastou.
 */

/** Vigia (ADR 0003): quanto um passo pode ficar sem progresso antes de virar falha. */
export const STALL_MS = 2 * 60_000;

/** Contam como progresso para a vigia: texto, pensamento e nova tentativa da API (nunca `ping`). */
export function isProgress(event: ModelEvent) {
  return (
    event.type === "text" || event.type === "thinking" || event.type === "tool_limit" || event.type === "api_retry"
  );
}

/**
 * Um prazo que recomeça a cada progresso e chama `onStall` se vencer. `pause` o suspende (uma
 * Ferramenta rodando, com o prazo dela) até `resume`, que recomeça a contagem.
 */
export function stallWatch(clock: Clock, ms: number, onStall: () => void) {
  let cancel = clock.after(ms, onStall);
  let paused = false;
  const arm = () => {
    cancel();
    cancel = clock.after(ms, onStall);
  };
  return {
    reset() {
      if (!paused) arm();
    },
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      paused = false;
      arm();
    },
    cancel: () => cancel(),
  };
}
export type StallWatch = ReturnType<typeof stallWatch>;

/**
 * O que a API informou que a chamada gastou até agora (o gasto na Chave conta mesmo sem o fim) e
 * se ela chegou ao `done`.
 */
export type Spent = {
  startedAt: Date;
  usage?: { model: string; usage: ModelUsage; costUsd: number };
  succeeded?: boolean;
};

/**
 * Roda um pedido até o fim, com a vigia: sem progresso por `stallMs`, ela aborta o `controller`
 * com `"stalled"`. `onEvent` vê cada evento antes de ele contar (o Andamento mostra o "tentando de
 * novo"); `onWatch` recebe a vigia enquanto ela vale (uma Ferramenta a pausa). O gasto vai em
 * `spent`. Abortado o `signal`, o fluxo termina sem `end`: quem chama lê `signal.reason`.
 */
export async function streamCall(opts: {
  model: ModelPort;
  clock: Clock;
  request: ModelRequest;
  controller: AbortController;
  spent: Spent;
  stallMs?: number;
  onEvent?: (event: ModelEvent) => Promise<void>;
  onWatch?: (watch: StallWatch | undefined) => void;
}): Promise<{ text: string; end: TerminalModelEvent | undefined }> {
  const { model, clock, request, controller, spent } = opts;
  const watchdog = stallWatch(clock, opts.stallMs ?? STALL_MS, () => controller.abort("stalled"));
  opts.onWatch?.(watchdog);
  let text = "";
  let end: TerminalModelEvent | undefined;
  try {
    for await (const event of model.run(request, controller.signal)) {
      if (isProgress(event)) watchdog.reset();
      await opts.onEvent?.(event);
      if (event.type === "text") text += event.text;
      else if (event.type === "usage") spent.usage = { model: event.model, usage: event.usage, costUsd: event.costUsd };
      else if (event.type === "done") {
        end = event;
        spent.usage = { model: request.model, usage: event.usage, costUsd: event.costUsd };
        spent.succeeded = true;
      } else if (event.type !== "thinking" && event.type !== "api_retry" && event.type !== "tool_limit") end = event;
    }
  } finally {
    watchdog.cancel();
    opts.onWatch?.(undefined);
  }
  return { text, end };
}

/** Falhas que uma nova tentativa não conserta: a credencial e o pedido em si. */
export function isRetryable(end: TerminalModelEvent | undefined) {
  if (end?.type === "auth_failed" || end?.type === "billing_failed") return false;
  if (end?.type === "failed") return end.retryable;
  return true;
}

export function failureOpts(end: TerminalModelEvent | undefined) {
  return {
    retryable: isRetryable(end),
    ...(end?.type === "failed" && end.authorReason ? { authorReason: end.authorReason } : {}),
  };
}

/** O motivo em pt-BR de um fim que não é `done`. */
export function failureReason(end: TerminalModelEvent | undefined) {
  switch (end?.type) {
    case "auth_failed":
      return "a Chave do Workspace foi recusada pela Anthropic";
    case "billing_failed":
      return "a Chave do Workspace está sem crédito";
    case "failed":
      return end.reason;
    default:
      return "a resposta parou no meio";
  }
}
