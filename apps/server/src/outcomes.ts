import type { OutcomeDto } from "@regents/contracts";
import { asc, eq, inArray, type SQL } from "drizzle-orm";
import { articuladoraOf } from "./articuladora";
import { type Db, schema } from "./db/client";
import type { Decision } from "./routing";

const { outcomes, agents, messages } = schema;

/** Grava o Desfecho que a Articuladora deu à mensagem. Um por mensagem. */
export async function recordOutcome(db: Db, origin: { id: string; channelId: string }, decided: Decision, at: Date) {
  await db.insert(outcomes).values({
    messageId: origin.id,
    channelId: origin.channelId,
    decision: decided.decision,
    reason: decided.reason,
    delegates: decided.delegates,
    decidedAt: at,
  });
  const [dto] = await selectOutcomes(db, eq(outcomes.messageId, origin.id));
  return dto!;
}

/** Os Desfechos de uma conversa, na ordem das mensagens. */
export function outcomesIn(db: Db, channelId: string) {
  return selectOutcomes(db, eq(outcomes.channelId, channelId));
}

/** O Desfecho de uma mensagem, se ela recebeu um. */
export async function outcomeOf(db: Db, messageId: string) {
  const [dto] = await selectOutcomes(db, eq(outcomes.messageId, messageId));
  return dto;
}

async function selectOutcomes(db: Db, where: SQL): Promise<OutcomeDto[]> {
  const rows = await db
    .select({ o: outcomes })
    .from(outcomes)
    .innerJoin(messages, eq(messages.id, outcomes.messageId))
    .where(where)
    .orderBy(asc(messages.seq));
  if (rows.length === 0) return [];
  const by = await articuladoraOf(db);
  const ids = [...new Set(rows.flatMap((r) => r.o.delegates.map((d) => d.agentId)))];
  const names = new Map(
    ids.length
      ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids))).map(
          (a) => [a.id, a.name] as const,
        )
      : [],
  );
  return rows.map(({ o }) => ({
    messageId: o.messageId,
    channelId: o.channelId,
    decision: o.decision,
    reason: o.reason,
    by: { id: by.id, displayName: by.name },
    delegates: o.delegates.map((d) => ({
      agent: { id: d.agentId, displayName: names.get(d.agentId) ?? "Agente" },
      cover: d.cover,
    })),
  }));
}
