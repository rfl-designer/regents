import { and, eq } from "drizzle-orm";
import { type Db, schema } from "./db/client";
import { isActive } from "./members";
import type { ToolRun } from "./tools/port";

const { channels, channelParticipants, members, messages } = schema;

/**
 * Quem vê a conversa de uma resposta: `"everyone"` num Canal público; senão, os ids dos
 * participantes pessoas ativos (sem quem saiu do Workspace) e o do autor da mensagem de origem.
 * Os Agentes não contam: eles estão na conversa para falar, e participar não abre o alcance.
 */
export type Viewers = "everyone" | readonly string[];

/**
 * Quem vê a conversa da resposta, com a participação de agora (spec #44 e #74): a peça comum ao
 * alcance das Ferramentas do Workspace (`reachOf`) e ao da Wiki (`wikisInReach`). `undefined`
 * quando a conversa ou a mensagem de origem não existem mais.
 */
export async function viewersOf(
  db: Db,
  answer: Pick<ToolRun, "channelId" | "originMessageId">,
): Promise<Viewers | undefined> {
  const [here] = await db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, answer.channelId));
  const [origin] = await db
    .select({ author: messages.authorMemberId })
    .from(messages)
    .where(eq(messages.id, answer.originMessageId));
  if (!here || !origin) return undefined;
  if (here.kind === "public") return "everyone";
  const people = await db
    .select({ id: channelParticipants.memberId })
    .from(channelParticipants)
    .innerJoin(members, eq(members.id, channelParticipants.memberId))
    .where(and(eq(channelParticipants.channelId, answer.channelId), isActive));
  return [...new Set([...people.map((p) => p.id), ...(origin.author ? [origin.author] : [])])];
}
