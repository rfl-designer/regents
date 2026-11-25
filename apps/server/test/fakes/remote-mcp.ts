/**
 * Dublê de um Conector (Spec #44, "Testing Decisions"): um servidor MCP remoto falso, em streamable
 * HTTP, que responde cada POST com JSON (sem SSE).
 *
 * - Exige `Authorization: Bearer <token>`; outro token, ou `refuse()`, é `401` (credencial recusada).
 * - `tools/list` devolve as Ferramentas roteirizadas, com ou sem `annotations.readOnlyHint`.
 * - `tools/call` roda o `handler` da Ferramenta (padrão: devolve os argumentos como texto) e grava
 *   cada chamada (`calls`), com o token que veio.
 *
 * Nos testes: `remoteMcp({ token, tools })` do arnês, que fecha sozinho no fim do teste.
 */

export interface FakeRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** A marca de "só leitura" do servidor; sem ela, o Shearim trata a Ferramenta como escrita. */
  readOnlyHint?: boolean;
  /** O que a chamada devolve (texto) ou lança (vira `isError` com a mensagem). Padrão: os argumentos. */
  handler?: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface FakeRemoteCall {
  name: string;
  arguments: Record<string, unknown>;
  token: string | null;
}

export interface FakeRemoteMcp {
  url: string;
  /** As chamadas a `tools/call` que chegaram, na ordem. */
  calls: FakeRemoteCall[];
  /** Quantas vezes o `tools/list` foi pedido. */
  listed(): number;
  /** Os tokens que chegaram em qualquer requisição (para ver que o token cifrado é o que sai). */
  tokens(): (string | null)[];
  /** Daqui em diante, toda requisição é `401` (a credencial foi revogada lá fora). */
  refuse(on?: boolean): void;
  /** Troca o token que o servidor aceita. */
  accept(token: string): void;
  /** Troca as Ferramentas oferecidas. */
  setTools(tools: FakeRemoteTool[]): void;
  stop(): Promise<void>;
}

type Json = Record<string, unknown>;

export function startRemoteMcp(opts: { token: string; tools: FakeRemoteTool[] }): FakeRemoteMcp {
  let token = opts.token;
  let tools = opts.tools;
  let refusing = false;
  let listedCount = 0;
  const calls: FakeRemoteCall[] = [];
  const seen: (string | null)[] = [];

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  async function answer(msg: Json, presented: string | null): Promise<Json> {
    const id = msg.id;
    const params = (msg.params ?? {}) as Json;
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "crm-falso", version: "1" },
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        listedCount++;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
              ...(t.readOnlyHint !== undefined ? { annotations: { readOnlyHint: t.readOnlyHint } } : {}),
            })),
          },
        };
      case "tools/call": {
        const tool = tools.find((t) => t.name === params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name: String(params.name), arguments: args, token: presented });
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `tool desconhecida: ${params.name}` } };
        try {
          const text = tool.handler ? await tool.handler(args) : JSON.stringify(args);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: (err as Error).message }], isError: true },
          };
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "método desconhecido" } };
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const presented = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
      seen.push(presented);
      if (refusing || presented !== token) {
        return json({ error: "invalid_token" }, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
      }
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      const body = (await req.json()) as Json | Json[];
      const messages = Array.isArray(body) ? body : [body];
      const requests = messages.filter((m) => typeof m.method === "string" && m.id !== undefined && m.id !== null);
      if (requests.length === 0) return new Response(null, { status: 202 });
      const answers = await Promise.all(requests.map((m) => answer(m, presented)));
      return json(Array.isArray(body) ? answers : answers[0], 200, { "Mcp-Session-Id": "sessao-falsa" });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls,
    listed: () => listedCount,
    tokens: () => [...seen],
    refuse: (on = true) => {
      refusing = on;
    },
    accept: (t) => {
      token = t;
    },
    setTools: (t) => {
      tools = t;
    },
    stop: () => server.stop(true),
  };
}
