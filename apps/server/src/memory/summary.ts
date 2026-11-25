import { and, desc, eq } from "drizzle-orm";
import { type Db, schema } from "../db/client";

const { memoryItems } = schema;

/**
 * O resumo da Memória que entra em toda resposta de Agente (spec #60, #62): uma camada do
 * `system` depois das Instruções do Canal e antes de "quem é quem", com a precedência dita ao
 * modelo e um orçamento fixo da Instalação (`SHEARIM_MEMORY_SUMMARY_CHARS`).
 *
 * Hoje entra a Memória da Conversa atual (com as Threads, o mesmo `channelId`). A ordem prevista é
 * Workspace → Conversa → Agente, cada escopo um grupo de `memorySummary`; a Memória da Conversa de
 * outras conversas nunca entra aqui (só pela busca).
 */

/** O orçamento do resumo, em caracteres das linhas dos itens, se a Instalação não ajusta. */
export const DEFAULT_SUMMARY_CHARS = 4000;

export interface SummaryItem {
  id: string;
  text: string;
}

export interface MemorySummary {
  /** A seção pronta para o `system` (vazia quando não entra nenhum item). */
  text: string;
  /** Os itens que entraram por inteiro: a resposta os guarda, e a extração dela os recebe. */
  shown: SummaryItem[];
  /** Os que passaram do orçamento (os mais velhos): ficam de fora; o #69 os põe só pelo título. */
  left: SummaryItem[];
}

const PRECEDENCE =
  "O que os Agentes guardaram de conversas anteriores. O Contexto do Workspace, as Instruções do Canal e as suas instruções valem acima da Memória: quando se contradizem, siga-os.";

/** O resumo da Memória para uma resposta na conversa `conversationId`, dentro de `budget` caracteres. */
export async function memorySummary(db: Db, input: { conversationId: string; budget: number }): Promise<MemorySummary> {
  const newestFirst = await db
    .select({ id: memoryItems.id, text: memoryItems.text })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.scope, "conversation"),
        eq(memoryItems.conversationId, input.conversationId),
        eq(memoryItems.state, "active"),
      ),
    )
    .orderBy(desc(memoryItems.seq));
  const { shown, left } = fit(newestFirst, input.budget);
  if (!shown.length) return { text: "", shown, left };
  const text = [
    "## Memória",
    PRECEDENCE,
    "Memória da Conversa (desta conversa e das Threads dela), da mais antiga para a mais nova:",
    shown.map(line).join("\n"),
  ].join("\n\n");
  return { text, shown, left };
}

const line = (item: SummaryItem) => `- ${item.text}`;

/**
 * Os mais recentes que cabem no orçamento, em ordem de gravação; o primeiro que não cabe fecha o
 * resumo (um mais velho e curto não passa na frente), e ele e os mais velhos ficam em `left`.
 */
function fit(newestFirst: SummaryItem[], budget: number) {
  let used = 0;
  let count = 0;
  for (const item of newestFirst) {
    const cost = line(item).length + 1;
    if (used + cost > budget) break;
    used += cost;
    count++;
  }
  return { shown: newestFirst.slice(0, count).reverse(), left: newestFirst.slice(count) };
}
