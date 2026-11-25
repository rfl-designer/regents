/**
 * Os Conectores (Spec #44): servidores MCP remotos que o Admin liga ao Workspace, com a credencial
 * do Workspace (um token colado, cifrado com a chave mestra como a Chave). As Ferramentas de cada
 * um saem do `tools/list` dele e entram no catálogo da porta de Ferramentas; quem fala com o
 * servidor é sempre o Shearim (os cérebros chamam a porta), nunca o modelo.
 *
 * - Só o que o servidor marca como "só leitura" (`readOnlyHint`) é leitura; o resto é escrita e
 *   passa pelo Pedido de aprovação.
 * - Credencial recusada (401) é falha da Ferramenta com motivo, e o Conector fica "recusado" até o
 *   Admin colar outro token (ou o catálogo ser relido com sucesso).
 * - Remover o Conector remove o catálogo e as concessões dele (cascata): some de todo Agente na hora.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConnectorDto, ConnectorToolDto, CreateConnectorInput } from "@shearim/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, isUuid, schema } from "../db/client";
import type { Env } from "../members";
import type { SecretBox } from "../secrets";
import { type ToolDefinition, ToolFailure } from "./port";

const { connectors, connectorTools } = schema;

type Connector = typeof connectors.$inferSelect;
type CatalogRow = typeof connectorTools.$inferSelect;

const NAME_MAX = 40;
/** O resultado de uma Ferramenta de Conector que volta ao modelo (o resto é cortado, com aviso). */
const RESULT_MAX = 50_000;
/** O id que o modelo recebe tem no máximo isto (o limite dos nomes de tool da Messages API). */
const TOOL_ID_MAX = 64;

/** O servidor recusou a credencial (401/403). */
class Refused extends Error {}

/** "CRM Comercial" → `crm_comercial`: o prefixo dos ids das Ferramentas do Conector. */
function slug(text: string, max: number) {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/, "");
  return s;
}

/** Um id que ainda não está em `taken`: `base`, `base_2`, `base_3`… dentro de `max`. */
function unique(base: string, taken: Set<string>, max: number) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean };
}

/**
 * Abre uma sessão MCP com o servidor, roda `work` e fecha. 401/403 viram `Refused`; o resto
 * propaga (o servidor não respondeu, não fala MCP).
 */
async function withRemote<T>(
  url: string,
  token: string,
  signal: AbortSignal | undefined,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "shearim", version: "1" });
  try {
    await client.connect(transport, { signal });
    return await work(client);
  } catch (err) {
    if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) throw new Refused();
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

/** O `tools/list` inteiro (com as páginas). */
async function listRemote(url: string, token: string): Promise<RemoteTool[]> {
  return withRemote(url, token, undefined, async (client) => {
    const out: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      out.push(...(page.tools as RemoteTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  });
}

/** O motivo, em pt-BR, de um catálogo que não veio. */
function catalogFailure(name: string, err: unknown) {
  if (err instanceof Refused) return { error: "credential_refused", message: `O ${name} recusou o token.` } as const;
  return {
    error: "connector_unreachable",
    message: `Não foi possível ler as Ferramentas do ${name} nesse endereço: ${(err as Error).message || "sem resposta"}.`,
  } as const;
}

export function createConnectors(deps: { db: Db; clock: Clock; secrets: SecretBox }) {
  const { db, clock, secrets } = deps;

  async function tokenOf(connector: Connector): Promise<string> {
    if (!connector.tokenCiphertext || !connector.tokenIv) {
      throw new ToolFailure(`o ${connector.name} está sem a credencial do Workspace`);
    }
    return secrets.open({ ciphertext: connector.tokenCiphertext, iv: connector.tokenIv }).catch(() => {
      throw new ToolFailure(`a credencial do Workspace do ${connector.name} não abre nesta Instalação`);
    });
  }

  async function markRefused(connectorId: string) {
    await db
      .update(connectors)
      .set({ credentialState: "refused", refusedAt: clock.now() })
      .where(eq(connectors.id, connectorId));
  }

  /** Chama a Ferramenta `name` no servidor, com a credencial de agora. O texto, ou `ToolFailure`. */
  async function callRemote(connectorId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector) throw new ToolFailure("o Conector foi removido");
    const token = await tokenOf(connector);
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await withRemote(connector.url, token, signal, (client) =>
        // O prazo é o da porta de Ferramentas (que aborta `signal`), não o do SDK.
        client.callTool({ name, arguments: args }, undefined, { signal, timeout: 2 ** 31 - 1 }),
      );
    } catch (err) {
      if (err instanceof Refused) {
        await markRefused(connector.id);
        throw new ToolFailure(`o ${connector.name} recusou a credencial do Workspace`);
      }
      if (signal.aborted) throw err;
      console.error(`shearim: o Conector ${connector.name} falhou`, err);
      throw new ToolFailure(`o ${connector.name} não respondeu`);
    }
    const blocks = (result.content ?? []) as { type: string; text?: string }[];
    let text = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : `[conteúdo ${b.type}]`)).join("\n");
    if (result.isError) throw new ToolFailure(`o ${connector.name} respondeu com erro: ${text.slice(0, 300)}`);
    if (text.length > RESULT_MAX)
      text = `${text.slice(0, RESULT_MAX)}\n[resultado cortado em ${RESULT_MAX} caracteres]`;
    return text || "(sem conteúdo)";
  }

  /** Uma Ferramenta do catálogo de um Conector, como a porta a executa. */
  function definitionOf(connector: Connector, row: CatalogRow): ToolDefinition {
    const base = {
      id: row.tool,
      title: row.title,
      label: `usando ${row.title} no ${connector.name}, com a credencial do Workspace`,
      description: row.description || row.title,
      origin: "connector" as const,
      connector: { id: connector.id, name: connector.name, credential: "workspace" as const },
      inputSchema: row.inputSchema,
    };
    const argsOf = (input: unknown) => {
      if (input === undefined || input === null) return {};
      if (typeof input !== "object" || Array.isArray(input)) throw new ToolFailure("a entrada não é um objeto");
      return input as Record<string, unknown>;
    };
    if (row.readOnly) {
      return {
        ...base,
        access: "read",
        run: (_ctx, input, signal) => callRemote(connector.id, row.name, argsOf(input), signal),
      };
    }
    return {
      ...base,
      access: "write",
      async prepare(_ctx, input) {
        const args = argsOf(input);
        return {
          action: { arguments: args },
          summary: `Usar “${row.title}” no ${connector.name}, com a credencial do Workspace: ${JSON.stringify(args)}`,
        };
      },
      perform: (_ctx, action, signal) => callRemote(connector.id, row.name, argsOf(action.arguments), signal),
    };
  }

  /** As Ferramentas de todos os Conectores, para o catálogo da porta (lido a cada uso). */
  async function definitions(): Promise<ToolDefinition[]> {
    const rows = await db
      .select({ connector: connectors, tool: connectorTools })
      .from(connectorTools)
      .innerJoin(connectors, eq(connectors.id, connectorTools.connectorId))
      .orderBy(asc(connectors.createdAt), asc(connectors.name), asc(connectorTools.position));
    return rows.map((r) => definitionOf(r.connector, r.tool));
  }

  /** Grava o catálogo lido (troca o anterior inteiro), com ids estáveis para os nomes que já existiam. */
  async function saveCatalog(tx: Db, connector: Connector, remote: RemoteTool[]) {
    const previous = await tx.select().from(connectorTools).where(eq(connectorTools.connectorId, connector.id));
    const idOfName = new Map(previous.map((p) => [p.name, p.tool]));
    const others = await tx
      .select({ tool: connectorTools.tool })
      .from(connectorTools)
      .where(sql`${connectorTools.connectorId} <> ${connector.id}`);
    const taken = new Set(others.map((o) => o.tool));
    const rows: CatalogRow[] = [];
    const seen = new Set<string>();
    for (const tool of remote) {
      if (typeof tool?.name !== "string" || !tool.name || seen.has(tool.name)) continue;
      seen.add(tool.name);
      const prefix = `${connector.key}__`;
      const id =
        idOfName.get(tool.name) ??
        unique(`${prefix}${slug(tool.name, TOOL_ID_MAX - prefix.length) || "ferramenta"}`, taken, TOOL_ID_MAX);
      taken.add(id);
      rows.push({
        tool: id,
        connectorId: connector.id,
        position: rows.length,
        name: tool.name,
        title: (tool.title || tool.annotations?.title || tool.name).trim(),
        description: (tool.description ?? "").trim(),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
        readOnly: tool.annotations?.readOnlyHint === true,
      });
    }
    await tx.delete(connectorTools).where(eq(connectorTools.connectorId, connector.id));
    if (rows.length) await tx.insert(connectorTools).values(rows);
  }

  async function toDto(connector: Connector, catalogError: string | null = null): Promise<ConnectorDto> {
    const tools = await db
      .select()
      .from(connectorTools)
      .where(eq(connectorTools.connectorId, connector.id))
      .orderBy(asc(connectorTools.position));
    return {
      id: connector.id,
      name: connector.name,
      url: connector.url,
      credential: "workspace",
      credentialState: connector.credentialState === "refused" ? "refused" : "ok",
      refusedAt: connector.refusedAt?.toISOString() ?? null,
      tools: tools.map(
        (t): ConnectorToolDto => ({
          id: t.tool,
          name: t.name,
          title: t.title,
          description: t.description,
          access: t.readOnly ? "read" : "write",
        }),
      ),
      catalogError,
    };
  }

  async function find(id: string) {
    if (!isUuid(id)) return undefined;
    return (await db.select().from(connectors).where(eq(connectors.id, id)))[0];
  }

  const routes = new Hono<Env>();

  routes.use("/connectors/*", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });
  routes.use("/connectors", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.get("/connectors", async (c) => {
    const all = await db.select().from(connectors).orderBy(asc(connectors.createdAt), asc(connectors.name));
    return c.json(await Promise.all(all.map((row) => toDto(row))));
  });

  routes.post("/connectors", async (c) => {
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<
      Record<keyof CreateConnectorInput, unknown>
    >;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const url = typeof input.url === "string" ? input.url.trim() : "";
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!name) return invalid("Dê um nome ao Conector.");
    if (name.length > NAME_MAX) return invalid(`O nome do Conector tem no máximo ${NAME_MAX} caracteres.`);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {}
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return invalid("O endereço do servidor MCP é uma URL http(s).");
    }
    if (!token) return invalid("Cole o token do Workspace para esse servidor.");
    const [same] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(sql`lower(${connectors.name}) = lower(${name})`);
    if (same) return c.json({ error: "name_taken", message: "Já existe um Conector com esse nome." }, 409);

    // O catálogo vem antes de gravar: um servidor que recusa o token ou não responde não vira Conector.
    let remote: RemoteTool[];
    try {
      remote = await listRemote(parsed.href, token);
    } catch (err) {
      return c.json(catalogFailure(name, err), 422);
    }
    const sealed = await secrets.seal(token);
    const keys = new Set((await db.select({ key: connectors.key }).from(connectors)).map((r) => r.key));
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(connectors)
        .values({
          id: crypto.randomUUID(),
          name,
          key: unique(slug(name, 24) || "conector", keys, 28),
          kind: "mcp",
          url: parsed.href,
          credentialMode: "workspace",
          tokenCiphertext: sealed.ciphertext,
          tokenIv: sealed.iv,
          credentialState: "ok",
          createdAt: clock.now(),
        })
        .returning();
      await saveCatalog(tx as unknown as Db, row!, remote);
      return row!;
    });
    return c.json(await toDto(created), 201);
  });

  /** Abrir o Conector relê o catálogo; se não der, mostra o último lido com o motivo. */
  routes.get("/connectors/:id", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    let token: string;
    try {
      token = await tokenOf(connector);
    } catch (err) {
      return c.json(await toDto(connector, (err as ToolFailure).reason));
    }
    try {
      const remote = await listRemote(connector.url, token);
      const [fresh] = await db.transaction(async (tx) => {
        await saveCatalog(tx as unknown as Db, connector, remote);
        return tx
          .update(connectors)
          .set({ credentialState: "ok", refusedAt: null })
          .where(eq(connectors.id, connector.id))
          .returning();
      });
      return c.json(await toDto(fresh!));
    } catch (err) {
      if (err instanceof Refused) await markRefused(connector.id);
      return c.json(await toDto((await find(connector.id))!, catalogFailure(connector.name, err).message));
    }
  });

  /** Trocar o token (depois de uma recusa): vale só se o servidor o aceita. */
  routes.put("/connectors/:id/credential", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof input?.token === "string" ? input.token.trim() : "";
    if (!token)
      return c.json({ error: "invalid_input", message: "Cole o token do Workspace para esse servidor." }, 400);
    let remote: RemoteTool[];
    try {
      remote = await listRemote(connector.url, token);
    } catch (err) {
      return c.json(catalogFailure(connector.name, err), 422);
    }
    const sealed = await secrets.seal(token);
    const [fresh] = await db.transaction(async (tx) => {
      await saveCatalog(tx as unknown as Db, connector, remote);
      return tx
        .update(connectors)
        .set({ tokenCiphertext: sealed.ciphertext, tokenIv: sealed.iv, credentialState: "ok", refusedAt: null })
        .where(eq(connectors.id, connector.id))
        .returning();
    });
    return c.json(await toDto(fresh!));
  });

  /** Remover tira o catálogo e as concessões (cascata): as Ferramentas somem de todo Agente na hora. */
  routes.delete("/connectors/:id", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    await db.delete(connectors).where(eq(connectors.id, connector.id));
    return c.body(null, 204);
  });

  return { definitions, routes };
}
