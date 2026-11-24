import Anthropic from "@anthropic-ai/sdk";
import type { ModelBrain, ModelEvent } from "./port";

/** Preço por milhão de tokens (entrada, saída), em dólares, para o gasto na Chave (#28). */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }) {
  const price = PRICES[model];
  if (!price) return 0;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** Resposta de chat: folga grande para não cortar no meio (o streaming evita timeout). */
const MAX_TOKENS = 64_000;

/**
 * O cérebro da Chave: a Messages API em streaming, pelo SDK oficial, normalizada para os
 * eventos da porta. Sem novas tentativas do SDK (`maxRetries: 0`): a política de nova tentativa
 * é do Shearim (#24). A recusa do modelo é falha com motivo, sem nova tentativa; sem fallback do
 * lado do servidor, quem responde é sempre o modelo do Agente.
 */
export function keyBrain(opts: { baseURL?: string } = {}): ModelBrain {
  // Explícito para não herdar `ANTHROPIC_BASE_URL` do ambiente do servidor.
  const baseURL = opts.baseURL ?? "https://api.anthropic.com";

  return {
    async *run(request, signal) {
      if (request.payer.kind !== "key") throw new Error("keyBrain só atende pagamento pela Chave");
      const client = new Anthropic({ apiKey: request.payer.apiKey, baseURL, maxRetries: 0 });
      let terminal: ModelEvent | undefined;
      /** O uso informado até aqui (o `message_start` e o `message_delta`), no modelo do Agente. */
      const { model } = request;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const spent = (): ModelEvent => ({ type: "usage", model, usage: { ...usage }, costUsd: costUsd(model, usage) });
      try {
        const stream = client.messages.stream(
          {
            model: request.model,
            max_tokens: MAX_TOKENS,
            system: request.system,
            messages: request.messages,
            ...(request.output && {
              output_config: { format: { type: "json_schema", schema: request.output.schema } },
            }),
          },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === "message_start") {
            usage.inputTokens = event.message.usage.input_tokens;
            usage.outputTokens = event.message.usage.output_tokens;
            yield spent();
          } else if (event.type === "message_delta") {
            usage.inputTokens = event.usage.input_tokens ?? usage.inputTokens;
            usage.outputTokens = event.usage.output_tokens;
            yield spent();
          } else if (event.type === "content_block_start" && event.content_block.type === "thinking") {
            yield { type: "thinking" };
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
            else if (event.delta.type === "thinking_delta" || event.delta.type === "signature_delta") {
              yield { type: "thinking" };
            }
          }
          // `ping` e o resto não são progresso.
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          terminal = { type: "failed", reason: "o modelo se recusou a responder", retryable: false };
        } else {
          const total = { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens };
          terminal = { type: "done", usage: total, costUsd: costUsd(model, total) };
        }
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
        terminal = classify(err);
      }
      yield terminal;
    },
  };
}

/** Erro da API (antes ou no meio do stream) para o evento da porta. */
function classify(err: unknown): ModelEvent {
  if (err instanceof Anthropic.AuthenticationError) return { type: "auth_failed" };
  if (err instanceof Anthropic.APIConnectionError) {
    return { type: "failed", reason: "não deu para falar com a Anthropic", retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    const type = err.type ?? errorTypeOf(err.error);
    if (type === "authentication_error") return { type: "auth_failed" };
    if (type === "billing_error" || err.status === 402) return { type: "billing_failed" };
    if (type === "overloaded_error" || err.status === 529) {
      return { type: "failed", reason: "a Anthropic está sobrecarregada", retryable: true };
    }
    if (type === "rate_limit_error" || err.status === 429) {
      return { type: "failed", reason: "a Chave do Workspace bateu no limite da Anthropic", retryable: true };
    }
    if (type === "not_found_error" || err.status === 404) {
      return { type: "failed", reason: "o modelo do Agente não existe na Anthropic", retryable: false };
    }
    if (type === "permission_error" || err.status === 403) {
      return { type: "failed", reason: "a Chave do Workspace não tem permissão para esse modelo", retryable: false };
    }
    if (type === "invalid_request_error" || type === "request_too_large" || err.status === 400) {
      return { type: "failed", reason: "a Anthropic recusou o pedido", retryable: false };
    }
    return { type: "failed", reason: "a Anthropic respondeu com erro", retryable: true };
  }
  return { type: "failed", reason: "erro inesperado ao falar com a Anthropic", retryable: true };
}

function errorTypeOf(body: unknown): string | null {
  const error = (body as { error?: { type?: unknown } } | undefined)?.error;
  return typeof error?.type === "string" ? error.type : null;
}
