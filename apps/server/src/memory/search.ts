import { and, desc, eq, ilike, or } from "drizzle-orm";
import { schema } from "../db/client";
import { type AutomaticTool, ToolFailure } from "../tools/port";
import { reachOf } from "../tools/reach";
import { likeEscape } from "../tools/workspace-read";
import { remembersNow } from "./enabled";
import { inReach } from "./items";

const { memoryItems } = schema;

/** Até quantos itens uma busca devolve. */
const SEARCH_LIMIT = 20;

/** O nome da Ferramenta, que o resumo cita quando um item entra só pelo título. */
export const SEARCH_MEMORY_TITLE = "buscar na Memória";

const SCOPE_NAME = { workspace: "Memória do Workspace", conversation: "Memória da Conversa", agent: "sua Memória" };

/**
 * Buscar na Memória (spec #60, #69; ADR 0012): por texto, nos itens ativos que a resposta alcança:
 *
 * - a Memória do Workspace, que todo Membro vê;
 * - a Memória da Conversa de cada conversa do alcance (`reachOf`, o mesmo das Ferramentas do
 *   Workspace: numa DM só com o autor, todas as conversas dele);
 * - a Memória do Agente que responde, com origem numa conversa do alcance.
 *
 * Vem sem concessão do Admin para todo Agente com a Memória ligada (`remembers`, relida do banco a
 * cada uso: o Admin pode desligá-la no meio da resposta). É só de leitura: sem Pedido de aprovação.
 */
export const SEARCH_MEMORY: AutomaticTool = {
  id: "buscar_na_memoria",
  title: SEARCH_MEMORY_TITLE,
  label: "buscando na Memória",
  description:
    "Busca por texto na Memória que esta resposta alcança: a do Workspace, a das conversas e a sua. Use para ler por inteiro o que entrou no resumo só pelo começo, ou para achar o que foi guardado em outra conversa. Devolve os itens mais recentes primeiro, cada um com o escopo e a conversa de origem.",
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: { texto: { type: "string", description: "O texto a buscar." } },
    required: ["texto"],
    additionalProperties: false,
  },
  presentFor: (db, run) => remembersNow(db, run.agentId),
  async run({ db, run }, raw) {
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const text = typeof args.texto === "string" ? args.texto.trim() : "";
    if (!text) throw new ToolFailure("diga o texto a buscar");
    const reach = await reachOf(db, run);
    const labels = new Map(reach.conversations.map((c) => [c.id, c.label]));
    const conversations = [...labels.keys()];
    // A Memória do Workspace vale em toda conversa; as outras, só com a origem no alcance.
    const scopes = [
      eq(memoryItems.scope, "workspace"),
      inReach(conversations, { scope: "conversation" }),
      inReach(conversations, { scope: "agent", agentId: run.agentId }),
    ];
    const found = await db
      .select({ scope: memoryItems.scope, conversationId: memoryItems.conversationId, text: memoryItems.text })
      .from(memoryItems)
      .where(and(eq(memoryItems.state, "active"), ilike(memoryItems.text, `%${likeEscape(text)}%`), or(...scopes)))
      .orderBy(desc(memoryItems.seq))
      .limit(SEARCH_LIMIT);
    if (found.length === 0) return "Nada na Memória com esse texto.";
    // A origem só é dita quando está no alcance (a do item promovido ao Workspace, um Canal público).
    const from = (id: string | null) => (id && labels.has(id) ? `, de ${labels.get(id)}` : "");
    return [
      `${found.length} ${found.length === 1 ? "item" : "itens"}, dos mais recentes para os mais antigos${found.length === SEARCH_LIMIT ? ` (só os ${SEARCH_LIMIT} mais recentes: refine a busca para ver outros)` : ""}:`,
      ...found.map((i) => `- (${SCOPE_NAME[i.scope]}${from(i.conversationId)}) ${i.text}`),
    ].join("\n");
  },
};
