import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { type Db, schema } from "../db/client";

const { memoryItems } = schema;

/**
 * O resumo da Memória que entra em toda resposta de Agente (spec #60, #62): uma camada do
 * `system` depois das Instruções do Canal e antes de "quem é quem", com a precedência dita ao
 * modelo e um orçamento fixo da Instalação (`SHEARIM_MEMORY_SUMMARY_CHARS`).
 *
 * Entram, nesta ordem, cada uma num grupo: a Memória da Conversa atual (com as Threads, o mesmo
 * `channelId`) e a Memória do Agente que responde, das conversas de origem que ele alcança
 * (`agentOrigins`). A Memória do Workspace (#66) entra antes das duas. A Memória da Conversa de
 * outras conversas nunca entra aqui (só pela busca). O orçamento é um só, gasto na ordem dos grupos.
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

/**
 * As conversas de origem cuja Memória do Agente entra numa resposta na conversa `conversationId`.
 * Por ora, só ela mesma (#65). O #68 troca isto pelo alcance da resposta (ADR 0012), o mesmo das
 * Ferramentas do Workspace: `reachOf(db, { channelId, originMessageId }).conversations` (de
 * `tools/reach.ts`), calculado na hora.
 */
function agentOrigins(input: { conversationId: string }): string[] {
  return [input.conversationId];
}

/**
 * O resumo da Memória para uma resposta do Agente `agentId` na conversa `conversationId`, dentro de
 * `budget` caracteres.
 */
export async function memorySummary(
  db: Db,
  input: { conversationId: string; agentId: string; budget: number },
): Promise<MemorySummary> {
  const groups = [
    {
      title: "Memória da Conversa (desta conversa e das Threads dela), da mais antiga para a mais nova:",
      where: and(eq(memoryItems.scope, "conversation"), eq(memoryItems.conversationId, input.conversationId)),
    },
    {
      title:
        "Memória do Agente (o seu jeito de trabalhar: lições e correções que as pessoas deram a você), da mais antiga para a mais nova:",
      where: and(
        eq(memoryItems.scope, "agent"),
        eq(memoryItems.agentId, input.agentId),
        inArray(memoryItems.conversationId, agentOrigins(input)),
      ),
    },
  ];
  let budget = input.budget;
  const parts: string[] = [];
  const shown: SummaryItem[] = [];
  const left: SummaryItem[] = [];
  for (const group of groups) {
    const fitted = fit(await active(db, group.where), budget);
    budget -= fitted.used;
    left.push(...fitted.left);
    if (!fitted.shown.length) continue;
    shown.push(...fitted.shown);
    parts.push(group.title, fitted.shown.map(line).join("\n"));
  }
  if (!shown.length) return { text: "", shown, left };
  return { text: ["## Memória", PRECEDENCE, ...parts].join("\n\n"), shown, left };
}

/** Os itens ativos que atendem a `where`, do mais novo para o mais velho. */
function active(db: Db, where: SQL | undefined): Promise<SummaryItem[]> {
  return db
    .select({ id: memoryItems.id, text: memoryItems.text })
    .from(memoryItems)
    .where(and(where, eq(memoryItems.state, "active")))
    .orderBy(desc(memoryItems.seq));
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
  return { shown: newestFirst.slice(0, count).reverse(), left: newestFirst.slice(count), used };
}
