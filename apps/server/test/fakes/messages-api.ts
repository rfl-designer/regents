/**
 * Dublê da Chave (Spec, "Testing Decisions"): um servidor HTTP falso da Messages API.
 *
 * Fala `POST /v1/messages` com `stream: true` em SSE, como a API real (nota 02), aceita a
 * credencial em `x-api-key` ou em `Authorization: Bearer`, e simula `authentication_error`
 * (401), `billing_error` (402), outros erros HTTP antes do stream, `event: error` no meio dele,
 * pensamento, `ping` e um stream que fica pendurado até o cliente desistir.
 *
 * Nos testes: `t.anthropic` (ou `fakeMessagesApi()` do arnês) e `api.reply({...})` para roteirizar
 * a próxima resposta. No e2e, `e2e/serve.ts` sobe este falso ao lado do servidor.
 *
 * A extração da Memória (ADR 0013) é reconhecida pelo schema da saída estruturada
 * (`isExtraction`) e tem fila e registro próprios: `api.remember({...})` roteiriza a próxima,
 * `api.extractions` guarda as que chegaram, e sem roteiro ela não guarda nada (`operacoes: []`).
 * A operação roteirizada sem `mensagem` cita a última mensagem de pessoa da troca.
 * Assim, o roteiro e as contagens das respostas (`reply`, `requests`) não mudam por causa dela.
 *
 * A Sincronização da Wiki (ADR 0015) também tem fila e registro próprios, reconhecida pela marca
 * no `system` (`isSync`): `api.sync({...})` roteiriza as próximas chamadas dela (cada turno do
 * vai-e-vem de Ferramentas é uma chamada), `api.syncs` guarda as que chegaram, e sem roteiro ela
 * termina sem escrever nada ("Pronto.").
 */

import { SYNC_MARKER } from "../../src/wiki/rules";
import { citeLastPerson } from "./memory-citation";

/** O que o falso responde a uma chamada. Sem nada, responde um texto curto. */
export interface FakeReply {
  /** O texto da resposta, mandado em pedaços (`chunks`) ou palavra por palavra. */
  text?: string;
  chunks?: string[];
  /** Saída estruturada (`output_config.format`): o JSON vai como o texto, em pedaços. */
  json?: unknown;
  /** Um bloco de pensamento (com texto vazio, como o `display: "omitted"`) antes do texto. */
  thinking?: boolean;
  /** Espera entre um evento e outro do stream. */
  delayMs?: number;
  /** Depois do `message_start`, não manda mais nada até o cliente fechar a conexão. */
  hang?: boolean;
  /** Pendurada, manda um `ping` a cada tantos ms (de verdade): sinal de conexão, não de progresso. */
  pingEveryMs?: number;
  /** Erro HTTP antes do stream, com o corpo de erro da API (`{ type: "error", error }`). */
  status?: number;
  errorType?: string;
  errorMessage?: string;
  /** `event: error` depois de alguns pedaços de texto (ex. `overloaded_error`). */
  streamError?: { type: string; message: string };
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /**
   * O modelo pede Ferramentas (client tools): um bloco `tool_use` por item, depois do texto (se
   * houver), com `stop_reason: "tool_use"`. A próxima chamada traz os `tool_result` (`toolResults`).
   */
  toolUse?: { name: string; input?: Record<string, unknown>; id?: string }[];
  /**
   * As server tools da web que o lado da Anthropic roda antes do texto: um bloco `server_tool_use`
   * e o resultado (`web_search_tool_result`/`web_fetch_tool_result`) por item, ou o erro dele
   * (`error`: o `error_code`). Cada busca sem erro conta em `usage.server_tool_use.web_search_requests`.
   * `page`: o texto da página que o `web_fetch` trouxe (padrão "A página.").
   */
  serverToolUse?: {
    name: "web_search" | "web_fetch";
    input?: Record<string, unknown>;
    id?: string;
    error?: string;
    page?: string;
  }[];
}

/** Uma chamada que chegou ao falso. */
export interface RecordedRequest {
  /** A credencial, viesse ela em `x-api-key` ou em `Authorization: Bearer`. */
  apiKey: string | null;
  /** Por onde a credencial veio. */
  authVia: "x-api-key" | "bearer" | null;
  anthropicVersion: string | null;
  anthropicBeta: string | null;
  body: {
    model: string;
    max_tokens: number;
    stream?: boolean;
    system?: string | { type: string; text: string }[];
    messages: { role: string; content: string | { type: string; text?: string; [k: string]: unknown }[] }[];
    [k: string]: unknown;
  };
}

export interface FakeMessagesApi {
  /** Base para o `baseURL` do SDK (sem `/v1`). */
  url: string;
  /** Roteiriza as próximas respostas (e roteamentos), na ordem; acabado o roteiro, vale o padrão. */
  reply(...replies: FakeReply[]): void;
  /**
   * Roteiriza as próximas extrações da Memória, na ordem (ex. `{ json: { operacoes: [...] } }`);
   * acabado o roteiro, a extração não guarda nada.
   */
  remember(...replies: FakeReply[]): void;
  /** As extrações da Memória que chegaram (fora de `requests`). */
  extractions: RecordedRequest[];
  /** Espera até `n` extrações terem chegado. */
  waitForExtractions(n: number, timeoutMs?: number): Promise<RecordedRequest[]>;
  /**
   * Roteiriza as próximas chamadas da Sincronização da Wiki, na ordem: cada turno é uma chamada
   * (ex. `{ toolUse: [{ name: "escrever_pagina", input }] }` e, depois, `{ text: "Pronto." }`).
   */
  sync(...replies: FakeReply[]): void;
  /** As chamadas da Sincronização que chegaram (fora de `requests`). */
  syncs: RecordedRequest[];
  /** Só estas credenciais passam; as outras recebem 401 `authentication_error`. Vazio: qualquer uma. */
  acceptKeys(...keys: string[]): void;
  requests: RecordedRequest[];
  /** Espera até `n` chamadas terem chegado (o stream pode ainda estar aberto). */
  waitForRequests(n: number, timeoutMs?: number): Promise<RecordedRequest[]>;
  /** Espera até `n` `ping` terem sido mandados, somando todas as chamadas. */
  waitForPings(n: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

const encoder = new TextEncoder();
const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function credential(req: Request): Pick<RecordedRequest, "apiKey" | "authVia"> {
  const key = req.headers.get("x-api-key");
  if (key) return { apiKey: key, authVia: "x-api-key" };
  const auth = req.headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return { apiKey: bearer, authVia: "bearer" };
  return { apiKey: null, authVia: null };
}

function errorResponse(status: number, type: string, message: string) {
  return Response.json(
    { type: "error", error: { type, message }, request_id: `req_falso_${crypto.randomUUID()}` },
    { status, headers: { "request-id": `req_falso_${crypto.randomUUID()}` } },
  );
}

/** O texto da última mensagem de usuário (o padrão do e2e responde a ela). */
export function lastUserText(body: RecordedRequest["body"]) {
  const last = [...body.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((b) => b.text ?? "").join("");
}

/** Um `tool_result` que o Shearim devolveu ao modelo. */
export interface RecordedToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Os `tool_result` da última mensagem de usuário do pedido (vazio se ela não traz nenhum). */
export function toolResults(body: RecordedRequest["body"]): RecordedToolResult[] {
  const last = body.messages.at(-1);
  if (last?.role !== "user" || typeof last.content === "string") return [];
  return last.content.filter((b) => b.type === "tool_result") as unknown as RecordedToolResult[];
}

/**
 * A extração da Memória (ADR 0013), pelo schema da saída estruturada: ele pede `operacoes`. O
 * roteamento da Articuladora pede `decisao`.
 */
export function isExtraction(body: RecordedRequest["body"]) {
  const format = (body.output_config as { format?: { schema?: { properties?: object } } } | undefined)?.format;
  return Boolean(format?.schema?.properties && "operacoes" in format.schema.properties);
}

/** Uma chamada da Sincronização da Wiki (ADR 0015), pela marca das regras da Wiki no `system`. */
export function isSync(body: RecordedRequest["body"]) {
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n");
  return system.includes(SYNC_MARKER);
}

/** A chamada da Sincronização sem roteiro: termina sem escrever nada. */
export const SYNC_DONE: FakeReply = { text: "Pronto." };

/**
 * A extração que não guarda nada: o padrão quando o teste não a roteiriza. De graça (sem tokens),
 * para não mexer no gasto na Chave de quem não está testando a Memória.
 */
export const NOTHING_TO_REMEMBER: FakeReply = { json: { operacoes: [] }, usage: { input_tokens: 0, output_tokens: 0 } };

/**
 * O padrão: um texto curto; ao roteamento da Articuladora (com `output_config`), o Desfecho
 * "nenhum", para um teste que não roteiriza o roteamento não ver resposta a mais.
 */
export function defaultFakeReply(req: RecordedRequest): FakeReply {
  if (req.body.output_config) {
    return { json: { decisao: "nenhum", agentes: [], motivo: "Resposta padrão do falso." } };
  }
  return { text: "Resposta de teste." };
}

export async function startFakeMessagesApi(
  opts: {
    port?: number;
    defaultReply?: (req: RecordedRequest) => FakeReply;
    /** O padrão da extração da Memória sem roteiro (padrão: `NOTHING_TO_REMEMBER`). */
    defaultExtraction?: (req: RecordedRequest) => FakeReply;
    /** O padrão da chamada da Sincronização sem roteiro (padrão: `SYNC_DONE`). */
    defaultSync?: (req: RecordedRequest) => FakeReply;
  } = {},
): Promise<FakeMessagesApi> {
  const script: FakeReply[] = [];
  const memoryScript: FakeReply[] = [];
  const syncScript: FakeReply[] = [];
  const requests: RecordedRequest[] = [];
  const extractions: RecordedRequest[] = [];
  const syncs: RecordedRequest[] = [];
  const accepted = new Set<string>();
  const arrivals: (() => void)[] = [];
  let pings = 0;
  const defaultReply = opts.defaultReply ?? defaultFakeReply;

  function stream(reply: FakeReply, model: string, signal: AbortSignal) {
    const usage = reply.usage ?? { input_tokens: 42, output_tokens: 12 };
    const text = reply.json !== undefined ? JSON.stringify(reply.json) : reply.text;
    const pieces = reply.chunks ?? (text ?? "").split(/(?<=\s)/).filter(Boolean);
    const delay = reply.delayMs ?? 0;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = async (event: string, data: unknown) => {
          if (signal.aborted) throw new Error("cliente desistiu");
          controller.enqueue(sse(event, data));
          if (delay) await sleep(delay);
        };
        const searches = (reply.serverToolUse ?? []).filter((s) => s.name === "web_search" && !s.error).length;
        const finish = async (stopReason: string) => {
          await send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              output_tokens: usage.output_tokens,
              ...(reply.serverToolUse && { server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } }),
            },
          });
          await send("message_stop", { type: "message_stop" });
          controller.close();
        };
        /** Os blocos `tool_use` a partir de `first`, com a entrada em `input_json_delta`, e o fim `tool_use`. */
        const sendTools = async (first: number) => {
          for (const [i, tool] of (reply.toolUse ?? []).entries()) {
            const index = first + i;
            await send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: tool.id ?? `toolu_falso_${crypto.randomUUID()}`,
                name: tool.name,
                input: {},
              },
            });
            await send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input ?? {}) },
            });
            await send("content_block_stop", { type: "content_block_stop", index });
          }
          await finish(reply.stopReason ?? "tool_use");
        };
        try {
          await send("message_start", {
            type: "message_start",
            message: {
              id: `msg_falso_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
            },
          });
          if (reply.hang) {
            const pinger = reply.pingEveryMs
              ? setInterval(() => {
                  if (signal.aborted) return;
                  controller.enqueue(sse("ping", { type: "ping" }));
                  pings++;
                }, reply.pingEveryMs)
              : undefined;
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            clearInterval(pinger);
            return;
          }
          let index = 0;
          if (reply.thinking) {
            await send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "", signature: "" },
            });
            await send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: "assinatura-falsa" },
            });
            await send("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          for (const server of reply.serverToolUse ?? []) {
            const id = server.id ?? `srvtoolu_falso_${crypto.randomUUID()}`;
            const input = server.input ?? {};
            await send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "server_tool_use", id, name: server.name, input: {} },
            });
            await send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
            });
            await send("content_block_stop", { type: "content_block_stop", index });
            index++;
            const url = String(input.url ?? "https://exemplo.com/");
            const content = server.error
              ? { type: `${server.name}_tool_result_error`, error_code: server.error }
              : server.name === "web_search"
                ? [{ type: "web_search_result", url, title: "Resultado", encrypted_content: "xyz", page_age: null }]
                : {
                    type: "web_fetch_result",
                    url,
                    retrieved_at: "2026-11-24T12:00:00Z",
                    content: {
                      type: "document",
                      source: { type: "text", media_type: "text/plain", data: server.page ?? "A página." },
                    },
                  };
            await send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: `${server.name}_tool_result`, tool_use_id: id, content },
            });
            await send("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          const tools = reply.toolUse ?? [];
          if (tools.length && pieces.length === 0) {
            await sendTools(index);
            return;
          }
          await send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          await send("ping", { type: "ping" });
          for (const [i, text] of pieces.entries()) {
            if (reply.streamError && i === Math.ceil(pieces.length / 2)) {
              await send("error", { type: "error", error: reply.streamError });
              controller.close();
              return;
            }
            await send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text },
            });
          }
          if (reply.streamError && pieces.length === 0) {
            await send("error", { type: "error", error: reply.streamError });
            controller.close();
            return;
          }
          await send("content_block_stop", { type: "content_block_stop", index });
          if (tools.length) {
            await sendTools(index + 1);
            return;
          }
          await finish(reply.stopReason ?? "end_turn");
        } catch {
          // O cliente fechou a conexão no meio: nada a fazer.
          try {
            controller.close();
          } catch {}
        }
      },
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return errorResponse(404, "not_found_error", `Rota desconhecida no falso: ${req.method} ${url.pathname}`);
      }
      const body = (await req.json()) as RecordedRequest["body"];
      const recorded: RecordedRequest = {
        ...credential(req),
        anthropicVersion: req.headers.get("anthropic-version"),
        anthropicBeta: req.headers.get("anthropic-beta"),
        body,
      };
      const extraction = isExtraction(body);
      const sync = isSync(body);
      (extraction ? extractions : sync ? syncs : requests).push(recorded);
      for (const wake of arrivals.splice(0)) wake();

      if (!recorded.apiKey) return errorResponse(401, "authentication_error", "x-api-key header is required");
      if (accepted.size && !accepted.has(recorded.apiKey)) {
        return errorResponse(401, "authentication_error", "invalid x-api-key");
      }
      let reply = extraction
        ? (memoryScript.shift() ?? opts.defaultExtraction?.(recorded) ?? NOTHING_TO_REMEMBER)
        : sync
          ? (syncScript.shift() ?? opts.defaultSync?.(recorded) ?? SYNC_DONE)
          : (script.shift() ?? defaultReply(recorded));
      // A operação roteirizada sem citação cita a última mensagem de pessoa (`memory-citation.ts`).
      if (extraction && reply.json !== undefined) {
        reply = { ...reply, json: citeLastPerson(reply.json, lastUserText(body)) };
      }
      if (reply.status) {
        return errorResponse(reply.status, reply.errorType ?? "api_error", reply.errorMessage ?? "Erro do falso");
      }
      if (!body.stream) {
        return errorResponse(400, "invalid_request_error", "O falso só fala em streaming (stream: true).");
      }
      return new Response(stream(reply, body.model, req.signal), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_falso" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    reply: (...replies) => script.push(...replies),
    remember: (...replies) => memoryScript.push(...replies),
    extractions,
    sync: (...replies) => syncScript.push(...replies),
    syncs,
    acceptKeys: (...keys) => {
      accepted.clear();
      for (const k of keys) accepted.add(k);
    },
    requests,
    async waitForRequests(n, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < n) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`Messages API falsa: esperava ${n} chamada(s), chegaram ${requests.length}`);
        await Promise.race([new Promise<void>((r) => arrivals.push(r)), sleep(left)]);
      }
      return requests.slice(0, n);
    },
    async waitForExtractions(n, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (extractions.length < n) {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new Error(`Messages API falsa: esperava ${n} extração(ões), chegaram ${extractions.length}`);
        await Promise.race([new Promise<void>((r) => arrivals.push(r)), sleep(left)]);
      }
      return extractions.slice(0, n);
    },
    async waitForPings(n, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (pings < n) {
        if (Date.now() > deadline) throw new Error(`Messages API falsa: esperava ${n} ping(s), foram ${pings}`);
        await sleep(5);
      }
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
