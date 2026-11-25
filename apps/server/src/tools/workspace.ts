import { asc, desc, eq } from "drizzle-orm";
import { withBuiltinText } from "../articuladora";
import { schema } from "../db/client";
import type { ToolDefinition } from "./port";
import { WEB_TOOLS } from "./web";
import { WORKSPACE_READ_TOOLS } from "./workspace-read";
import { WORKSPACE_WRITES } from "./workspace-writes";

const { agents, agentTools, connectors, connectorTools, mentionHandles } = schema;

/**
 * Listar Agentes: todo Membro vê os Agentes do Workspace (`GET /api/agents`), então não há alcance
 * a cortar. Cada um com o identificador, a descrição e as Ferramentas, para o Agente indicar quem
 * atende cada coisa.
 */
const listAgents: ToolDefinition = {
  id: "listar_agentes",
  title: "listar Agentes",
  label: "listando os Agentes",
  description:
    "Lista os Agentes do Workspace, com o identificador de Menção, a descrição e as Ferramentas de cada um. Use para indicar quem atende cada coisa.",
  origin: "workspace",
  access: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run({ db }) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        builtin: agents.builtin,
        description: agents.description,
        handle: mentionHandles.handle,
      })
      .from(agents)
      .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
      .orderBy(desc(agents.builtin), asc(agents.createdAt), asc(agents.name));
    const grants = await db.select().from(agentTools);
    const titles = new Map([...WORKSPACE_TOOLS, ...WEB_TOOLS].map((t) => [t.id, t.title]));
    // As dos Conectores, com o Conector: a linha de alcance da descrição pública sai delas.
    const fromConnectors = await db
      .select({ tool: connectorTools.tool, title: connectorTools.title, connector: connectors.name })
      .from(connectorTools)
      .innerJoin(connectors, eq(connectors.id, connectorTools.connectorId));
    for (const c of fromConnectors) titles.set(c.tool, c.title);
    const connectorOf = new Map(fromConnectors.map((c) => [c.tool, c.connector]));
    return rows
      .map((row) => {
        const a = withBuiltinText({ ...row, instructions: "" });
        const mine = grants.filter((g) => g.agentId === a.id);
        const tools = mine.flatMap((g) => titles.get(g.tool) ?? []);
        const reach = [...new Set(mine.flatMap((g) => connectorOf.get(g.tool) ?? []))].map(
          (name) => ` Acessa ${name} com a credencial do Workspace.`,
        );
        return [
          `- ${a.name} (@${a.handle})${a.builtin ? ", a Articuladora" : ""}: ${a.description || "sem descrição"}${reach.join("")}`,
          `  Ferramentas: ${tools.length ? tools.join(", ") : "nenhuma"}`,
        ].join("\n");
      })
      .join("\n");
  },
};

/** As Ferramentas do Workspace (Spec #44), na ordem em que o Admin as vê. */
export const WORKSPACE_TOOLS: readonly ToolDefinition[] = [...WORKSPACE_READ_TOOLS, listAgents, ...WORKSPACE_WRITES];
