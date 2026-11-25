import type { MemoryItemDto } from "@shearim/contracts";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, isUuid, schema, type Tx } from "../db/client";
import type { EventHub } from "../events";
import type { Member } from "../members";
import { audienceOf, canSee, seenBy } from "../participation";

const { memoryItems, messages, members, agents, channels } = schema;

/**
 * O item de Memória (spec #60): criar, listar e anunciar. O alcance não é guardado: quem lê
 * confere a conversa de origem na hora (ADR 0012). Nada é apagado: a correção arquiva a versão
 * anterior, que aponta para a nova, e desfazer arquiva. A única exceção (spec #60) é a Memória do
 * Agente apagado, que sai junto com ele (`forgetAgent`).
 */

/** O trecho da mensagem de origem que a lista mostra. */
export const EXCERPT_LENGTH = 200;

/**
 * Grava, na transação `tx`, os itens que a extração `executionId` tirou da troca da mensagem de
 * origem `originMessageId`, na conversa `conversationId`: na Memória da Conversa ou na Memória do
 * Agente `agentId` (que respondeu), como cada um pede. Devolve os ids, na ordem.
 */
export async function insertExtracted(
  tx: Db | Tx,
  input: {
    conversationId: string;
    originMessageId: string;
    agentId: string;
    executionId: string;
    items: readonly { scope: "conversation" | "agent"; text: string }[];
    now: Date;
  },
): Promise<string[]> {
  if (input.items.length === 0) return [];
  const rows = input.items.map(({ scope, text }) => ({
    id: crypto.randomUUID(),
    scope,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    agentId: scope === "agent" ? input.agentId : null,
    text,
    createdBy: "extraction" as const,
    executionId: input.executionId,
    state: "active" as const,
    createdAt: input.now,
  }));
  await tx.insert(memoryItems).values(rows);
  return rows.map((r) => r.id);
}

type Item = typeof memoryItems.$inferSelect;

/**
 * O item `id`, se `who` pode desfazê-lo ou corrigi-lo: quem vê a conversa de origem (ADR 0012) e,
 * na Memória do Workspace, só o Admin. Vale para os três escopos: a Memória do Agente segue a
 * origem como a da Conversa. Quem não vê a origem recebe `not_found`, como se o item não existisse.
 */
export async function editableItem(
  db: Db | Tx,
  who: Pick<Member, "id" | "role">,
  id: string,
): Promise<Item | "not_found" | "not_admin"> {
  if (!isUuid(id)) return "not_found";
  const [item] = await db.select().from(memoryItems).where(eq(memoryItems.id, id));
  if (!item) return "not_found";
  if (item.scope === "workspace") return who.role === "admin" ? item : "not_admin";
  const [origin] = await db.select().from(channels).where(eq(channels.id, item.conversationId!));
  return origin && (await canSee(db, who.id, origin)) ? item : "not_found";
}

/**
 * Apaga a Memória do Agente `agentId`, ativos e arquivados: o único apagamento de Memória (spec
 * #60), quando o Admin apaga o Agente (#65). A Memória da Conversa que ele gerou fica. Quem chama
 * já cancelou a extração em andamento dele.
 */
export async function forgetAgent(db: Db, agentId: string): Promise<void> {
  await db.delete(memoryItems).where(and(eq(memoryItems.scope, "agent"), eq(memoryItems.agentId, agentId)));
}

/** O item `id` travado para mudar na transação `tx`, se ainda ativo (senão, nada a mudar). */
export async function lockActiveItem(tx: Tx, id: string) {
  const [item] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id)).for("update");
  return item?.state === "active" ? item : undefined;
}

/** Desfaz o item `id`: arquiva sem versão nova. `archived` se ele já não estava ativo. */
export function undoItem(db: Db, input: { id: string; now: Date }): Promise<"ok" | "archived"> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveItem(tx, input.id))) return "archived";
    await tx.update(memoryItems).set({ state: "archived", archivedAt: input.now }).where(eq(memoryItems.id, input.id));
    return "ok";
  });
}

/**
 * Corrige o item `id` pela mão de `by`: a versão nova, com a mesma origem e o mesmo escopo,
 * substitui a anterior. Devolve o id da nova, ou `archived` se o item já não estava ativo.
 */
export function correctItem(
  db: Db,
  input: { id: string; text: string; by: Pick<Member, "id" | "role">; now: Date },
): Promise<string | "archived"> {
  return db.transaction(async (tx) => {
    const old = await lockActiveItem(tx, input.id);
    if (!old) return "archived";
    return replaceItem(tx, old, {
      text: input.text,
      originMessageId: old.originMessageId,
      createdBy: input.by.role === "admin" ? "admin" : "member",
      createdByMemberId: input.by.id,
      now: input.now,
    });
  });
}

/**
 * Substitui o item ativo `old` (já travado em `tx`) por uma versão nova com o mesmo escopo (ou o
 * do Workspace, na promoção) e o mesmo Agente, e arquiva o anterior, que aponta para ela (nada é
 * apagado). A origem é a de `next`: a correção de gente mantém a mensagem e a conversa do item; a
 * extração põe a mensagem em que a pessoa mudou o fato e a conversa dela, que pode ser outra
 * quando a lição veio de outra conversa do alcance (#68): a versão nova nunca alcança mais do que
 * a conversa em que foi dita (ADR 0012). Devolve o id da nova.
 */
export async function replaceItem(
  tx: Tx,
  old: Item,
  next: {
    text: string;
    originMessageId: string | null;
    /** A conversa da origem nova, se não é a do item (a extração, #68). */
    conversationId?: string;
    createdBy: Item["createdBy"];
    createdByMemberId?: string;
    executionId?: string;
    /** Só na promoção (#66): a versão nova vai para a Memória do Workspace. */
    scope?: "workspace";
    now: Date;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await tx.insert(memoryItems).values({
    id,
    scope: next.scope ?? old.scope,
    conversationId: next.conversationId ?? old.conversationId,
    originMessageId: next.originMessageId,
    agentId: old.agentId,
    text: next.text,
    createdBy: next.createdBy,
    createdByMemberId: next.createdByMemberId ?? null,
    executionId: next.executionId ?? null,
    state: "active",
    createdAt: next.now,
  });
  await tx
    .update(memoryItems)
    .set({ state: "archived", replacedById: id, archivedAt: next.now })
    .where(eq(memoryItems.id, old.id));
  return id;
}

/**
 * Se o item pode ir para a Memória do Workspace: só um da Memória da Conversa de um Canal público.
 * Canal privado e DM, nunca: a promoção não alarga o alcance (ADR 0012).
 */
export async function isPromotable(db: Db | Tx, item: Item): Promise<boolean> {
  if (item.scope !== "conversation") return false;
  const [origin] = await db.select().from(channels).where(eq(channels.id, item.conversationId!));
  return origin?.kind === "public";
}

/**
 * Promove o item `id` à Memória do Workspace, pela mão do Admin `by`: a versão do Workspace, com
 * o mesmo texto e a mesma origem (a conversa e a mensagem), substitui a da Conversa, que fica
 * arquivada e aponta para ela. Devolve o id da nova, ou `archived` se o item já não estava ativo.
 * Quem chama já conferiu `isPromotable`.
 */
export function promoteItem(db: Db, input: { id: string; by: Pick<Member, "id">; now: Date }) {
  return db.transaction(async (tx): Promise<string | "archived"> => {
    const old = await lockActiveItem(tx, input.id);
    if (!old) return "archived";
    return replaceItem(tx, old, {
      text: old.text,
      originMessageId: old.originMessageId,
      createdBy: "admin",
      createdByMemberId: input.by.id,
      scope: "workspace",
      now: input.now,
    });
  });
}

const originAgent = alias(agents, "origin_agent");
const ownerAgent = alias(agents, "owner_agent");

/** Os itens que atendem a `where`, do mais novo para o mais velho, como quem vê a origem os vê. */
export async function selectMemory(db: Db | Tx, where: SQL | undefined): Promise<MemoryItemDto[]> {
  const rows = await db
    .select({
      item: memoryItems,
      origin: { id: messages.id, threadRootId: messages.threadRootId, body: messages.body },
      memberName: members.displayName,
      agentName: originAgent.name,
      owner: { id: ownerAgent.id, name: ownerAgent.name },
    })
    .from(memoryItems)
    .leftJoin(messages, eq(messages.id, memoryItems.originMessageId))
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(originAgent, eq(originAgent.id, messages.authorAgentId))
    .leftJoin(ownerAgent, eq(ownerAgent.id, memoryItems.agentId))
    .where(where)
    .orderBy(desc(memoryItems.seq));
  return rows.map(({ item, origin, memberName, agentName, owner }) => ({
    id: item.id,
    scope: item.scope,
    conversationId: item.conversationId,
    origin: origin
      ? {
          messageId: origin.id,
          threadRootId: origin.threadRootId,
          author: memberName ?? agentName ?? "Alguém",
          excerpt: clip(origin.body),
        }
      : null,
    agent: owner?.id ? { id: owner.id, name: owner.name } : null,
    text: item.text,
    createdBy: item.createdBy,
    state: item.state,
    replacedById: item.replacedById,
    createdAt: item.createdAt.toISOString(),
    archivedAt: item.archivedAt?.toISOString() ?? null,
  }));
}

/**
 * A Memória nascida na conversa `conversationId` (com as Threads), ativos e arquivados, do mais
 * novo para o mais velho: a Memória da Conversa, os itens dela promovidos à Memória do Workspace e
 * a Memória do Agente cuja origem é ela (o Andamento da mensagem de origem mostra toda escrita da
 * extração). Quem chama já conferiu que quem olha vê a conversa, e então vê a origem de todos.
 */
export function conversationMemory(db: Db, conversationId: string) {
  return selectMemory(db, eq(memoryItems.conversationId, conversationId));
}

/**
 * A Memória do Agente `agentId` como `viewerId` a vê (a tela do Agente): só os itens cuja
 * conversa de origem ele vê (ADR 0012), Admin inclusive. Ativos e arquivados, do mais novo para o
 * mais velho.
 */
export function agentMemory(db: Db, agentId: string, viewerId: string) {
  return selectMemory(
    db,
    and(
      eq(memoryItems.scope, "agent"),
      eq(memoryItems.agentId, agentId),
      seenBy(db, viewerId, memoryItems.conversationId),
    ),
  );
}

/**
 * Os itens com origem numa das conversas `conversationIds` (o alcance de uma resposta, ADR 0012):
 * da Memória da Conversa, ou da Memória do Agente `agentId`. O resumo (`summary.ts`) e a busca
 * (`search.ts`) filtram por aqui.
 */
export function inReach(
  conversationIds: readonly string[],
  of: { scope: "conversation" } | { scope: "agent"; agentId: string },
): SQL {
  if (conversationIds.length === 0) return sql`false`;
  return and(
    eq(memoryItems.scope, of.scope),
    of.scope === "agent" ? eq(memoryItems.agentId, of.agentId) : undefined,
    inArray(memoryItems.conversationId, [...conversationIds]),
  )!;
}

/** A Memória do Workspace, ativos e arquivados, do mais novo para o mais velho: todo Membro a vê. */
export function workspaceMemory(db: Db) {
  return selectMemory(db, eq(memoryItems.scope, "workspace"));
}

/**
 * Escreve um item direto na Memória do Workspace, pela mão do Admin `by`: sem conversa nem
 * mensagem de origem. Devolve o id.
 */
export async function writeWorkspaceItem(
  db: Db,
  input: { text: string; by: Pick<Member, "id">; now: Date },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(memoryItems).values({
    id,
    scope: "workspace",
    conversationId: null,
    originMessageId: null,
    text: input.text,
    createdBy: "admin",
    createdByMemberId: input.by.id,
    state: "active",
    createdAt: input.now,
  });
  return id;
}

/**
 * Anuncia `memory.updated` de cada item a quem vê a conversa de origem (ADR 0012). A Memória do
 * Workspace escrita direto por um Admin (sem origem) vai a todos.
 */
export async function publishMemory(db: Db, events: EventHub, ids: readonly string[]) {
  if (ids.length === 0) return;
  const items = await selectMemory(db, inArray(memoryItems.id, [...ids]));
  for (const item of items.reverse()) {
    const [conversation] = item.conversationId
      ? await db.select().from(channels).where(eq(channels.id, item.conversationId))
      : [];
    const audience = conversation ? await audienceOf(db, conversation) : "everyone";
    events.publish(audience, { type: "memory.updated", item });
  }
}

function clip(text: string) {
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}
