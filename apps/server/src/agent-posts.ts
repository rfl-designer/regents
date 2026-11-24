import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import { recordMentions } from "./mentions";
import { findMessage } from "./messages";
import { audienceOf } from "./participation";
import type { Push } from "./push";
import type { Reading } from "./reading";
import { recordFollows } from "./threads";
import type { PostAsAgent } from "./tools/port";

const { channels, messages } = schema;

/**
 * Uma mensagem de Agente que não é resposta ancorada: a escrita aprovada de "postar mensagem" e
 * "responder em Thread" (ADR 0011). Sai como do Agente e não passa por quem age (`whoActs`): não
 * dispara Desfecho nem aciona Agente. As Menções a pessoas valem como hoje (push, não-lidas,
 * seguir a Thread).
 */
export function createAgentPoster(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  reading: Pick<Reading, "messageCreated">;
  push: Pick<Push, "messageCreated">;
}): PostAsAgent {
  const { db, clock, events, reading, push } = deps;
  return async ({ agentId, conversationId, threadRootId, body }) => {
    const [conversation] = await db.select().from(channels).where(eq(channels.id, conversationId));
    if (!conversation) throw new Error(`a conversa ${conversationId} não existe`);
    const id = crypto.randomUUID();
    const createdAt = clock.now();
    const followed = await db.transaction(async (tx) => {
      await tx
        .insert(messages)
        .values({ id, channelId: conversationId, authorAgentId: agentId, threadRootId, body, createdAt });
      const mentions = await recordMentions(tx, id, conversation, body);
      return threadRootId
        ? recordFollows(tx, { conversationId, threadRootId, authorMemberId: null, mentions, createdAt })
        : [];
    });
    const dto = (await findMessage(db, id))!;
    events.publish(await audienceOf(db, conversation), { type: "message.created", message: dto });
    for (const { memberId, thread } of followed) {
      events.publish({ members: [memberId] }, { type: "thread.followed", thread });
    }
    await reading.messageCreated(dto);
    push.messageCreated(dto, conversation);
    return dto;
  };
}
