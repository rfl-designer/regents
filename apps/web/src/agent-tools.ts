import type { AgentDto } from "@shearim/contracts";

/**
 * As Ferramentas de um Agente numa linha, ao lado da descrição (toda lista de Agentes): para cada
 * Membro saber a quem pedir o quê. Sem nenhuma, diz isso em vez de sumir. As linhas de alcance da
 * descrição pública ("acessa CRM com a credencial do Workspace") vêm junto.
 */
export function agentToolsText(agent: Pick<AgentDto, "tools"> & Partial<Pick<AgentDto, "reach">>) {
  const tools = agent.tools ?? [];
  const text = tools.length ? `Ferramentas: ${tools.map((t) => t.title).join(", ")}` : "Sem Ferramentas";
  return [text, ...(agent.reach ?? [])].join(" · ");
}
