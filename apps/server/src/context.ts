import { eq } from "drizzle-orm";
import type { Agent } from "./agents";
import { type Db, schema } from "./db/client";
import type { ModelMessage } from "./model/port";

/** O que vai ao modelo numa execução. */
export interface ModelContext {
  system: string;
  messages: ModelMessage[];
}

/**
 * Montagem de contexto (Spec, módulo 5), na forma mínima do #20: um preâmbulo curto e as
 * instruções do Agente no `system`, e a mensagem de origem com o autor.
 *
 * SEAM do #21 (contexto completo): é aqui que entram o preâmbulo fixo, o Contexto do
 * Workspace, as Instruções do Canal, quem é quem e as últimas N mensagens. Lido na hora em
 * que a execução começa, nunca guardado.
 */
export async function buildContext(db: Db, agent: Agent, originMessageId: string): Promise<ModelContext> {
  const { messages, members } = schema;
  const [origin] = await db
    .select({ body: messages.body, author: members.displayName })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .where(eq(messages.id, originMessageId));
  const system = [
    `Você é ${agent.name}, um Agente num chat de time. Responda em português do Brasil.`,
    agent.instructions.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    system,
    messages: [{ role: "user", content: `${origin?.author ?? "Alguém"}: ${origin?.body ?? ""}` }],
  };
}
