import type { AgentDto } from "@shearim/contracts";

/**
 * As Ferramentas de um Agente numa linha, ao lado da descrição (toda lista de Agentes): para cada
 * Membro saber a quem pedir o quê. Sem nenhuma, diz isso em vez de sumir.
 */
export function agentToolsText(agent: Pick<AgentDto, "tools">) {
  const tools = agent.tools ?? [];
  return tools.length ? `Ferramentas: ${tools.map((t) => t.title).join(", ")}` : "Sem Ferramentas";
}
