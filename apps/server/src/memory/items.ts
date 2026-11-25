import type { MemoryItemDto } from "@shearim/contracts";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, schema, type Tx } from "../db/client";
import type { EventHub } from "../events";
import { audienceOf } from "../participation";

const { memoryItems, messages, members, agents, channels } = schema;

/**
 * O item de Memória (spec #60): criar, listar e anunciar. O alcance não é guardado: quem lê
 * confere a conversa de origem na hora (ADR 0012). Nada é apagado: a correção arquiva a versão
 * anterior, que aponta para a nova, e desfazer arquiva.
 */

/** O trecho da mensagem de origem que a lista mostra. */
export const EXCERPT_LENGTH = 200;

/**
 * Grava, na transação `tx`, os itens que a extração `executionId` tirou da troca da mensagem de
 * origem `originMessageId`, na Memória da Conversa `conversationId`. Devolve os ids, na ordem.
 */
export async function insertExtracted(
  tx: Db | Tx,
  input: { conversationId: string; originMessageId: string; executionId: string; texts: readonly string[]; now: Date },
): Promise<string[]> {
  if (input.texts.length === 0) return [];
  const rows = input.texts.map((text) => ({
    id: crypto.randomUUID(),
    scope: "conversation" as const,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    text,
    createdBy: "extraction" as const,
    executionId: input.executionId,
    state: "active" as const,
    createdAt: input.now,
  }));
  await tx.insert(memoryItems).values(rows);
  return rows.map((r) => r.id);
}

const originAgent = alias(agents, "origin_agent");

/** Os itens que atendem a `where`, do mais novo para o mais velho, como quem vê a origem os vê. */
export async function selectMemory(db: Db | Tx, where: SQL | undefined): Promise<MemoryItemDto[]> {
  const rows = await db
    .select({
      item: memoryItems,
      origin: { id: messages.id, threadRootId: messages.threadRootId, body: messages.body },
      memberName: members.displayName,
      agentName: originAgent.name,
    })
    .from(memoryItems)
    .leftJoin(messages, eq(messages.id, memoryItems.originMessageId))
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(originAgent, eq(originAgent.id, messages.authorAgentId))
    .where(where)
    .orderBy(desc(memoryItems.seq));
  return rows.map(({ item, origin, memberName, agentName }) => ({
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
    text: item.text,
    createdBy: item.createdBy,
    state: item.state,
    replacedById: item.replacedById,
    createdAt: item.createdAt.toISOString(),
    archivedAt: item.archivedAt?.toISOString() ?? null,
  }));
}

/**
 * A Memória da Conversa `conversationId` (com as Threads), ativos e arquivados, do mais novo para
 * o mais velho. Quem chama já conferiu que quem olha vê a conversa.
 */
export function conversationMemory(db: Db, conversationId: string) {
  return selectMemory(db, and(eq(memoryItems.scope, "conversation"), eq(memoryItems.conversationId, conversationId)));
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
