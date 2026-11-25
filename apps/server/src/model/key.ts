import Anthropic from "@anthropic-ai/sdk";
import type { ExecutionTools } from "../tools/port";
import { fetchLabel, WEB_FETCH, WEB_SEARCH } from "../tools/web";
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

/** O preço de cada busca na web pela Chave (US$ 10 por mil), além dos tokens. */
export const WEB_SEARCH_USD = 0.01;

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
      const before = { inputTokens: 0, outputTokens: 0, searches: 0 };
      const turn = { inputTokens: 0, outputTokens: 0, searches: 0 };
      const sum = () => ({
        inputTokens: before.inputTokens + turn.inputTokens,
        outputTokens: before.outputTokens + turn.outputTokens,
      });
      /** Os tokens e as buscas na web, que a Anthropic cobra à parte. */
      const cost = () => costUsd(model, sum()) + (before.searches + turn.searches) * WEB_SEARCH_USD;
      const spent = (): ModelEvent => ({ type: "usage", model, usage: sum(), costUsd: cost() });
      const web = webSteps(tools);
      try {
        const offered = tools ? await tools.list() : [];
        // As da porta vão como client tools; as da web, como as server tools da Messages API.
        const apiTools: Anthropic.ToolUnion[] = offered.map((t) =>
          t.origin === "web"
            ? webServerTool(t.name, model)
            : {
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              },
        );
        const messages: Anthropic.MessageParam[] = [...request.messages];
        /** Já saiu texto num turno anterior: o do turno seguinte vem depois de uma linha em branco. */
        let wrote = false;
        // O vai-e-vem de `tool_use`: cada turno que pede Ferramentas recebe os resultados e segue.
        for (;;) {
          turn.inputTokens = 0;
          turn.outputTokens = 0;
          turn.searches = 0;
          let wroteThisTurn = false;
          const stream = client.messages.stream(
            {
              model: request.model,
              max_tokens: MAX_TOKENS,
              system: request.system,
              messages,
              ...(apiTools.length && { tools: apiTools }),
              ...(request.output && {
                output_config: { format: { type: "json_schema", schema: request.output.schema } },
              }),
            },
            { signal },
          );
          for await (const event of stream) {
            await web.see(event);
            if (event.type === "message_start") {
              turn.inputTokens = event.message.usage.input_tokens;
              turn.outputTokens = event.message.usage.output_tokens;
              yield spent();
            } else if (event.type === "message_delta") {
              turn.inputTokens = event.usage.input_tokens ?? turn.inputTokens;
              turn.outputTokens = event.usage.output_tokens;
              turn.searches = event.usage.server_tool_use?.web_search_requests ?? turn.searches;
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
          turn.searches = final.usage.server_tool_use?.web_search_requests ?? turn.searches;
          before.inputTokens += turn.inputTokens;
          before.outputTokens += turn.outputTokens;
          before.searches += turn.searches;
          turn.inputTokens = 0;
          turn.outputTokens = 0;
          turn.searches = 0;
          if (final.stop_reason === "refusal") {
            terminal = { type: "failed", reason: "o modelo se recusou a responder", retryable: false };
            break;
          }
          // As server tools pararam no limite de iterações do lado da Anthropic: retoma com o turno
          // como veio, sem nada depois (sem isso, a resposta sairia cortada).
          if (final.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: final.content as Anthropic.ContentBlockParam[] });
            continue;
          }
          const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (final.stop_reason !== "tool_use" || !tools || calls.length === 0) {
            terminal = { type: "done", usage: sum(), costUsd: cost() };
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
          messages.push({ role: "user", content: results });
        }
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
        terminal = classify(err);
      } finally {
        await web.close();
      }
      yield terminal;
    },
  };
}

/**
 * A server tool da web de uma Ferramenta: a variante com filtro dinâmico onde o modelo a tem; no
 * Haiku, a básica.
 */
function webServerTool(id: string, model: string): Anthropic.ToolUnion {
  const basic = model.startsWith("claude-haiku");
  return id === WEB_SEARCH
    ? { type: basic ? "web_search_20250305" : "web_search_20260209", name: "web_search" }
    : { type: basic ? "web_fetch_20250910" : "web_fetch_20260209", name: "web_fetch" };
}

/** O motivo em pt-BR de cada `error_code` das server tools da web. */
const WEB_ERRORS: Record<string, string> = {
  url_not_accessible: "a página não abriu",
  url_not_allowed: "a URL não é permitida",
  url_too_long: "a URL é longa demais",
  unsupported_content_type: "o conteúdo da página não é suportado",
  query_too_long: "a busca é longa demais",
  max_uses_exceeded: "passou do limite de usos numa resposta",
  too_many_requests: "a Anthropic limitou os pedidos",
  invalid_input: "a entrada é inválida",
  invalid_tool_input: "a entrada é inválida",
  unavailable: "a Anthropic está sem a Ferramenta agora",
};

/**
 * Os passos das server tools da web no Andamento: o `server_tool_use` começa o passo (quando a
 * entrada chega inteira, para o rótulo ter o domínio) e o bloco de resultado o termina, com o
 * motivo se veio erro. As server tools rodam do lado da Anthropic: nada volta pela porta.
 */
function webSteps(tools: ExecutionTools | undefined) {
  const pending = new Map<number, { id: string; name: string; json: string }>();
  const running = new Map<string, (failure?: string) => Promise<void>>();
  return {
    async see(event: Anthropic.MessageStreamEvent) {
      if (!tools) return;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use") {
          pending.set(event.index, { id: block.id, name: block.name, json: "" });
        } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
          const content = block.content as unknown;
          const code =
            content && typeof content === "object" && !Array.isArray(content) && "error_code" in content
              ? String(content.error_code)
              : undefined;
          const finish = running.get(block.tool_use_id);
          running.delete(block.tool_use_id);
          await finish?.(code === undefined ? undefined : (WEB_ERRORS[code] ?? `a Anthropic devolveu o erro ${code}`));
        }
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        const block = pending.get(event.index);
        if (block) block.json += event.delta.partial_json;
      } else if (event.type === "content_block_stop") {
        const block = pending.get(event.index);
        pending.delete(event.index);
        if (!block) return;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(block.json || "{}");
        } catch {
          // a entrada não se lê: o rótulo genérico
        }
        if (block.name === "web_search") running.set(block.id, await tools.track(WEB_SEARCH, "buscando na web"));
        else if (block.name === "web_fetch") running.set(block.id, await tools.track(WEB_FETCH, fetchLabel(input.url)));
      }
    },
    /** O fluxo acabou (ou caiu) com passos sem resultado: terminam em falha, nunca "rodando" para sempre. */
    async close() {
      for (const finish of running.values()) await finish("a resposta parou no meio");
      running.clear();
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
