import {
  isDmKind,
  type MarkReadInput,
  type MessageDto,
  type UnreadDto,
  type UnreadMessagesDto,
} from "@shearim/contracts";
import { and, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Context, Hono } from "hono";
import type { Clock } from "./clock";
import { findVisibleConversation } from "./conversations";
import { type Db, isUuid, schema } from "./db/client";
import type { EventHub } from "./events";
import type { Env } from "./members";

const { messages, messageReads, messageMentions, channelParticipants, channels, threadFollows, approvalRequests } =
  schema;
const origins = alias(messages, "origins");
const roots = alias(messages, "roots");
const rootOrigins = alias(messages, "root_origins");

/** Quantas mensagens uma marcação aceita de uma vez (uma tela cheia cabe com folga). */
const MARK_MAX = 500;

/**
 * Leitura e não-lido (Spec, módulo 10). O servidor guarda **quais mensagens** cada Membro viu
 * (`message_reads`), não um cursor. Conta como não-lida, para cada participante da conversa,
 * toda mensagem que chegou depois de ele entrar, não é dele e ainda não apareceu na tela dele:
 * a resposta ancorada inclusive.
 *
 * Expõe a contagem por conversa, a de Menções e DMs, a primeira não-lida na ordem de exibição
 * e o total do badge (com os Pedidos de aprovação que esperam o Membro). O `setAppBadge` e o push
 * (#32) leem o `total` daqui.
 */
export function createReading(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
  const routes = new Hono<Env>();

  async function publishTo(memberId: string) {
    events.publish({ members: [memberId] }, { type: "unread.updated", unread: await unreadOf(db, memberId) });
  }

  routes.get("/unread", async (c) => c.json(await unreadOf(db, c.get("member").id)));

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
    const unread = await unreadOf(db, me.id);
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
        .select({ id: channelParticipants.memberId })
        .from(channelParticipants)
        .where(eq(channelParticipants.channelId, message.channelId));
      for (const { id } of people) if (id !== author) await publishTo(id);
    },
  };
}

export type Reading = ReturnType<typeof createReading>;

/**
 * As não-lidas do Membro (numa conversa, ou em todas), na ordem de exibição: cada mensagem de
 * pessoa do fluxo principal na ordem de gravação, seguida das respostas ancoradas sob ela e,
 * depois delas, das Threads que penduram ali (cada Thread na ordem dela, com as respostas
 * ancoradas sob cada mensagem).
 *
 * Uma mensagem de Thread só conta para quem segue a Thread, e só a partir de quando segue
 * (`thread_follows.since`): quem não segue vê no fluxo principal só o resumo da Thread, e não
 * ficaria com um badge que só some abrindo Threads de que não participa.
 */
async function unreadRows(db: Db, memberId: string, conversationId?: string) {
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.channelId,
      kind: channels.kind,
      /** A mensagem menciona o Membro (as Menções que o #19 registra ao gravar). */
      mentioned: sql<boolean>`${messageMentions.messageId} is not null`,
      seq: messages.seq,
      originSeq: origins.seq,
      rootSeq: roots.seq,
      rootOriginSeq: rootOrigins.seq,
    })
    .from(messages)
    .innerJoin(
      channelParticipants,
      and(eq(channelParticipants.channelId, messages.channelId), eq(channelParticipants.memberId, memberId)),
    )
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(origins, eq(origins.id, messages.originMessageId))
    .leftJoin(roots, eq(roots.id, messages.threadRootId))
    .leftJoin(rootOrigins, eq(rootOrigins.id, roots.originMessageId))
    .leftJoin(
      threadFollows,
      and(eq(threadFollows.rootMessageId, messages.threadRootId), eq(threadFollows.memberId, memberId)),
    )
    .leftJoin(messageReads, and(eq(messageReads.messageId, messages.id), eq(messageReads.memberId, memberId)))
    .leftJoin(messageMentions, and(eq(messageMentions.messageId, messages.id), eq(messageMentions.memberId, memberId)))
    .where(
      and(
        conversationId ? eq(messages.channelId, conversationId) : undefined,
        isNull(messageReads.messageId),
        or(isNull(messages.authorMemberId), ne(messages.authorMemberId, memberId)),
        // Quem entrou depois não herda o que veio antes (a resposta que chega depois, sim).
        sql`${messages.createdAt} >= ${channelParticipants.joinedAt}`,
        // Na Thread, só quem segue, desde quando segue.
        or(isNull(messages.threadRootId), sql`${messages.createdAt} >= ${threadFollows.since}`),
      ),
    );
  /** A posição na tela: [grupo, lugar no grupo, ...], comparada em ordem. */
  const key = (r: (typeof rows)[number]) => {
    if (r.rootSeq === null) return r.originSeq === null ? [r.seq, 0, 0, 0, 0] : [r.originSeq, 1, r.seq, 0, 0];
    // A Thread vem depois do grupo da raiz (a raiz pode ser uma resposta ancorada).
    const group = r.rootOriginSeq ?? r.rootSeq;
    return r.originSeq === null ? [group, 2, r.rootSeq, r.seq, 0] : [group, 2, r.rootSeq, r.originSeq, r.seq];
  };
  return rows.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  });
}

/**
 * As não-lidas do Membro. O `total` (o badge) conta também os Pedidos de aprovação que esperam a
 * decisão dele (o autor), até serem decididos, expirarem ou serem cancelados.
 */
export async function unreadOf(db: Db, memberId: string): Promise<UnreadDto> {
  const rows = await unreadRows(db, memberId);
  const [asked] = await db
    .select({ n: count() })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.authorMemberId, memberId), eq(approvalRequests.state, "pending")));
  const byConversation = new Map<string, UnreadDto["conversations"][number]>();
  const unread: UnreadDto = { conversations: [], total: asked?.n ?? 0, mentions: 0, dms: 0 };
  for (const r of rows) {
    let c = byConversation.get(r.conversationId);
    if (!c) {
      c = { conversationId: r.conversationId, count: 0, mentions: 0, firstUnreadId: r.id };
      byConversation.set(r.conversationId, c);
      unread.conversations.push(c);
    }
    c.count++;
    unread.total++;
    if (r.mentioned) {
      c.mentions++;
      unread.mentions++;
    }
    if (isDmKind(r.kind)) unread.dms++;
  }
  return unread;
}
