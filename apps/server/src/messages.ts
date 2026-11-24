import type { MessageDto } from "@shearim/contracts";
import { asc, eq } from "drizzle-orm";
import { type Db, schema } from "./db/client";
import { mentionsOf } from "./mentions";

const { messages, members, agents } = schema;

/** Leitura das mensagens com o autor (pessoa ou Agente), no formato do contrato. */
function selectMessages(db: Db) {
  return db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      body: messages.body,
      originMessageId: messages.originMessageId,
      threadRootId: messages.threadRootId,
      createdAt: messages.createdAt,
      memberId: members.id,
      memberName: members.displayName,
      memberPic: members.profilePicUrl,
      memberLeftAt: members.leftAt,
      agentId: agents.id,
      agentName: agents.name,
      agentPhoto: agents.photo,
    })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId));
}

type Row = Awaited<ReturnType<ReturnType<typeof selectMessages>["where"]>>[number];

function toDto(r: Row, mentions: Map<string, MessageDto["mentions"]>): MessageDto {
  return {
    id: r.id,
    channelId: r.channelId,
    body: r.body,
    author: r.agentId
      ? { kind: "agent", id: r.agentId, displayName: r.agentName!, photo: r.agentPhoto }
      : {
          kind: "member",
          id: r.memberId!,
          displayName: r.memberName!,
          profilePicUrl: r.memberPic,
          leftWorkspace: r.memberLeftAt !== null,
        },
    originMessageId: r.originMessageId,
    threadRootId: r.threadRootId,
    mentions: mentions.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * As mensagens de uma conversa, em ordem de gravação: as respostas ancoradas e as mensagens de
 * Thread inclusive (`threadRootId` diz de qual Thread; o cliente as separa do fluxo principal).
 */
export async function listMessages(db: Db, channelId: string): Promise<MessageDto[]> {
  const rows = await selectMessages(db).where(eq(messages.channelId, channelId)).orderBy(asc(messages.seq));
  const mentions = await mentionsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDto(r, mentions));
}

export async function findMessage(db: Db, id: string): Promise<MessageDto | undefined> {
  const [row] = await selectMessages(db).where(eq(messages.id, id));
  return row && toDto(row, await mentionsOf(db, [row.id]));
}
