import type { Agent } from "../agents";

/**
 * A Memória do Agente está ligada (spec #60, #67; `agents.memory_enabled`, só o Admin muda e vem
 * ligada). É a única conferência de "desligar é desligar de verdade": desligada, a resposta dele não
 * põe extração na fila (`executions.ts`), não recebe o resumo (`context.ts`) e não ganha a
 * Ferramenta "buscar na Memória" (#69). Lida na linha do Agente de cada execução, na hora.
 */
export function remembers(agent: Pick<Agent, "memoryEnabled">): boolean {
  return agent.memoryEnabled;
}
