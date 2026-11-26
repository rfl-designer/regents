import { eq } from "drizzle-orm";
import type { Agent } from "../agents";
import { type Db, schema } from "../db/client";

/**
 * A Memória do Agente está ligada (spec #60, #67; `agents.memory_enabled`, só o Admin muda e vem
 * ligada). É a única conferência de "desligar é desligar de verdade": desligada, a resposta dele não
 * põe extração na fila (`executions.ts`), não recebe o resumo (`context.ts`) e não ganha a
 * Ferramenta "buscar na Memória" (#69). Lida na linha do Agente de cada execução, na hora.
 */
export function remembers(agent: Pick<Agent, "memoryEnabled">): boolean {
  return agent.memoryEnabled;
}

/**
 * `remembers` relido do banco agora, para o Agente `agentId` (inexistente: não). Para
 * quem decide no meio do caminho (a extração que já estava na fila, a Ferramenta "buscar na
 * Memória"): a linha do Agente que se tem na mão pode ser de antes de o Admin mudar.
 */
export async function remembersNow(db: Db, agentId: string): Promise<boolean> {
  const { agents } = schema;
  const [agent] = await db.select({ memoryEnabled: agents.memoryEnabled }).from(agents).where(eq(agents.id, agentId));
  return Boolean(agent && remembers(agent));
}
