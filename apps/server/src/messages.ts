import type { MessageDto } from "@shearim/contracts";
import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, schema } from "./db/client";
import { mentionsOf } from "./mentions";
import { wikiCitationsOf } from "./wiki/citations";

const { messages, members, agents, executions } = schema;
const origins = alias(messages, "origins");

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
      // Quem pagou a resposta de Agente (uma execução por resposta) e, pela Chave, o porquê que só
      // o autor da origem vê.
      payer: executions.payer,
      payerAccount: executions.payerAccount,
      originAuthorId: origins.authorMemberId,
    })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .leftJoin(executions, eq(executions.replyMessageId, messages.id))
    .leftJoin(origins, eq(origins.id, messages.originMessageId));
}

type Row = Awaited<ReturnType<ReturnType<typeof selectMessages>["where"]>>[number];

/**
 * A mensagem como `viewerId` a vê: o porquê da Chave pagando (`yourAccount`) só vai ao autor da
 * mensagem de origem; a citação da Wiki só abre para quem lê a Wiki.
 */
function toDto(r: Row, extra: Extra, viewerId: string | null): MessageDto {
  const wikiCitations = extra.citations.get(r.id);
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
    mentions: extra.mentions.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    // "⚠ pela Chave do Workspace" é de todos; pela Conta, nada aparece (a Conta é só do autor).
    ...(r.payer === "key" ? { payer: "key" as const } : {}),
    ...(r.payer === "key" && r.payerAccount && viewerId !== null && r.originAuthorId === viewerId
      ? { yourAccount: r.payerAccount }
      : {}),
    ...(wikiCitations ? { wikiCitations } : {}),
  };
}

interface Extra {
  mentions: Map<string, MessageDto["mentions"]>;
  citations: Map<string, NonNullable<MessageDto["wikiCitations"]>>;
}

/** As Menções e, nas respostas de Agente, as citações da Wiki como `viewerId` as vê. */
async function extraOf(db: Db, rows: Row[], viewerId: string | null): Promise<Extra> {
  return {
    mentions: await mentionsOf(
      db,
      rows.map((r) => r.id),
    ),
    citations: await wikiCitationsOf(
      db,
      rows.filter((r) => r.agentId),
      viewerId,
    ),
  };
}

/**
 * As mensagens de uma conversa, em ordem de gravação: as respostas ancoradas e as mensagens de
 * Thread inclusive (`threadRootId` diz de qual Thread; o cliente as separa do fluxo principal).
 */
export async function listMessages(db: Db, channelId: string, viewerId: string): Promise<MessageDto[]> {
  const rows = await selectMessages(db).where(eq(messages.channelId, channelId)).orderBy(asc(messages.seq));
  const extra = await extraOf(db, rows, viewerId);
  return rows.map((r) => toDto(r, extra, viewerId));
}

/**
 * Uma mensagem, como `viewerId` a vê (sem ele, a cópia de todos), e quem escreveu a mensagem de
 * origem (quem recebe a cópia do autor).
 */
export async function findMessage(db: Db, id: string, viewerId: string | null = null): Promise<MessageDto | undefined> {
  const [row] = await selectMessages(db).where(eq(messages.id, id));
  return row && toDto(row, await extraOf(db, [row], viewerId), viewerId);
}
