/**
 * Dublê de um Conector (Spec #44, "Testing Decisions"): um servidor MCP remoto falso, em streamable
 * HTTP, que responde cada POST com JSON (sem SSE).
 *
 * - Exige `Authorization: Bearer <token>` com um dos tokens aceitos (o do Workspace, ou um de
 *   cada Membro); outro token, `revoke(token)` ou `refuse()` é `401` (credencial recusada).
 * - `tools/list` devolve as Ferramentas roteirizadas, com ou sem `annotations.readOnlyHint`.
 * - `tools/call` roda o `handler` da Ferramenta (padrão: devolve os argumentos como texto) e grava
 *   cada chamada (`calls`), com o token que veio.
 *
 * - Com `oauth`, o mesmo servidor é também o servidor de autorização dele (o login do MCP): os
 *   metadados de recurso protegido (RFC 9728) e do servidor de autorização (RFC 8414), o registro
 *   dinâmico de cliente (RFC 7591), `/authorize` (que "faz o login" de quem `oauth.loginAs` disse e
 *   volta ao `redirect_uri` com o código) e `/token` (código com PKCE e renovação). Cada login
 *   emite um token de acesso aceito pelo `/mcp`; renovar troca o token (o anterior deixa de valer)
 *   e o de renovação. Sem `oauth`, os endereços `.well-known` respondem 404: o servidor não tem login.
 *
 * Nos testes: `remoteMcp({ token, tools, oauth? })` do arnês, que fecha sozinho no fim do teste.
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

/** O login do servidor falso (quando ele oferece OAuth). */
export interface FakeOAuth {
  /** Quem faz o próximo login no `/authorize` (padrão: `"alguem"`). */
  loginAs(user: string): void;
  /** O próximo login é negado: volta ao `redirect_uri` com `error=access_denied`. */
  denyNext(): void;
  /** O token de acesso que vale agora para `user` (o do último login ou renovação). */
  tokenOf(user: string): string | undefined;
  /** Quantas renovações (`grant_type=refresh_token`) deram certo. */
  renewals(): number;
  /** Daqui em diante, renovar é `invalid_grant` (o login foi revogado lá fora). */
  refuseRenewal(on?: boolean): void;
  /** Os `redirect_uri` dos clientes que se registraram. */
  registeredRedirects(): string[];
  /** Os parâmetros de cada `/authorize` que chegou. */
  authorizations: URLSearchParams[];
}

export interface FakeRemoteMcp {
  url: string;
  /** Só com `oauth`: o lado do login. */
  oauth: FakeOAuth;
  /** As chamadas a `tools/call` que chegaram, na ordem. */
  calls: FakeRemoteCall[];
  /** Quantas vezes o `tools/list` foi pedido. */
  listed(): number;
  /** Os tokens que chegaram em qualquer requisição (para ver que o token cifrado é o que sai). */
  tokens(): (string | null)[];
  /** Daqui em diante, toda requisição é `401` (a credencial foi revogada lá fora). */
  refuse(on?: boolean): void;
  /** Troca os tokens que o servidor aceita por este. */
  accept(token: string): void;
  /** Passa a aceitar também este token (a credencial de mais um Membro). */
  allow(token: string): void;
  /** Deixa de aceitar este token (a credencial de um Membro foi revogada lá fora). */
  revoke(token: string): void;
  /** Troca as Ferramentas oferecidas. */
  setTools(tools: FakeRemoteTool[]): void;
  stop(): Promise<void>;
}

type Json = Record<string, unknown>;

export function startRemoteMcp(opts: {
  token?: string | string[];
  tools: FakeRemoteTool[];
  /** O servidor oferece login (OAuth); `expiresIn` é a validade do token de acesso, em segundos. */
  oauth?: { expiresIn?: number };
}): FakeRemoteMcp {
  let accepted = new Set(typeof opts.token === "string" ? [opts.token] : (opts.token ?? []));
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

  // ---------- o login (OAuth) ----------
  const oauthOn = Boolean(opts.oauth);
  const expiresIn = opts.oauth?.expiresIn ?? 3600;
  let nextUser = "alguem";
  let denying = false;
  let refusingRenewal = false;
  let renewed = 0;
  let serial = 0;
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { user: string; clientId: string; redirectUri: string; challenge: string }>();
  /** Token de renovação → de quem, e o token de acesso que ele emitiu por último. */
  const refreshes = new Map<string, { user: string; clientId: string; access: string }>();
  const current = new Map<string, string>();
  const authorizations: URLSearchParams[] = [];

  function issue(user: string, clientId: string, previous?: string) {
    serial++;
    const access = `acesso-${user}-${serial}`;
    const refresh = `renova-${user}-${serial}`;
    if (previous) accepted.delete(previous);
    accepted.add(access);
    current.set(user, access);
    refreshes.set(refresh, { user, clientId, access });
    return json({ access_token: access, token_type: "Bearer", expires_in: expiresIn, refresh_token: refresh });
  }

  async function s256(verifier: string) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    return Buffer.from(digest).toString("base64url");
  }

  async function authServer(req: Request, url: URL): Promise<Response | null> {
    const origin = url.origin;
    const resource = `${origin}/mcp`;
    const path = url.pathname;
    if (path.startsWith("/.well-known/")) {
      if (!oauthOn) return json({ error: "not_found" }, 404);
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource, authorization_servers: [origin] });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      return json({ error: "not_found" }, 404);
    }
    if (!oauthOn) return null;
    if (path === "/register" && req.method === "POST") {
      const body = (await req.json()) as { redirect_uris?: string[] };
      const clientId = `cliente-${clients.size + 1}`;
      clients.set(clientId, body.redirect_uris ?? []);
      return json({ ...body, client_id: clientId, token_endpoint_auth_method: "none" }, 201);
    }
    if (path === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      authorizations.push(q);
      const redirectUri = q.get("redirect_uri") ?? "";
      const clientId = q.get("client_id") ?? "";
      if (!clients.get(clientId)?.includes(redirectUri)) return json({ error: "invalid_request" }, 400);
      const back = new URL(redirectUri);
      const state = q.get("state");
      if (state) back.searchParams.set("state", state);
      if (denying) {
        denying = false;
        back.searchParams.set("error", "access_denied");
      } else {
        const code = `codigo-${++serial}`;
        codes.set(code, { user: nextUser, clientId, redirectUri, challenge: q.get("code_challenge") ?? "" });
        back.searchParams.set("code", code);
      }
      return new Response(null, { status: 302, headers: { Location: back.href } });
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (
          !code ||
          code.clientId !== form.get("client_id") ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.challenge !== (await s256(form.get("code_verifier") ?? ""))
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        return issue(code.user, code.clientId);
      }
      if (grant === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        const known = refreshes.get(token);
        if (refusingRenewal || !known || known.clientId !== form.get("client_id")) {
          return json({ error: "invalid_grant", error_description: "o login foi revogado" }, 400);
        }
        refreshes.delete(token);
        renewed++;
        return issue(known.user, known.clientId, known.access);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return null;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const login = await authServer(req, url);
      if (login) return login;
      const presented = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
      seen.push(presented);
      if (refusing || presented === null || !accepted.has(presented)) {
        const challenge = oauthOn
          ? `Bearer error="invalid_token", resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`
          : 'Bearer error="invalid_token"';
        return json({ error: "invalid_token" }, 401, { "WWW-Authenticate": challenge });
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
    oauth: {
      loginAs: (user) => {
        nextUser = user;
      },
      denyNext: () => {
        denying = true;
      },
      tokenOf: (user) => current.get(user),
      renewals: () => renewed,
      refuseRenewal: (on = true) => {
        refusingRenewal = on;
      },
      registeredRedirects: () => [...clients.values()].flat(),
      authorizations,
    },
    calls,
    listed: () => listedCount,
    tokens: () => [...seen],
    refuse: (on = true) => {
      refusing = on;
    },
    accept: (t) => {
      accepted = new Set([t]);
    },
    allow: (t) => {
      accepted.add(t);
    },
    revoke: (t) => {
      accepted.delete(t);
    },
    setTools: (t) => {
      tools = t;
    },
    stop: () => server.stop(true),
  };
}
