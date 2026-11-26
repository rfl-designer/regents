import { and, desc, eq, type SQL } from "drizzle-orm";
import { type Db, schema } from "../db/client";
import { reachOf } from "../tools/reach";
import { inReach } from "./items";
import { SEARCH_MEMORY_TITLE } from "./search";

const { memoryItems } = schema;

/**
 * O resumo da Memória que entra em toda resposta de Agente (spec #60, #62): uma camada do
 * `system` depois das Instruções do Canal e antes de "quem é quem", com a precedência dita ao
 * modelo e um orçamento fixo da Instalação (`SHEARIM_MEMORY_SUMMARY_CHARS`).
 *
 * Entram, nesta ordem, cada uma num grupo: a Memória do Workspace (#66), a da Conversa atual
 * (com as Threads, o mesmo `channelId`) e a Memória do Agente que responde, das conversas de
 * origem dentro do alcance da resposta (`agentOrigins`, #68). A Memória da Conversa de outras
 * conversas nunca entra aqui (só pela busca).
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
  /**
   * Os itens que entraram por inteiro e que a extração pode substituir: a resposta os guarda, e a
   * extração dela os recebe. A Memória do Workspace entra no texto, mas não aqui: a extração nunca
   * guarda nela (só o Admin).
   */
  shown: SummaryItem[];
  /** Os que passaram do orçamento (os mais velhos): entram só pelo título (`titles`). */
  left: SummaryItem[];
}

const PRECEDENCE =
  "O que os Agentes guardaram de conversas anteriores. O Contexto do Workspace vale acima das Instruções do Canal, que valem acima das suas instruções e das suas Habilidades, que valem acima da Memória: quando se contradizem, siga o que vale mais.";

/**
 * As conversas de origem cuja Memória do Agente entra numa resposta (#68, ADR 0012): as do alcance
 * da resposta, o mesmo das Ferramentas do Workspace (`reachOf`), calculado na hora, com a
 * participação de agora. A extração recalcula o mesmo na hora em que roda (`extraction.ts`).
 */
export async function agentOrigins(
  db: Db,
  input: { conversationId: string; originMessageId: string },
): Promise<string[]> {
  const reach = await reachOf(db, { channelId: input.conversationId, originMessageId: input.originMessageId });
  return reach.conversations.map((c) => c.id);
}

/**
 * O resumo da Memória para uma resposta do Agente `agentId` à mensagem `originMessageId` da
 * conversa `conversationId`, dentro de `budget` caracteres: a Memória do Workspace, depois a da
 * Conversa (com as Threads), depois a do Agente, cada uma um grupo. Os grupos dividem o mesmo orçamento, na ordem: o primeiro item que
 * não cabe fecha o resumo, e ele e o resto (deste e dos grupos de depois) ficam em `left`.
 */
export async function memorySummary(
  db: Db,
  input: { conversationId: string; originMessageId: string; agentId: string; budget: number },
): Promise<MemorySummary> {
  const groups = [
    {
      title: "Memória do Workspace (vale em todo o Workspace), da mais antiga para a mais nova:",
      extractable: false,
      newestFirst: await activeNewestFirst(db, eq(memoryItems.scope, "workspace")),
    },
    {
      title: "Memória da Conversa (desta conversa e das Threads dela), da mais antiga para a mais nova:",
      extractable: true,
      newestFirst: await activeNewestFirst(
        db,
        and(eq(memoryItems.scope, "conversation"), eq(memoryItems.conversationId, input.conversationId)),
      ),
    },
    {
      title:
        "Memória do Agente (o seu jeito de trabalhar: lições e correções que as pessoas deram a você), da mais antiga para a mais nova:",
      extractable: true,
      newestFirst: await activeNewestFirst(
        db,
        inReach(await agentOrigins(db, input), { scope: "agent", agentId: input.agentId }),
      ),
    },
  ];
  const sections: string[] = [];
  const shown: SummaryItem[] = [];
  const left: SummaryItem[] = [];
  let budget = input.budget;
  for (const group of groups) {
    if (left.length) {
      left.push(...group.newestFirst);
      continue;
    }
    const fitted = fit(group.newestFirst, budget);
    budget -= fitted.used;
    left.push(...fitted.left);
    if (!fitted.shown.length) continue;
    if (group.extractable) shown.push(...fitted.shown);
    sections.push(group.title, fitted.shown.map(line).join("\n"));
  }
  sections.push(...titles(left));
  if (!sections.length) return { text: "", shown, left };
  return { text: ["## Memória", PRECEDENCE, ...sections].join("\n\n"), shown, left };
}

/** Os itens ativos que atendem a `where`, do mais novo para o mais velho. */
function activeNewestFirst(db: Db, where: SQL | undefined): Promise<SummaryItem[]> {
  return db
    .select({ id: memoryItems.id, text: memoryItems.text })
    .from(memoryItems)
    .where(and(where, eq(memoryItems.state, "active")))
    .orderBy(desc(memoryItems.seq));
}

const line = (item: SummaryItem) => `- ${item.text}`;

/** Até quantos caracteres do começo do texto um título tem. */
const TITLE_CHARS = 60;
/**
 * Até quantos títulos entram; os outros só pela contagem (a busca os acha). Os títulos ficam fora
 * do orçamento, e o bloco entra em toda resposta: sem teto, ele cresceria com a Memória sem limite.
 * 50 títulos de até `TITLE_CHARS` dão perto de 3.000 caracteres, da ordem de
 * `DEFAULT_SUMMARY_CHARS`: no pior caso, o resumo fica em torno do dobro do orçamento. O que passa
 * do teto não some calado ("e mais N itens").
 */
const MAX_TITLES = 50;

/**
 * O título de um item: o item não tem título próprio, então é o começo do texto, até
 * `TITLE_CHARS`, cortado no fim de uma palavra e com "…" quando o texto segue.
 */
export function titleOf(text: string): string {
  if (text.length <= TITLE_CHARS) return text;
  const cut = text.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * Os itens que não couberam no orçamento, só pelo título, na ordem em que ficaram de fora (o grupo
 * e, dentro dele, do mais novo para o mais velho). Fora do orçamento, até `MAX_TITLES`.
 */
function titles(left: SummaryItem[]): string[] {
  if (!left.length) return [];
  const listed = left.slice(0, MAX_TITLES).map((i) => `- ${titleOf(i.text)}`);
  const more = left.length - listed.length;
  if (more > 0) listed.push(`- e mais ${more} ${more === 1 ? "item" : "itens"}`);
  return [
    `Também na Memória, só pelo começo do texto (leia o resto com a Ferramenta ${SEARCH_MEMORY_TITLE}):`,
    listed.join("\n"),
  ];
}

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
