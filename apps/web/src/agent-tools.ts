import type { AgentDto } from "@shearim/contracts";

/**
 * O que um Agente sabe fazer, numa linha ao lado da descrição (toda lista de Agentes): para cada
 * Membro saber a quem pedir o quê. As Ferramentas (sem nenhuma, diz isso em vez de sumir), as
 * linhas de alcance da descrição pública ("acessa CRM com a credencial do Workspace") e as
 * Habilidades ativas, com o nome e quando usar (somem sem nenhuma).
 */
export function agentCapabilitiesText(agent: Pick<AgentDto, "tools"> & Partial<Pick<AgentDto, "reach" | "skills">>) {
  const tools = agent.tools ?? [];
  const text = tools.length ? `Ferramentas: ${tools.map((t) => t.title).join(", ")}` : "Sem Ferramentas";
  const skills = agent.skills ?? [];
  const skillsText = skills.length
    ? [`Habilidades: ${skills.map((s) => `${s.name} (${s.description})`).join("; ")}`]
    : [];
  return [text, ...(agent.reach ?? []), ...skillsText].join(" · ");
}
