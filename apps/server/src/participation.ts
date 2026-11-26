import type { ConversationKind, ParticipantDto } from "@shearim/contracts";
import { type AnyColumn, and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { type Db, schema, type Tx } from "./db/client";
import type { Audience } from "./events";

const { channelAgents, channelParticipants, members, agents, channels } = schema;

/**
 * O que a participação precisa saber de uma conversa: o id e o tipo.
 * Só o Canal público é aberto a todo Membro. Canal privado e DM (`dm`, `group`) são fechados:
 * só os participantes veem e recebem os eventos.
 */
export interface Conversation {
  id: string;
  kind: ConversationKind;
}

/**
 * Os participantes de cada conversa pedida (pessoas e Agentes), em ordem de entrada.
 * Só as pessoas contam para quem vê e quem recebe eventos; os Agentes estão ali para falar.
 */
export async function participantsOf(db: Db, ids: readonly string[]): Promise<Map<string, ParticipantDto[]>> {
  const byConversation = new Map<string, ParticipantDto[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byConversation;
  const people = await db
    .select({
      conversationId: channelParticipants.channelId,
      id: members.id,
      displayName: members.displayName,
      at: channelParticipants.joinedAt,
    })
    .from(channelParticipants)
    .innerJoin(members, eq(members.id, channelParticipants.memberId))
    .where(inArray(channelParticipants.channelId, [...ids]))
    .orderBy(asc(channelParticipants.joinedAt), asc(members.displayName));
  const bots = await db
    .select({
      conversationId: channelAgents.channelId,
      id: agents.id,
      displayName: agents.name,
      photo: agents.photo,
      at: channelAgents.addedAt,
    })
    .from(channelAgents)
    .innerJoin(agents, eq(agents.id, channelAgents.agentId))
    .where(inArray(channelAgents.channelId, [...ids]))
    .orderBy(asc(channelAgents.addedAt), asc(agents.name));
  const all = [
    ...people.map((r) => ({ ...r, dto: { kind: "member", id: r.id, displayName: r.displayName } as ParticipantDto })),
    ...bots.map((r) => ({
      ...r,
      dto: { kind: "agent", id: r.id, displayName: r.displayName, photo: r.photo } as ParticipantDto,
    })),
  ];
  // Ordenação estável: pessoas antes de Agentes na mesma hora.
  all.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const r of all) byConversation.get(r.conversationId)?.push(r.dto);
  return byConversation;
}

export async function isParticipant(db: Db, conversationId: string, memberId: string) {
  const [row] = await db
    .select({ memberId: channelParticipants.memberId })
    .from(channelParticipants)
    .where(and(eq(channelParticipants.channelId, conversationId), eq(channelParticipants.memberId, memberId)));
  return row !== undefined;
}

/**
 * Se o Membro vê a conversa (na lista, nas mensagens e nos eventos).
 * Pública: todo Membro. Fechada: só quem participa; ser Admin não muda isso.
 */
export async function canSee(db: Db, memberId: string, conversation: Conversation) {
  return conversation.kind === "public" || isParticipant(db, conversation.id, memberId);
}

/**
 * A condição "o Membro vê a conversa" sobre uma coluna com o id dela, para filtrar uma lista em
 * SQL: a mesma regra de `canSee` (o Canal público, ou a conversa fechada de que ele participa).
 */
export function seenBy(db: Db | Tx, memberId: string, conversationId: AnyColumn): SQL {
  const mine = db
    .select({ id: channelParticipants.channelId })
    .from(channelParticipants)
    .where(eq(channelParticipants.memberId, memberId));
  return inArray(
    conversationId,
    db
      .select({ id: channels.id })
      .from(channels)
      .where(or(eq(channels.kind, "public"), inArray(channels.id, mine))),
  );
}

/** Quem recebe os eventos da conversa: a mesma regra de `canSee`, do lado do `EventHub`. */
export async function audienceOf(db: Db, conversation: Conversation): Promise<Audience> {
  if (conversation.kind === "public") return "everyone";
  const rows = await db
    .select({ memberId: channelParticipants.memberId })
    .from(channelParticipants)
    .where(eq(channelParticipants.channelId, conversation.id));
  return { members: rows.map((r) => r.memberId) };
}

/** Põe pessoas na conversa. Quem já participa fica como está. Devolve se alguém entrou. */
export async function addParticipants(db: Db, conversationId: string, memberIds: readonly string[], at: Date) {
  if (memberIds.length === 0) return false;
  const added = await db
    .insert(channelParticipants)
    .values(memberIds.map((memberId) => ({ channelId: conversationId, memberId, joinedAt: at })))
    .onConflictDoNothing()
    .returning({ memberId: channelParticipants.memberId });
  return added.length > 0;
}

/** Põe um Agente na conversa. Se já estava, fica como está. Devolve se ele entrou. */
export async function addAgent(db: Db, conversationId: string, agentId: string, at: Date) {
  const added = await db
    .insert(channelAgents)
    .values({ channelId: conversationId, agentId, addedAt: at })
    .onConflictDoNothing()
    .returning({ agentId: channelAgents.agentId });
  return added.length > 0;
}
