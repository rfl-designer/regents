import type { ParticipantDto } from "@shearim/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Db, schema } from "./db/client";
import type { Audience } from "./events";

const { channelParticipants, members } = schema;

/**
 * O que a participação precisa saber de uma conversa: o id e se é aberta a todo Membro.
 * Hoje é um Canal (público ou privado). Uma DM (#18) é uma conversa fechada como o
 * Canal privado: só os participantes veem e recebem os eventos.
 */
export interface Conversation {
  id: string;
  kind: "public" | "private";
}

/** Os participantes de cada conversa pedida, em ordem de entrada. */
export async function participantsOf(db: Db, ids: readonly string[]): Promise<Map<string, ParticipantDto[]>> {
  const byConversation = new Map<string, ParticipantDto[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byConversation;
  const rows = await db
    .select({ conversationId: channelParticipants.channelId, id: members.id, displayName: members.displayName })
    .from(channelParticipants)
    .innerJoin(members, eq(members.id, channelParticipants.memberId))
    .where(inArray(channelParticipants.channelId, [...ids]))
    .orderBy(asc(channelParticipants.joinedAt), asc(members.displayName));
  for (const r of rows)
    byConversation.get(r.conversationId)?.push({ kind: "member", id: r.id, displayName: r.displayName });
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
