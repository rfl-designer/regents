import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOOL_TURNS, type ModelBrain, type ModelEvent, toolLimitNote } from "./port";

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
      /**
       * O uso informado até aqui, no modelo do Agente: o dos turnos que já acabaram (`before`) mais
       * o do turno em curso (o `message_start` e o `message_delta`). Todo turno conta no orçamento.
       */
      const { model, tools } = request;
      const before = { inputTokens: 0, outputTokens: 0 };
      const turn = { inputTokens: 0, outputTokens: 0 };
      const sum = () => ({
        inputTokens: before.inputTokens + turn.inputTokens,
        outputTokens: before.outputTokens + turn.outputTokens,
      });
      const spent = (): ModelEvent => ({ type: "usage", model, usage: sum(), costUsd: costUsd(model, sum()) });
      try {
        const offered = tools ? await tools.list() : [];
        const apiTools = offered.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }));
        const messages: Anthropic.MessageParam[] = [...request.messages];
        /** Já saiu texto num turno anterior: o do turno seguinte vem depois de uma linha em branco. */
        let wrote = false;
        /** O teto de turnos de Ferramenta (#53) e os turnos que já pediram Ferramentas. */
        const maxTurns = request.maxToolTurns ?? MAX_TOOL_TURNS;
        let toolTurns = 0;
        /**
         * Chegou ao teto: a última chamada vai sem Ferramentas. Elas continuam declaradas (o
         * histórico tem `tool_use`), mas `tool_choice: none` impede o modelo de pedi-las.
         */
        let capped = false;
        // O vai-e-vem de `tool_use`: cada turno que pede Ferramentas recebe os resultados e segue.
        for (;;) {
          turn.inputTokens = 0;
          turn.outputTokens = 0;
          let wroteThisTurn = false;
          const stream = client.messages.stream(
            {
              model: request.model,
              max_tokens: MAX_TOKENS,
              system: request.system,
              messages,
              ...(apiTools.length && { tools: apiTools }),
              ...(capped && { tool_choice: { type: "none" as const } }),
              ...(request.output && {
                output_config: { format: { type: "json_schema", schema: request.output.schema } },
              }),
            },
            { signal },
          );
          for await (const event of stream) {
            if (event.type === "message_start") {
              turn.inputTokens = event.message.usage.input_tokens;
              turn.outputTokens = event.message.usage.output_tokens;
              yield spent();
            } else if (event.type === "message_delta") {
              turn.inputTokens = event.usage.input_tokens ?? turn.inputTokens;
              turn.outputTokens = event.usage.output_tokens;
              yield spent();
            } else if (event.type === "content_block_start" && event.content_block.type === "thinking") {
              yield { type: "thinking" };
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                if (wrote && !wroteThisTurn) yield { type: "text", text: "\n\n" };
                wrote = wroteThisTurn = true;
                yield { type: "text", text: event.delta.text };
              } else if (event.delta.type === "thinking_delta" || event.delta.type === "signature_delta") {
                yield { type: "thinking" };
              }
            }
            // `ping` e o resto não são progresso.
          }
          const final = await stream.finalMessage();
          turn.inputTokens = final.usage.input_tokens;
          turn.outputTokens = final.usage.output_tokens;
          before.inputTokens += turn.inputTokens;
          before.outputTokens += turn.outputTokens;
          turn.inputTokens = 0;
          turn.outputTokens = 0;
          if (final.stop_reason === "refusal") {
            terminal = { type: "failed", reason: "o modelo se recusou a responder", retryable: false };
            break;
          }
          const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (final.stop_reason !== "tool_use" || !tools || calls.length === 0 || capped) {
            terminal = { type: "done", usage: sum(), costUsd: costUsd(model, sum()) };
            break;
          }
          // Cada chamada passa pela porta de Ferramentas (o passo no Andamento, o prazo); a falha
          // volta ao modelo como resultado de erro, e a resposta segue.
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const call of calls) {
            const result = await tools.call(call.name, call.input, signal);
            if (signal.aborted) return;
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: result.content,
              ...(result.isError && { is_error: true }),
            });
          }
          messages.push({ role: "assistant", content: final.content as Anthropic.ContentBlockParam[] });
          toolTurns++;
          if (toolTurns >= maxTurns) {
            capped = true;
            yield { type: "tool_limit" };
          }
          messages.push({
            role: "user",
            content: [...results, ...(capped ? [{ type: "text" as const, text: toolLimitNote(maxTurns) }] : [])],
          });
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
