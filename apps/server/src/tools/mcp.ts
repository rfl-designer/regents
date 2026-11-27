/**
 * O endpoint MCP do Regents (Spec #44, "Pela Conta"; emenda o ADR 0006): por onde o `claude -p`
 * de uma resposta lista e chama as Ferramentas da execução, que passam pela porta de Ferramentas
 * como pela Chave (o passo no Andamento, o prazo, a concessão conferida na hora).
 *
 * - Fala MCP em streamable HTTP, respondendo cada POST com JSON (sem SSE: o Regents não manda
 *   nada por conta própria ao cliente).
 * - Escuta só no loopback (`127.0.0.1`, porta livre): o `claude -p` roda no mesmo container, e o
 *   endpoint não passa pela tailnet nem pela identidade.
 * - Cada execução abre uma sessão: um caminho (`/mcp/<id>`) e um token só dela, que deixa de
 *   valer quando a sessão fecha (o fim do `claude -p`). Token de outra sessão, ou de uma que já
 *   fechou, é `401`.
 */
import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { ExecutionTools } from "./port";

/** O nome do servidor no `--mcp-config`: as Ferramentas chegam ao modelo como `mcp__regents__<id>`. */
export const MCP_SERVER_NAME = "regents";

/** As versões do protocolo que o endpoint fala; a primeira é a que ele propõe. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25", "2025-03-26", "2024-11-05"];

/** O `--mcp-config` de uma sessão: um servidor só, o do Regents. */
export interface McpConfig {
  mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }>;
}

export interface McpSession {
  config: McpConfig;
  /** O token deixa de valer. */
  close(): void;
}

export interface McpEndpoint {
  /**
   * Abre a sessão de uma execução. As chamadas rodam com `signal` (o da execução): ao abortar, a
   * Ferramenta em curso é interrompida pela porta.
   */
  open(tools: ExecutionTools, signal: AbortSignal): McpSession;
  stop(): Promise<void>;
}

interface Session {
  token: Buffer;
  tools: ExecutionTools;
  signal: AbortSignal;
}

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

export function createMcpEndpoint(): McpEndpoint {
  const sessions = new Map<string, Session>();
  let server: Server<unknown> | undefined;

  function authorized(req: Request, path: string): Session | undefined {
    const match = /^\/mcp\/([0-9a-f-]{36})$/.exec(path);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return undefined;
    const presented = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!presented) return undefined;
    const given = Buffer.from(presented);
    return given.length === session.token.length && timingSafeEqual(given, session.token) ? session : undefined;
  }

  async function answer(session: Session, msg: RpcMessage): Promise<Json> {
    const { id } = msg;
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, title: "Regents", version: "1" },
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": {
        // As da web rodam no próprio Claude Code (WebSearch, WebFetch), não por aqui.
        const specs = (await session.tools.list()).filter((s) => s.origin !== "web");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: specs.map((s) => ({
              name: s.name,
              title: s.title,
              description: s.description,
              inputSchema: s.inputSchema,
              annotations: { title: s.title, readOnlyHint: s.access === "read" },
            })),
          },
        };
      }
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(id, -32602, "tools/call sem name");
        const result = await session.tools.call(params.name, params.arguments ?? {}, session.signal);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result.content }], isError: result.isError },
        };
      }
      default:
        return rpcError(id, -32601, `método desconhecido: ${String(msg.method)}`);
    }
  }

  async function handle(req: Request): Promise<Response> {
    const session = authorized(req, new URL(req.url).pathname);
    if (!session) return json(rpcError(null, -32001, "token inválido ou execução encerrada"), 401);
    // Sem stream do servidor (GET) e sem encerrar sessão pelo cliente (DELETE): ela é da execução.
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(rpcError(null, -32700, "JSON inválido"), 400);
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as RpcMessage[];
    // Notificações e respostas do cliente não pedem resposta.
    const requests = messages.filter((m) => typeof m?.method === "string" && m.id !== undefined && m.id !== null);
    if (requests.length === 0) return new Response(null, { status: 202 });
    const answers = await Promise.all(requests.map((m) => answer(session, m)));
    return json(batch ? answers : answers[0]);
  }

  function listening(): Server<unknown> {
    // Sem o prazo ocioso do Bun (10 s): uma Ferramenta tem o dela (60 s), e a porta o aplica.
    server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle });
    return server;
  }

  return {
    open(tools, signal) {
      const id = crypto.randomUUID();
      const token = Buffer.from(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"));
      sessions.set(id, { token, tools, signal });
      const url = `http://127.0.0.1:${listening().port}/mcp/${id}`;
      return {
        config: {
          mcpServers: {
            [MCP_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token.toString()}` } },
          },
        },
        close: () => {
          sessions.delete(id);
        },
      };
    },
    async stop() {
      sessions.clear();
      await server?.stop(true);
      server = undefined;
    },
  };
}
