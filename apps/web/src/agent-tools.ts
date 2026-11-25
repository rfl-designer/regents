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

/**
 * "acessa CRM com a credencial do Workspace": uma linha por Conector, e uma pelo GitHub com os
 * repositórios da lista do Agente (a mesma regra do servidor, `reachLines`).
 */
export function reachOf(
  tools: readonly AgentToolSummaryDto[],
  githubRepositories: readonly string[] | null = null,
): string[] {
  const names = new Set<string>();
  for (const t of tools) if (t.connector?.credential === "workspace") names.add(t.connector.name);
  const lines = [...names].map((name) => `acessa ${name} com a credencial do Workspace`);
  if (tools.some((t) => t.origin === "github")) lines.push(githubReachLine(githubRepositories));
  return lines;
}

function githubReachLine(repositories: readonly string[] | null) {
  const line = "acessa o GitHub com a credencial do Workspace";
  if (!repositories?.length) return line;
  if (repositories.length === 1) return `${line}, só no repositório ${repositories[0]}`;
  return `${line}, só nos repositórios ${repositories.slice(0, -1).join(", ")} e ${repositories.at(-1)}`;
}

/** O Agente depois de o Admin marcar ou desmarcar uma Ferramenta na tela dele. */
export function withGranted(agent: AgentDto, tools: readonly AgentToolDto[]): AgentDto {
  const granted = tools
    .filter((t) => t.granted)
    .map(({ id, title, origin, connector }) => ({ id, title, origin, ...(connector ? { connector } : {}) }));
  return { ...agent, tools: granted, reach: reachOf(granted, agent.githubRepositories ?? null) };
}

/** O Agente depois de o Admin trocar a lista de repositórios do GitHub dele. */
export function withGitHubRepositories(agent: AgentDto, repositories: string[] | null): AgentDto {
  return { ...agent, githubRepositories: repositories, reach: reachOf(agent.tools, repositories) };
}
