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
 *
 * No modo de cada Membro (#55), cada um liga a sua credencial em Perfil › Conectores, e a resposta
 * usa a do autor da mensagem de origem ("usou o CRM de Ana"). Sem ela, a Ferramenta responde
 * "indisponível" (a resposta segue) e só o autor vê o atalho "Ligar CRM". A recusa (401) marca a
 * credencial dele como recusada e o avisa (push e o Perfil).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CONNECTOR_LOGIN_CALLBACK_PATH,
  CONNECTORS_PATH,
  type ConnectorCredentialMode,
  type ConnectorDto,
  type ConnectorLoginDto,
  type ConnectorToolDto,
  type CreateConnectorInput,
  type CreateConnectorLoginInput,
  MY_CONNECTORS_PATH,
  type MyConnectorDto,
} from "@shearim/contracts";
import { and, asc, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, isUuid, schema, type Tx } from "../db/client";
import type { EventHub } from "../events";
import { adminOnly, type Env } from "../members";
import type { Push } from "../push";
import type { SecretBox } from "../secrets";
import {
  beginLogin,
  finishLogin,
  type LoginGrant,
  LoginRefused,
  type LoginTokens,
  NoLogin,
  type PendingLogin,
  renewLogin,
} from "./connector-login";
import { type ToolContext, type ToolDefinition, ToolFailure } from "./port";

const { connectors, connectorTools, connectorLogins, memberConnectorCredentials, members, messages } = schema;

type Connector = typeof connectors.$inferSelect;
type CatalogRow = typeof connectorTools.$inferSelect;

const NAME_MAX = 40;
/** O resultado de uma Ferramenta de Conector que volta ao modelo (o resto é cortado, com aviso). */
const RESULT_MAX = 50_000;
/** O id que o modelo recebe tem no máximo isto (o limite dos nomes de tool da Messages API). */
const TOOL_ID_MAX = 64;
/** Quanto tempo um login de Conector em andamento espera o retorno. */
const LOGIN_TTL_MS = 15 * 60_000;
/** A credencial do login se renova quando falta isto (ou menos) para o token de acesso vencer. */
const RENEW_MARGIN_MS = 10 * 60_000;
/** De quanto em quanto tempo se procuram as credenciais do login perto de vencer. */
const RENEW_CHECK_MS = 5 * 60_000;

/** Uma credencial como fica gravada: o token de acesso e, se veio do login, como renová-lo. */
interface StoredCredential {
  tokenCiphertext: string;
  tokenIv: string;
  oauthCiphertext: string | null;
  oauthIv: string | null;
  expiresAt: Date | null;
}

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

export function createConnectors(deps: {
  db: Db;
  clock: Clock;
  secrets: SecretBox;
  /** Avisa o Membro quando a credencial dele muda (o Perfil acompanha). */
  events?: EventHub;
  /** O push da credencial recusada, ao dono dela. */
  notify?: Push["notify"];
}) {
  const { db, clock, secrets } = deps;

  /** Um token colado: sem login, não vence nem se renova. */
  async function pasted(token: string): Promise<StoredCredential> {
    const sealed = await secrets.seal(token);
    return {
      tokenCiphertext: sealed.ciphertext,
      tokenIv: sealed.iv,
      oauthCiphertext: null,
      oauthIv: null,
      expiresAt: null,
    };
  }

  /** Os tokens do login (ou de uma renovação), cifrados, com o vencimento. */
  async function fromLogin(tokens: LoginTokens): Promise<StoredCredential> {
    const token = await secrets.seal(tokens.accessToken);
    const grant = await secrets.seal(JSON.stringify(tokens.grant));
    return {
      tokenCiphertext: token.ciphertext,
      tokenIv: token.iv,
      oauthCiphertext: grant.ciphertext,
      oauthIv: grant.iv,
      expiresAt: tokens.expiresIn === undefined ? null : new Date(clock.now().getTime() + tokens.expiresIn * 1000),
    };
  }

  /** O token de acesso vence logo (ou venceu): hora de renovar. Só o que veio do login vence. */
  const due = (row: { oauthCiphertext: string | null; expiresAt: Date | null }) =>
    Boolean(row.oauthCiphertext && row.expiresAt && row.expiresAt.getTime() - clock.now().getTime() <= RENEW_MARGIN_MS);
  const expired = (row: { expiresAt: Date | null }) => Boolean(row.expiresAt && row.expiresAt <= clock.now());

  /** As renovações em andamento, por credencial: duas ao mesmo tempo gastariam o mesmo token de renovação. */
  const renewing = new Map<string, Promise<"renewed" | "refused" | "failed">>();

  /**
   * Renova a credencial do login (a do Workspace, `memberId` nulo, ou a de um Membro). Recusada, segue
   * o caminho da credencial recusada: o Admin vê no Conector, ou o Membro é avisado. Sem resposta, fica
   * como está (a próxima tentativa é no próximo uso ou na próxima volta da vigia).
   */
  function renew(connectorId: string, memberId: string | null) {
    const key = `${connectorId}:${memberId ?? ""}`;
    const running = renewing.get(key);
    if (running) return running;
    const work = (async () => {
      const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
      if (!connector) return "failed" as const;
      const row = memberId ? await credentialOf(connectorId, memberId) : connector;
      if (!row?.oauthCiphertext || !row.oauthIv) return "failed" as const;
      try {
        const grant = JSON.parse(
          await secrets.open({ ciphertext: row.oauthCiphertext, iv: row.oauthIv }),
        ) as LoginGrant;
        const stored = await fromLogin(await renewLogin(grant));
        if (memberId) {
          await db
            .update(memberConnectorCredentials)
            .set(stored)
            .where(
              and(
                eq(memberConnectorCredentials.connectorId, connectorId),
                eq(memberConnectorCredentials.memberId, memberId),
              ),
            );
        } else {
          await db.update(connectors).set(stored).where(eq(connectors.id, connectorId));
        }
        return "renewed" as const;
      } catch (err) {
        if (err instanceof LoginRefused) {
          if (memberId) await refuseMember(connector, memberId);
          else await markRefused(connectorId);
          return "refused" as const;
        }
        console.error(`shearim: a renovação da credencial do Conector ${connector.name} falhou`, err);
        return "failed" as const;
      }
    })().finally(() => renewing.delete(key));
    renewing.set(key, work);
    return work;
  }

  /** Renova as credenciais do login que vencem logo (a vigia; também roda na subida). */
  async function renewDue() {
    const limit = new Date(clock.now().getTime() + RENEW_MARGIN_MS);
    const workspace = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          isNotNull(connectors.oauthCiphertext),
          lte(connectors.expiresAt, limit),
          eq(connectors.credentialState, "ok"),
        ),
      );
    const personal = await db
      .select({ connectorId: memberConnectorCredentials.connectorId, memberId: memberConnectorCredentials.memberId })
      .from(memberConnectorCredentials)
      .where(
        and(
          isNotNull(memberConnectorCredentials.oauthCiphertext),
          lte(memberConnectorCredentials.expiresAt, limit),
          eq(memberConnectorCredentials.state, "ok"),
        ),
      );
    for (const w of workspace) await renew(w.id, null);
    for (const p of personal) await renew(p.connectorId, p.memberId);
  }

  let stopWatch: (() => void) | undefined;
  let watching: Promise<void> = Promise.resolve();
  let stopped = true;
  function tick() {
    watching = watching
      .then(renewDue)
      .catch((err) => console.error("shearim: a renovação das credenciais dos Conectores falhou", err))
      .finally(() => {
        if (!stopped) stopWatch = clock.after(RENEW_CHECK_MS, tick);
      });
  }

  const modeOf = (connector: Connector): ConnectorCredentialMode =>
    connector.credentialMode === "member" ? "member" : "workspace";

  /** O autor da mensagem de origem da execução: de quem é a credencial no modo de cada Membro. */
  async function authorOf(ctx: ToolContext) {
    const [author] = await db
      .select({ id: members.id, name: members.displayName })
      .from(messages)
      .innerJoin(members, eq(members.id, messages.authorMemberId))
      .where(eq(messages.id, ctx.run.originMessageId));
    return author;
  }

  async function credentialOf(connectorId: string, memberId: string) {
    const [row] = await db
      .select()
      .from(memberConnectorCredentials)
      .where(
        and(eq(memberConnectorCredentials.connectorId, connectorId), eq(memberConnectorCredentials.memberId, memberId)),
      );
    return row;
  }

  function myDto(connector: Connector, credential: typeof memberConnectorCredentials.$inferSelect | undefined) {
    return {
      id: connector.id,
      name: connector.name,
      url: connector.url,
      credentialState: !credential ? "off" : credential.state === "refused" ? "refused" : "ok",
      refusedAt: credential?.refusedAt?.toISOString() ?? null,
    } satisfies MyConnectorDto;
  }

  /** O Perfil do Membro acompanha a credencial dele (ligada, desligada, recusada). */
  async function announceMine(connector: Connector, memberId: string) {
    deps.events?.publish(
      { members: [memberId] },
      { type: "my_connector.updated", connector: myDto(connector, await credentialOf(connector.id, memberId)) },
    );
  }

  /** O servidor recusou a credencial do Membro: fica recusada até ele ligar de novo, e ele é avisado. */
  async function refuseMember(connector: Connector, memberId: string) {
    await db
      .update(memberConnectorCredentials)
      .set({ state: "refused", refusedAt: clock.now() })
      .where(
        and(
          eq(memberConnectorCredentials.connectorId, connector.id),
          eq(memberConnectorCredentials.memberId, memberId),
        ),
      );
    await announceMine(connector, memberId);
    deps.notify?.(memberId, {
      title: `O ${connector.name} recusou a sua credencial`,
      body: `As Ferramentas do ${connector.name} ficam indisponíveis nas suas mensagens até você ligar de novo em Perfil › Conectores.`,
      path: MY_CONNECTORS_PATH,
      tag: `conector-${connector.id}`,
      urgency: "normal",
    });
  }

  async function open(sealed: { tokenCiphertext: string; tokenIv: string }, failure: string) {
    return secrets.open({ ciphertext: sealed.tokenCiphertext, iv: sealed.tokenIv }).catch(() => {
      throw new ToolFailure(failure);
    });
  }

  async function tokenOf(given: Connector): Promise<string> {
    let connector = given;
    if (due(connector)) {
      const renewed = await renew(connector.id, null);
      if (renewed === "refused") throw new ToolFailure(`o ${connector.name} recusou a credencial do Workspace`);
      if (renewed === "failed" && expired(connector)) {
        throw new ToolFailure(`não deu para renovar a credencial do Workspace do ${connector.name}`);
      }
      connector = (await db.select().from(connectors).where(eq(connectors.id, connector.id)))[0] ?? connector;
    }
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

  /** O token de acesso de um Membro, renovado antes se vence logo. */
  async function memberToken(
    connector: Connector,
    memberId: string,
    given: typeof memberConnectorCredentials.$inferSelect,
    reasons: { refused: string; failed: string; sealed: string; connect?: { connectorId: string; name: string } },
  ) {
    let credential = given;
    if (due(credential)) {
      const renewed = await renew(connector.id, memberId);
      if (renewed === "refused") throw new ToolFailure(reasons.refused, reasons.connect);
      if (renewed === "failed" && expired(credential)) throw new ToolFailure(reasons.failed, reasons.connect);
      credential = (await credentialOf(connector.id, memberId)) ?? credential;
    }
    return open(credential, reasons.sealed);
  }

  /**
   * A credencial com que a execução chama o Conector: a do Workspace, ou a do autor (no modo de cada
   * Membro). Sem a do autor, `ToolFailure` "indisponível", com o atalho "Ligar" para ele.
   */
  async function credentialFor(connector: Connector, ctx: ToolContext) {
    if (modeOf(connector) === "workspace") {
      return {
        token: await tokenOf(connector),
        whose: "do Workspace",
        refused: () => markRefused(connector.id),
        renew: connector.oauthCiphertext ? () => renew(connector.id, null) : undefined,
      };
    }
    const connect = { connectorId: connector.id, name: connector.name };
    const author = await authorOf(ctx);
    const credential = author && (await credentialOf(connector.id, author.id));
    if (!author || !credential) throw new ToolFailure(`indisponível: o autor não ligou o ${connector.name}`, connect);
    if (credential.state === "refused") {
      throw new ToolFailure(`indisponível: o ${connector.name} recusou a credencial do autor`, connect);
    }
    return {
      token: await memberToken(connector, author.id, credential, {
        refused: `o ${connector.name} recusou a credencial de ${author.name}`,
        failed: `não deu para renovar a credencial de ${author.name} no ${connector.name}`,
        sealed: `a credencial de ${author.name} no ${connector.name} não abre nesta Instalação`,
        connect,
      }),
      whose: `de ${author.name}`,
      refused: () => refuseMember(connector, author.id),
      renew: credential.oauthCiphertext ? () => renew(connector.id, author.id) : undefined,
      connect,
    };
  }

  /** Chama a Ferramenta `name` no servidor, com a credencial de agora. O texto, ou `ToolFailure`. */
  async function callRemote(
    connectorId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx: ToolContext,
    renewed = false,
  ): Promise<string> {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector) throw new ToolFailure("o Conector foi removido");
    const credential = await credentialFor(connector, ctx);
    const token = credential.token;
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await withRemote(connector.url, token, signal, (client) =>
        // O prazo é o da porta de Ferramentas (que aborta `signal`), não o do SDK.
        client.callTool({ name, arguments: args }, undefined, { signal, timeout: 2 ** 31 - 1 }),
      );
    } catch (err) {
      if (err instanceof Refused) {
        // O token do login pode ter vencido sem aviso (sem `expires_in`) ou sido revogado: renova uma vez.
        // Um 401 não executou nada, então repetir também vale para a escrita.
        const outcome = !renewed && credential.renew ? await credential.renew() : undefined;
        if (outcome === "renewed") return callRemote(connectorId, name, args, signal, ctx, true);
        // Recusada na renovação, `renew` já seguiu o caminho da credencial recusada.
        if (outcome !== "refused") await credential.refused();
        throw new ToolFailure(`o ${connector.name} recusou a credencial ${credential.whose}`, credential.connect);
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
    const mode = modeOf(connector);
    const base = {
      id: row.tool,
      title: row.title,
      label:
        mode === "workspace"
          ? `usando ${row.title} no ${connector.name}, com a credencial do Workspace`
          : `usando ${row.title} no ${connector.name}, com a credencial de quem pediu`,
      // No modo de cada Membro, o Andamento diz de quem é a credencial: "usou o CRM de Ana".
      ...(mode === "member"
        ? {
            async describe(ctx: ToolContext) {
              const author = await authorOf(ctx);
              if (!author) return {};
              return {
                label: `usando ${row.title} no ${connector.name} de ${author.name}`,
                used: `usou o ${connector.name} de ${author.name}`,
              };
            },
          }
        : {}),
      description: row.description || row.title,
      origin: "connector" as const,
      connector: { id: connector.id, name: connector.name, credential: mode },
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
        run: (ctx, input, signal) => callRemote(connector.id, row.name, argsOf(input), signal, ctx),
      };
    }
    return {
      ...base,
      access: "write",
      async prepare(ctx, input) {
        const args = argsOf(input);
        // Sem a credencial do autor, nem há Pedido: a Ferramenta está indisponível.
        const { whose } = await credentialFor(connector, ctx);
        return {
          action: { arguments: args },
          summary: `Usar “${row.title}” no ${connector.name}, com a credencial ${whose}: ${JSON.stringify(args)}`,
        };
      },
      perform: (ctx, action, signal) => callRemote(connector.id, row.name, argsOf(action.arguments), signal, ctx),
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
      credential: modeOf(connector),
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

  /** Grava (ou troca) a credencial do Membro, ligada; o Perfil dele acompanha. */
  async function saveMine(connector: Connector, memberId: string, credential: StoredCredential) {
    const values = { ...credential, state: "ok", refusedAt: null, connectedAt: clock.now() };
    await db
      .insert(memberConnectorCredentials)
      .values({ connectorId: connector.id, memberId, ...values })
      .onConflictDoUpdate({
        target: [memberConnectorCredentials.connectorId, memberConnectorCredentials.memberId],
        set: values,
      });
    await announceMine(connector, memberId);
  }

  const routes = new Hono<Env>();

  routes.use("/connectors/*", adminOnly);
  routes.use("/connectors", adminOnly);

  routes.get("/connectors", async (c) => {
    const all = await db.select().from(connectors).orderBy(asc(connectors.createdAt), asc(connectors.name));
    return c.json(await Promise.all(all.map((row) => toDto(row))));
  });

  /** O nome, o endereço e o modo de um Conector novo, conferidos; ou a resposta do erro. */
  async function newConnectorInput(c: Context<Env>, input: Partial<Record<keyof CreateConnectorLoginInput, unknown>>) {
    const invalid = (message: string) => ({ fail: c.json({ error: "invalid_input", message }, 400) });
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const url = typeof input.url === "string" ? input.url.trim() : "";
    const mode = input.credential ?? "workspace";
    if (mode !== "workspace" && mode !== "member") {
      return invalid("A credencial é do Workspace (`workspace`) ou de cada Membro (`member`).");
    }
    if (!name) return invalid("Dê um nome ao Conector.");
    if (name.length > NAME_MAX) return invalid(`O nome do Conector tem no máximo ${NAME_MAX} caracteres.`);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {}
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return invalid("O endereço do Conector é uma URL http(s).");
    }
    if (await nameTaken(name)) {
      return { fail: c.json({ error: "name_taken", message: "Já existe um Conector com esse nome." }, 409) };
    }
    return { name, url: parsed.href, mode: mode as ConnectorCredentialMode };
  }

  async function nameTaken(name: string) {
    const [same] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(sql`lower(${connectors.name}) = lower(${name})`);
    return Boolean(same);
  }

  /**
   * Grava o Conector com o catálogo lido. No modo do Workspace, `credential` é a do Workspace; no de
   * cada Membro, é a de quem adicionou (`memberId`).
   */
  async function insertConnector(
    values: { name: string; url: string; mode: ConnectorCredentialMode; memberId: string },
    credential: StoredCredential,
    remote: RemoteTool[],
  ) {
    const keys = new Set((await db.select({ key: connectors.key }).from(connectors)).map((r) => r.key));
    const { name, url, mode, memberId } = values;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(connectors)
        .values({
          id: crypto.randomUUID(),
          name,
          key: unique(slug(name, 24) || "conector", keys, 28),
          kind: "mcp",
          url,
          credentialMode: mode,
          // No modo de cada Membro não há credencial do Workspace: a credencial é a do próprio Admin.
          ...(mode === "workspace" ? credential : {}),
          credentialState: "ok",
          createdAt: clock.now(),
        })
        .returning();
      if (mode === "member") {
        await tx.insert(memberConnectorCredentials).values({
          connectorId: row!.id,
          memberId,
          ...credential,
          state: "ok",
          connectedAt: clock.now(),
        });
      }
      await saveCatalog(tx as unknown as Db, row!, remote);
      return row!;
    });
    if (mode === "member") await announceMine(created, memberId);
    return created;
  }

  routes.post("/connectors", async (c) => {
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<
      Record<keyof CreateConnectorInput, unknown>
    >;
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const checked = await newConnectorInput(c, input);
    if ("fail" in checked) return checked.fail;
    const { name, url, mode } = checked;
    if (!token) {
      return c.json(
        {
          error: "invalid_input",
          message:
            mode === "workspace"
              ? "Cole o token do Workspace para esse servidor (ou ligue pelo login dele)."
              : "Cole um token seu para esse servidor (ou ligue pelo login dele): ele lê as Ferramentas e vira a sua credencial.",
        },
        400,
      );
    }

    // O catálogo vem antes de gravar: um servidor que recusa o token ou não responde não vira Conector.
    let remote: RemoteTool[];
    try {
      remote = await listRemote(url, token);
    } catch (err) {
      return c.json(catalogFailure(name, err), 422);
    }
    const created = await insertConnector(
      { name, url, mode, memberId: c.get("member").id },
      await pasted(token),
      remote,
    );
    return c.json(await toDto(created), 201);
  });

  // ---------- Ligar pelo login do servidor (OAuth, #56) ----------

  /**
   * Começa um login: confere o endereço da Instalação, descobre o login do servidor, registra o
   * Shearim e guarda o fluxo (cifrado) até o retorno. `422 oauth_unavailable` sem login no servidor.
   */
  async function startLogin(
    c: Context<Env>,
    flow: {
      purpose: "create" | "workspace" | "member";
      label: string;
      url: string;
      origin: unknown;
      connectorId?: string;
      name?: string;
      mode?: ConnectorCredentialMode;
    },
  ) {
    let origin: string;
    try {
      const parsed = new URL(String(flow.origin ?? ""));
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
      origin = parsed.origin;
    } catch {
      return c.json({ error: "invalid_input", message: "O endereço da Instalação não é válido." }, 400);
    }
    const redirectUri = `${origin}${CONNECTOR_LOGIN_CALLBACK_PATH}`;
    const state = crypto.randomUUID();
    let started: Awaited<ReturnType<typeof beginLogin>>;
    try {
      started = await beginLogin(flow.url, redirectUri, state);
    } catch (err) {
      if (err instanceof NoLogin) {
        return c.json(
          {
            error: "oauth_unavailable",
            message: `O ${flow.label} não oferece login pelo servidor (${err.message}): cole um token.`,
          },
          422,
        );
      }
      return c.json(
        {
          error: "connector_unreachable",
          message: `Não foi possível começar o login do ${flow.label} nesse endereço: ${(err as Error).message || "sem resposta"}.`,
        },
        422,
      );
    }
    const now = clock.now();
    const sealed = await secrets.seal(JSON.stringify(started.pending));
    await db.delete(connectorLogins).where(lt(connectorLogins.createdAt, new Date(now.getTime() - LOGIN_TTL_MS)));
    await db.insert(connectorLogins).values({
      state,
      memberId: c.get("member").id,
      purpose: flow.purpose,
      connectorId: flow.connectorId ?? null,
      name: flow.name ?? null,
      url: flow.url,
      credentialMode: flow.mode ?? null,
      redirectUri,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      createdAt: now,
    });
    return c.json({ authorizationUrl: started.authorizationUrl } satisfies ConnectorLoginDto);
  }

  /** Adicionar pelo login: o Conector só existe depois do retorno, com o catálogo que o login leu. */
  routes.post("/connectors/login", async (c) => {
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<
      Record<keyof CreateConnectorLoginInput, unknown>
    >;
    const checked = await newConnectorInput(c, input);
    if ("fail" in checked) return checked.fail;
    return startLogin(c, {
      purpose: "create",
      label: checked.name,
      url: checked.url,
      origin: input.origin,
      name: checked.name,
      mode: checked.mode,
    });
  });

  /** Religar a credencial do Workspace pelo login (depois de uma recusa, por exemplo). */
  routes.post("/connectors/:id/credential/login", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    if (modeOf(connector) === "member") {
      return c.json(
        {
          error: "member_credential",
          message: `O ${connector.name} usa a credencial de cada Membro: cada um liga a sua em Perfil › Conectores.`,
        },
        409,
      );
    }
    const input = (await c.req.json().catch(() => null)) as { origin?: unknown } | null;
    return startLogin(c, {
      purpose: "workspace",
      label: connector.name,
      url: connector.url,
      origin: input?.origin,
      connectorId: connector.id,
    });
  });

  /**
   * O retorno do login, pelo navegador de quem ligou (com a identidade dele): confere o `state`,
   * troca o código pelos tokens, lê o catálogo com eles e grava a credencial. Volta à tela de onde
   * saiu com o desfecho (`?conector=ligado` ou `?erro=`), como o retorno do GitHub.
   */
  routes.get(CONNECTOR_LOGIN_CALLBACK_PATH.replace(/^\/api/, ""), async (c) => {
    const me = c.get("member");
    const back = (path: string, error?: string) =>
      c.redirect(error ? `${path}?erro=${encodeURIComponent(error)}` : `${path}?conector=ligado`);
    const state = c.req.query("state");
    const [flow] = state ? await db.select().from(connectorLogins).where(eq(connectorLogins.state, state)) : [];
    if (!flow || flow.memberId !== me.id) {
      return back(
        me.role === "admin" ? CONNECTORS_PATH : MY_CONNECTORS_PATH,
        "Esse retorno não é de um login em andamento. Ligue de novo.",
      );
    }
    await db.delete(connectorLogins).where(eq(connectorLogins.state, flow.state));
    const path = flow.purpose === "member" ? MY_CONNECTORS_PATH : CONNECTORS_PATH;
    const existing = flow.connectorId ? await find(flow.connectorId) : undefined;
    const label = flow.name ?? existing?.name ?? "servidor";
    if (flow.purpose !== "member" && me.role !== "admin") return back(path, "Só o Admin liga esse Conector.");
    if (flow.purpose !== "create" && !existing) return back(path, "O Conector foi removido.");
    if (clock.now().getTime() - flow.createdAt.getTime() > LOGIN_TTL_MS) {
      return back(path, `O login no ${label} demorou demais. Ligue de novo.`);
    }
    const denied = c.req.query("error");
    if (denied) return back(path, `O login no ${label} não foi concluído (${denied}).`);
    const code = c.req.query("code");
    if (!code) return back(path, `O ${label} não mandou o código do login. Ligue de novo.`);

    let tokens: LoginTokens;
    try {
      const pending = JSON.parse(
        await secrets.open({ ciphertext: flow.secretCiphertext, iv: flow.secretIv }),
      ) as PendingLogin;
      tokens = await finishLogin(pending, code, flow.redirectUri);
    } catch (err) {
      if (err instanceof LoginRefused) return back(path, `O ${label} recusou o login. Ligue de novo.`);
      console.error(`shearim: o fim do login do Conector ${label} falhou`, err);
      return back(path, `O ${label} não respondeu ao fim do login. Ligue de novo.`);
    }
    let remote: RemoteTool[];
    try {
      remote = await listRemote(flow.url, tokens.accessToken);
    } catch (err) {
      return back(path, catalogFailure(label, err).message);
    }
    const credential = await fromLogin(tokens);

    if (flow.purpose === "create") {
      if (await nameTaken(label)) return back(path, "Já existe um Conector com esse nome.");
      const mode: ConnectorCredentialMode = flow.credentialMode === "member" ? "member" : "workspace";
      await insertConnector({ name: label, url: flow.url, mode, memberId: me.id }, credential, remote);
      return back(path);
    }
    const connector = existing!;
    if (flow.purpose === "workspace") {
      if (modeOf(connector) !== "workspace") return back(path, `O ${connector.name} usa a credencial de cada Membro.`);
      await db.transaction(async (tx) => {
        await saveCatalog(tx as unknown as Db, connector, remote);
        await tx
          .update(connectors)
          .set({ ...credential, credentialState: "ok", refusedAt: null })
          .where(eq(connectors.id, connector.id));
      });
      return back(path);
    }
    if (modeOf(connector) !== "member") return back(path, `O ${connector.name} usa a credencial do Workspace.`);
    await saveMine(connector, me.id, credential);
    return back(path);
  });

  /** Abrir o Conector relê o catálogo; se não der, mostra o último lido com o motivo. */
  routes.get("/connectors/:id", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    const me = c.get("member").id;
    const member = modeOf(connector) === "member";
    let token: string;
    try {
      if (member) {
        // No modo de cada Membro, o catálogo se relê com a credencial do próprio Admin.
        const mine = await credentialOf(connector.id, me);
        if (!mine || mine.state === "refused") {
          throw new ToolFailure(
            `Ligue a sua credencial do ${connector.name} em Perfil › Conectores para reler as Ferramentas.`,
          );
        }
        token = await memberToken(connector, me, mine, {
          refused: `O ${connector.name} recusou a sua credencial.`,
          failed: `Não deu para renovar a sua credencial do ${connector.name}.`,
          sealed: `A sua credencial do ${connector.name} não abre nesta Instalação.`,
        });
      } else {
        token = await tokenOf(connector);
      }
    } catch (err) {
      return c.json(await toDto(connector, (err as ToolFailure).reason));
    }
    try {
      const remote = await listRemote(connector.url, token);
      const [fresh] = await db.transaction(async (tx) => {
        await saveCatalog(tx as unknown as Db, connector, remote);
        // No modo de cada Membro não há estado do Workspace a limpar (um `set` vazio nem é SQL).
        if (member) return tx.select().from(connectors).where(eq(connectors.id, connector.id));
        return tx
          .update(connectors)
          .set({ credentialState: "ok", refusedAt: null })
          .where(eq(connectors.id, connector.id))
          .returning();
      });
      return c.json(await toDto(fresh!));
    } catch (err) {
      if (err instanceof Refused) {
        if (member) await refuseMember(connector, me);
        else await markRefused(connector.id);
      }
      const message = catalogFailure(connector.name, err).message;
      return c.json(
        await toDto(
          (await find(connector.id))!,
          member && err instanceof Refused ? `O ${connector.name} recusou a sua credencial.` : message,
        ),
      );
    }
  });

  /** Trocar o token (depois de uma recusa): vale só se o servidor o aceita. */
  routes.put("/connectors/:id/credential", async (c) => {
    const connector = await find(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    if (modeOf(connector) === "member") {
      return c.json(
        {
          error: "member_credential",
          message: `O ${connector.name} usa a credencial de cada Membro: cada um liga a sua em Perfil › Conectores.`,
        },
        409,
      );
    }
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
    const credential = await pasted(token);
    const [fresh] = await db.transaction(async (tx) => {
      await saveCatalog(tx as unknown as Db, connector, remote);
      return tx
        .update(connectors)
        .set({ ...credential, credentialState: "ok", refusedAt: null })
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

  // ---------- Perfil › Conectores: a credencial de cada Membro ----------

  /** Um Conector do modo de cada Membro, ou nada (o do Workspace não se liga pelo Perfil). */
  async function findMemberMode(id: string) {
    const connector = await find(id);
    return connector && modeOf(connector) === "member" ? connector : undefined;
  }

  routes.get("/me/connectors", async (c) => {
    const me = c.get("member").id;
    const rows = await db
      .select({ connector: connectors, credential: memberConnectorCredentials })
      .from(connectors)
      .leftJoin(
        memberConnectorCredentials,
        and(eq(memberConnectorCredentials.connectorId, connectors.id), eq(memberConnectorCredentials.memberId, me)),
      )
      .where(eq(connectors.credentialMode, "member"))
      .orderBy(asc(connectors.createdAt), asc(connectors.name));
    return c.json(rows.map((r) => myDto(r.connector, r.credential ?? undefined)));
  });

  /** Ligar (ou ligar de novo): vale só se o servidor aceita o token. */
  routes.put("/me/connectors/:id/credential", async (c) => {
    const connector = await findMemberMode(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    const me = c.get("member").id;
    const input = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof input?.token === "string" ? input.token.trim() : "";
    if (!token) {
      return c.json({ error: "invalid_input", message: `Cole o seu token do ${connector.name}.` }, 400);
    }
    try {
      await listRemote(connector.url, token);
    } catch (err) {
      return c.json(catalogFailure(connector.name, err), 422);
    }
    await saveMine(connector, me, await pasted(token));
    return c.json(myDto(connector, await credentialOf(connector.id, me)));
  });

  /** Ligar pelo login do servidor: o retorno grava a credencial e volta a Perfil › Conectores. */
  routes.post("/me/connectors/:id/credential/login", async (c) => {
    const connector = await findMemberMode(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as { origin?: unknown } | null;
    return startLogin(c, {
      purpose: "member",
      label: connector.name,
      url: connector.url,
      origin: input?.origin,
      connectorId: connector.id,
    });
  });

  /** Desligar: as Ferramentas do Conector ficam indisponíveis nas mensagens dele. */
  routes.delete("/me/connectors/:id/credential", async (c) => {
    const connector = await findMemberMode(c.req.param("id"));
    if (!connector) return c.json({ error: "not_found" }, 404);
    const me = c.get("member").id;
    await db
      .delete(memberConnectorCredentials)
      .where(
        and(eq(memberConnectorCredentials.connectorId, connector.id), eq(memberConnectorCredentials.memberId, me)),
      );
    await announceMine(connector, me);
    return c.body(null, 204);
  });

  return {
    definitions,
    routes,
    /** Liga a vigia que renova as credenciais do login antes de vencerem (a primeira volta é já). */
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    async stop() {
      stopped = true;
      stopWatch?.();
      await watching;
    },
  };
}

/** O Membro saiu do Workspace: as credenciais dele nos Conectores vão junto (quem volta liga de novo). */
export async function forgetMemberCredentials(db: Db | Tx, memberId: string) {
  await db.delete(memberConnectorCredentials).where(eq(memberConnectorCredentials.memberId, memberId));
  await db.delete(connectorLogins).where(eq(connectorLogins.memberId, memberId));
}
