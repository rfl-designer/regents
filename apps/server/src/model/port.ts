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
  /** A Conta bateu no limite (só pela Conta); `resetsAt` é quando volta. */
  | { type: "limit"; resetsAt: Date | null; usingOverage?: boolean }
  /** A credencial foi recusada: Conta "Precisa ligar de novo", ou incidente da Chave (#28). */
  | { type: "auth_failed" }
  /** A Chave está sem crédito: incidente da Chave (#28). */
  | { type: "billing_failed" }
  /** Falha com motivo em pt-BR (completa "Faro não respondeu: …"). `retryable`: vale nova tentativa. */
  | { type: "failed"; reason: string; retryable: boolean }
  /** Fim com sucesso: uso, custo em dólares e, pela Conta, a validade da credencial. */
  | { type: "done"; usage: ModelUsage; costUsd: number; credentialExpiresAt?: Date };

export type TerminalModelEvent = Extract<
  ModelEvent,
  { type: "done" | "failed" | "auth_failed" | "billing_failed" | "limit" }
>;

/** Um cérebro: roda um pedido e emite eventos até o fim ou até o `signal` abortar. */
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
