/**
 * Porta de modelo (Spec, módulo 7; ADR 0002): uma só interface, dois cérebros atrás dela.
 *
 * O pedido é o contexto montado, o modelo e o pagador. A saída é um fluxo de eventos
 * normalizados: a vigia (#24), a troca de pagador (#27) e o Andamento só leem isto, sem saber
 * se do outro lado está a Messages API (pela Chave, `key.ts`) ou um `claude -p` (pela Conta, #26).
 */

/** Uma mensagem do contexto, já com o autor marcado no texto quando importa. */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Quem paga a execução. Pela Chave, a chave da Messages API já decifrada.
 * Pela Conta (#26), a pasta do login do Membro (`CLAUDE_CONFIG_DIR`).
 */
export type Payer = { kind: "key"; apiKey: string } | { kind: "account"; memberId: string; configDir: string };

export interface ModelRequest {
  /** O id do modelo (ex. `claude-sonnet-5-5`). */
  model: string;
  /** O contexto fixo do Agente (preâmbulo, Contexto do Workspace, instruções...). */
  system: string;
  messages: ModelMessage[];
  payer: Payer;
  /**
   * Saída estruturada (o roteamento da Articuladora): o texto da resposta é um JSON que segue
   * `schema`. Pela Chave vai em `output_config.format`; pela Conta (#26), no `--json-schema`
   * do `claude -p`, com o `structured_output` do `result` emitido como o texto (ADR 0009).
   */
  output?: { schema: Record<string, unknown> };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * O que um cérebro emite. Contam como progresso para a vigia: `text`, `thinking` e `api_retry`.
 * Todo fluxo termina com exatamente um destes: `done`, `failed`, `auth_failed`,
 * `billing_failed` ou `limit` (ou nada, quando o `signal` foi abortado).
 */
export type ModelEvent =
  /** Um pedaço do texto da resposta. */
  | { type: "text"; text: string }
  /** Um pedaço de pensamento (o texto pode vir vazio: só conta como sinal de vida). */
  | { type: "thinking" }
  /** A API está sendo tentada de novo (n/m): "tentando de novo (n/m)". */
  | { type: "api_retry"; attempt: number; max: number }
  /**
   * O uso que a API informou até aqui (acumulado), com o modelo que respondeu e o custo nele (só
   * pela Chave). Não é progresso nem fim: é o que o gasto na Chave conta quando a execução não
   * chega ao `done` (cancelada, parada pela vigia, falha no meio).
   */
  | { type: "usage"; model: string; usage: ModelUsage; costUsd: number }
  /** A Conta bateu no limite (só pela Conta); `resetsAt` é quando volta. */
  | { type: "limit"; resetsAt: Date | null; usingOverage?: boolean }
  /** A credencial foi recusada: Conta "Precisa ligar de novo", ou incidente da Chave (#28). */
  | { type: "auth_failed" }
  /** A Chave está sem crédito: incidente da Chave (#28). */
  | { type: "billing_failed" }
  /**
   * Falha com motivo em pt-BR (completa "Faro não respondeu: …"). `retryable`: vale nova tentativa.
   * `authorReason`, quando o motivo é estado da Conta do autor: só ele o vê; os outros veem `reason`.
   */
  | { type: "failed"; reason: string; retryable: boolean; authorReason?: string }
  /**
   * Fim com sucesso: uso, custo em dólares, o modelo que respondeu (pela Chave, o fallback do
   * servidor pode trocar o pedido) e, pela Conta, a validade da credencial e, se veio
   * `rate_limit_event`, se a execução passou do plano com o uso extra ligado (`extraUsage`).
   */
  | {
      type: "done";
      usage: ModelUsage;
      costUsd: number;
      model?: string;
      credentialExpiresAt?: Date;
      extraUsage?: boolean;
    };

/** O motivo quando o pedido trouxe `output` e a resposta não veio no formato (ADR 0009). */
export const NOT_STRUCTURED_REASON = "o modelo não devolveu a decisão no formato pedido";

export type TerminalModelEvent = Extract<
  ModelEvent,
  { type: "done" | "failed" | "auth_failed" | "billing_failed" | "limit" }
>;

/**
 * Um cérebro: roda um pedido e emite eventos até o fim ou até o `signal` abortar.
 *
 * O `signal` é o caminho único de encerramento (Spec, módulo 6, Encerramento): a vigia, o
 * cancelamento pelo autor e o reinício abortam por ele, com o motivo em `signal.reason`
 * (`"stalled" | "cancelled" | "shutdown"`). Ao abortar, o cérebro encerra o que abriu (pela Conta,
 * #26: `SIGINT`, 10 s, `SIGTERM`, 5 s, `SIGKILL` no `claude -p`) e só então termina o fluxo, sem
 * evento terminal. Processo que morre sozinho é falha na hora: `failed` com `retryable: true`.
 */
export interface ModelBrain {
  run(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** A porta: escolhe o cérebro pelo pagador. */
export type ModelPort = ModelBrain;

export function createModelPort(brains: { key: ModelBrain; account?: ModelBrain }): ModelPort {
  return {
    async *run(request, signal) {
      if (request.payer.kind === "key") {
        yield* brains.key.run(request, signal);
        return;
      }
      if (!brains.account) {
        yield { type: "failed", reason: "a execução pela Conta ainda não existe", retryable: false };
        return;
      }
      yield* brains.account.run(request, signal);
    },
  };
}
