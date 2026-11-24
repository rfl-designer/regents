import type { FollowedThreadDto, MentionDto } from "@shearim/contracts";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, schema } from "./db/client";
import type { Member } from "./members";

type Env = { Variables: { member: Member } };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const { messages, messageMentions, threadFollows } = schema;

/**
 * Threads e Thread seguida (Spec, módulo 3). Uma Thread é a sequência de mensagens com o mesmo
 * `messages.thread_root_id`, pendurada numa mensagem do fluxo principal da mesma conversa. A
 * primeira resposta abre a Thread; não há linha de "Thread" à parte.
 *
 * Quem segue: o autor da raiz, quem respondeu e quem foi mencionado na Thread ou na raiz (a
 * Menção que o #19 registra, só de quem vê a conversa). Agentes não seguem. Seguir é uma vez só,
 * desde a mensagem que fez seguir.
 *
 * SEAM do #32 (push de Thread seguida): `followersOf(db, raiz)` diz quem avisar.
 */

/**
 * Registra quem passa a seguir a Thread por causa desta mensagem (na mesma transação em que ela é
 * gravada): a de pessoa faz seguir o autor; a de Agente (`authorMemberId` nulo), só quem ela
 * menciona e quem já seguiria pela raiz. Devolve só quem começou a seguir agora, com a Thread como
 * ele a vê.
 */
export async function recordFollows(
  tx: Tx,
  message: {
    conversationId: string;
    threadRootId: string;
    authorMemberId: string | null;
    mentions: readonly MentionDto[];
    createdAt: Date;
  },
): Promise<{ memberId: string; thread: FollowedThreadDto }[]> {
  const [root] = await tx
    .select({ authorMemberId: messages.authorMemberId })
    .from(messages)
    .where(eq(messages.id, message.threadRootId));
  const inRoot = await tx
    .select({ memberId: messageMentions.memberId })
    .from(messageMentions)
    .where(and(eq(messageMentions.messageId, message.threadRootId), isNotNull(messageMentions.memberId)));
  const people = new Set<string>([
    ...(root?.authorMemberId ? [root.authorMemberId] : []),
    ...(message.authorMemberId ? [message.authorMemberId] : []),
    ...message.mentions.filter((m) => m.kind === "member").map((m) => m.id),
    ...inRoot.map((m) => m.memberId!),
  ]);
  const added = await tx
    .insert(threadFollows)
    .values(
      [...people].map((memberId) => ({
        memberId,
        rootMessageId: message.threadRootId,
        conversationId: message.conversationId,
        since: message.createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning();
  return added.map((row) => ({ memberId: row.memberId, thread: toDto(row) }));
}

/** Quem segue a Thread (os ids de Membro). É quem o push de Thread seguida (#32) avisa. */
export async function followersOf(db: Db | Tx, rootMessageId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: threadFollows.memberId })
    .from(threadFollows)
    .where(eq(threadFollows.rootMessageId, rootMessageId));
  return rows.map((r) => r.memberId);
}

export function threadRoutes(deps: { db: Db }) {
  const { db } = deps;
  const routes = new Hono<Env>();

  /** As Threads que quem pede segue, da mais antiga para a mais nova. */
  routes.get("/threads/followed", async (c) => {
    const rows = await db
      .select()
      .from(threadFollows)
      .where(eq(threadFollows.memberId, c.get("member").id))
      .orderBy(asc(threadFollows.since), asc(threadFollows.rootMessageId));
    return c.json(rows.map(toDto));
  });

  return routes;
}

function toDto(row: typeof threadFollows.$inferSelect): FollowedThreadDto {
  return { conversationId: row.conversationId, rootMessageId: row.rootMessageId, since: row.since.toISOString() };
}
