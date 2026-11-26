import type { AgentDto } from "@regents/contracts";

/**
 * O que um Agente sabe fazer, numa linha ao lado da descrição (toda lista de Agentes): para cada
 * Membro saber a quem pedir o quê. As Ferramentas (sem nenhuma, diz isso em vez de sumir), as
 * linhas de alcance da descrição pública ("acessa CRM com a credencial do Workspace"), as
 * Habilidades ativas, com o nome e quando usar, e as Wikis ligadas que quem olha lê, com o nome e do
 * que tratam (as duas somem sem nenhuma; o servidor já tirou a Wiki fora do alcance de quem pede).
 */
export function agentCapabilitiesText(
  agent: Pick<AgentDto, "tools"> & Partial<Pick<AgentDto, "reach" | "skills" | "wikis">>,
) {
  const tools = agent.tools ?? [];
  const text = tools.length ? `Ferramentas: ${tools.map((t) => t.title).join(", ")}` : "Sem Ferramentas";
  return [text, ...(agent.reach ?? []), ...named("Habilidades", agent.skills), ...named("Wikis", agent.wikis)].join(
    " · ",
  );
}

function named(label: string, items: readonly { name: string; description: string }[] = []) {
  return items.length ? [`${label}: ${items.map((i) => `${i.name} (${i.description})`).join("; ")}`] : [];
}
