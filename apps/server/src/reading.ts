import type { MarkReadInput, MessageDto, UnreadDto, UnreadMessagesDto } from "@shearim/contracts";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Context, Hono } from "hono";
import type { Clock } from "./clock";
import { findVisibleConversation, isUuid } from "./conversations";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { Member } from "./members";
import { handleOf, mentionHandles } from "./mentions";

type Env = { Variables: { member: Member } };

const { messages, messageReads, channelParticipants, channels, members } = schema;
const origins = alias(messages, "origins");

/** Quantas mensagens uma marcação aceita de uma vez (uma tela cheia cabe com folga). */
const MARK_MAX = 500;

/**
 * Leitura e não-lido (Spec, módulo 10). O servidor guarda **quais mensagens** cada Membro viu
 * (`message_reads`), não um cursor. Conta como não-lida, para cada participante da conversa,
 * toda mensagem que chegou depois de ele entrar, não é dele e ainda não apareceu na tela dele:
 * a resposta ancorada inclusive.
 *
 * Expõe a contagem por conversa, a de Menções e DMs, a primeira não-lida na ordem de exibição
 * e o total do badge. O `setAppBadge` e o push (#32) leem o `total` daqui.
 */
export function createReading(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
  const routes = new Hono<Env>();

  async function publishTo(member: Member) {
    events.publish({ members: [member.id] }, { type: "unread.updated", unread: await unreadOf(db, member) });
  }

  routes.get("/unread", async (c) => c.json(await unreadOf(db, c.get("member"))));

  const visible = (c: Context<Env>) => findVisibleConversation(db, c.get("member"), c.req.param("id")!);

  routes.get("/conversations/:id/unread", async (c) => {
    const conversation = await visible(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const rows = await unreadRows(db, c.get("member").id, conversation.id);
    return c.json({ messageIds: rows.map((r) => r.id) } satisfies UnreadMessagesDto);
  });

  /** O cliente marca o que apareceu na tela; o que não é da conversa, ou é de quem marca, fica de fora. */
  routes.post("/conversations/:id/reads", async (c) => {
    const me = c.get("member");
    const conversation = await visible(c);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as Partial<MarkReadInput> | null;
    const ids = input?.messageIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && isUuid(id)) || ids.length > MARK_MAX) {
      return c.json({ error: "invalid_input", message: "Diga quais mensagens apareceram na tela." }, 400);
    }
    let marked = 0;
    if (ids.length > 0) {
      const theirs = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            inArray(messages.id, [...new Set(ids)]),
            eq(messages.channelId, conversation.id),
            or(isNull(messages.authorMemberId), ne(messages.authorMemberId, me.id)),
          ),
        );
      if (theirs.length > 0) {
        const now = clock.now();
        const added = await db
          .insert(messageReads)
          .values(theirs.map((m) => ({ memberId: me.id, messageId: m.id, readAt: now })))
          .onConflictDoNothing()
          .returning({ id: messageReads.messageId });
        marked = added.length;
      }
    }
    const unread = await unreadOf(db, me);
    // As outras abas e aparelhos do Membro acompanham.
    if (marked > 0) events.publish({ members: [me.id] }, { type: "unread.updated", unread });
    return c.json(unread);
  });

  return {
    routes,
    /**
     * Chame depois de gravar e anunciar uma mensagem nova (de pessoa ou a resposta de um Agente):
     * avisa as não-lidas novas a quem participa da conversa, menos o autor.
     */
    async messageCreated(message: Pick<MessageDto, "channelId" | "author">) {
      const author = message.author.kind === "member" ? message.author.id : undefined;
      const people = await db
        .select({ member: members })
        .from(channelParticipants)
        .innerJoin(members, eq(members.id, channelParticipants.memberId))
        .where(eq(channelParticipants.channelId, message.channelId));
      for (const { member } of people) if (member.id !== author) await publishTo(member);
    },
  };
}

export type Reading = ReturnType<typeof createReading>;

/**
 * SEAM do #19: se a mensagem menciona o Membro. Hoje, `@nome` casa com o nome dele, como os
 * Agentes em `mentions.ts`; com o identificador de Menção do #19, compare com ele.
 */
function mentions(body: string, member: Member) {
  return mentionHandles(body).has(handleOf(member.displayName));
}

/**
 * As não-lidas do Membro (numa conversa, ou em todas), na ordem de exibição: cada mensagem de
 * pessoa na ordem de gravação, seguida das respostas ancoradas sob ela.
 */
async function unreadRows(db: Db, memberId: string, conversationId?: string) {
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.channelId,
      kind: channels.kind,
      body: messages.body,
      seq: messages.seq,
      originSeq: origins.seq,
    })
    .from(messages)
    .innerJoin(
      channelParticipants,
      and(eq(channelParticipants.channelId, messages.channelId), eq(channelParticipants.memberId, memberId)),
    )
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(origins, eq(origins.id, messages.originMessageId))
    .leftJoin(messageReads, and(eq(messageReads.messageId, messages.id), eq(messageReads.memberId, memberId)))
    .where(
      and(
        conversationId ? eq(messages.channelId, conversationId) : undefined,
        isNull(messageReads.messageId),
        or(isNull(messages.authorMemberId), ne(messages.authorMemberId, memberId)),
        // Quem entrou depois não herda o que veio antes (a resposta que chega depois, sim).
        sql`${messages.createdAt} >= ${channelParticipants.joinedAt}`,
      ),
    );
  const key = (r: (typeof rows)[number]) => [r.originSeq ?? r.seq, r.originSeq === null ? 0 : 1, r.seq];
  return rows.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!;
  });
}

export async function unreadOf(db: Db, member: Member): Promise<UnreadDto> {
  const rows = await unreadRows(db, member.id);
  const byConversation = new Map<string, UnreadDto["conversations"][number]>();
  const unread: UnreadDto = { conversations: [], total: 0, mentions: 0, dms: 0 };
  for (const r of rows) {
    let c = byConversation.get(r.conversationId);
    if (!c) {
      c = { conversationId: r.conversationId, count: 0, mentions: 0, firstUnreadId: r.id };
      byConversation.set(r.conversationId, c);
      unread.conversations.push(c);
    }
    const mentioned = mentions(r.body, member);
    c.count++;
    unread.total++;
    if (mentioned) {
      c.mentions++;
      unread.mentions++;
    }
    if (r.kind === "dm" || r.kind === "group") unread.dms++;
  }
  return unread;
}
