import type { AgentDto, AgentToolDto, AgentToolSummaryDto } from "@shearim/contracts";

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

/** "acessa CRM com a credencial do Workspace": uma linha por Conector (a mesma regra do servidor). */
export function reachOf(tools: readonly AgentToolSummaryDto[]): string[] {
  const names = new Set<string>();
  for (const t of tools) if (t.connector?.credential === "workspace") names.add(t.connector.name);
  return [...names].map((name) => `acessa ${name} com a credencial do Workspace`);
}

/** O Agente depois de o Admin marcar ou desmarcar uma Ferramenta na tela dele. */
export function withGranted(agent: AgentDto, tools: readonly AgentToolDto[]): AgentDto {
  const granted = tools
    .filter((t) => t.granted)
    .map(({ id, title, origin, connector }) => ({ id, title, origin, ...(connector ? { connector } : {}) }));
  return { ...agent, tools: granted, reach: reachOf(granted) };
}
