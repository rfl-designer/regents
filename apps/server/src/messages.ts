import type { MessageDto } from "@shearim/contracts";
import { asc, eq } from "drizzle-orm";
import { type Db, schema } from "./db/client";

const { messages, members, agents } = schema;

/** Leitura das mensagens com o autor (pessoa ou Agente), no formato do contrato. */
function selectMessages(db: Db) {
  return db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      body: messages.body,
      originMessageId: messages.originMessageId,
      createdAt: messages.createdAt,
      memberId: members.id,
      memberName: members.displayName,
      agentId: agents.id,
      agentName: agents.name,
      agentPhoto: agents.photo,
    })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId));
}

type Row = Awaited<ReturnType<ReturnType<typeof selectMessages>["where"]>>[number];

function toDto(r: Row): MessageDto {
  return {
    id: r.id,
    channelId: r.channelId,
    body: r.body,
    author: r.agentId
      ? { kind: "agent", id: r.agentId, displayName: r.agentName!, photo: r.agentPhoto }
      : { kind: "member", id: r.memberId!, displayName: r.memberName! },
    originMessageId: r.originMessageId,
    createdAt: r.createdAt.toISOString(),
  };
}

/** As mensagens de uma conversa, em ordem de gravação (as respostas ancoradas inclusive). */
export async function listMessages(db: Db, channelId: string): Promise<MessageDto[]> {
  const rows = await selectMessages(db).where(eq(messages.channelId, channelId)).orderBy(asc(messages.seq));
  return rows.map(toDto);
}

export async function findMessage(db: Db, id: string): Promise<MessageDto | undefined> {
  const [row] = await selectMessages(db).where(eq(messages.id, id));
  return row && toDto(row);
}
