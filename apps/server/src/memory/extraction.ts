import { AGENT_MODELS } from "@shearim/contracts";
import { and, eq } from "drizzle-orm";
import { type ModelContext, recentMessages } from "../context";
import { type Db, schema } from "../db/client";

const { messages, channels, agents, memoryItems } = schema;

/**
 * A extração da Memória (ADR 0013): uma chamada curta, depois de entregue a resposta de um
 * Agente, que lê aquela troca e devolve o que vale guardar. Só guarda a partir do que uma pessoa
 * disse: a entrada leva as mensagens de pessoa da troca, a resposta do Agente como contexto e a
 * Memória da Conversa de agora, com os ids. Resultado de Ferramenta nunca entra (não fica em
 * `messages`), nem o texto de outros Agentes.
 */

/** O modelo pequeno da extração, se a Instalação não ajusta (`SHEARIM_MEMORY_MODEL`). */
export const DEFAULT_MEMORY_MODEL = "claude-haiku-5-5";

/** Quantas operações uma extração aplica, no máximo (o resto é descartado). */
export const MAX_OPERATIONS = 10;
/** O tamanho máximo do texto de um item (o que passa é cortado). */
export const MAX_ITEM_LENGTH = 500;

/**
 * O que a Instalação ajusta na Memória pelo `.env`: o modelo da extração (`SHEARIM_MEMORY_MODEL`,
 * um dos modelos aceitos). Valor inválido é erro (o servidor não sobe).
 */
export function memoryFromEnv(env: Record<string, string | undefined>): { model?: string } {
  const raw = env.SHEARIM_MEMORY_MODEL?.trim();
  if (!raw) return {};
  if (!(AGENT_MODELS as readonly string[]).includes(raw)) {
    throw new Error(`SHEARIM_MEMORY_MODEL=${raw} não é um modelo aceito (${AGENT_MODELS.join(", ")}).`);
  }
  return { model: raw };
}

/**
 * O JSON que a extração devolve (`output_config.format` pela Chave, `--json-schema` pela Conta).
 * Os dublês dos testes a reconhecem pela propriedade `operacoes`. Cada operação cria um item na
 * Memória da Conversa; a extração nunca escolhe a Memória do Workspace e nunca apaga.
 */
export const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    operacoes: {
      type: "array",
      description: "O que guardar na Memória. Vazia quando não há nada a guardar.",
      items: {
        type: "object",
        properties: {
          acao: { type: "string", enum: ["criar"], description: "criar: um item novo na Memória da Conversa." },
          texto: {
            type: "string",
            description: "Uma frase curta, em português do Brasil, que se entende sozinha fora da conversa.",
          },
        },
        required: ["acao", "texto"],
        additionalProperties: false,
      },
    },
  },
  required: ["operacoes"],
  additionalProperties: false,
} as const;

/** Uma operação já conferida. */
export type MemoryOperation = { action: "create"; text: string };

/**
 * Confere o JSON da extração. Operação que não se entende sai; passam até `MAX_OPERATIONS`.
 * Devolve `undefined` quando o JSON não é o pedido (falha visível, ADR 0003).
 */
export function parseOperations(text: string): MemoryOperation[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (raw as { operacoes?: unknown } | null)?.operacoes;
  if (!Array.isArray(list)) return undefined;
  const operations: MemoryOperation[] = [];
  for (const item of list as { acao?: unknown; texto?: unknown }[]) {
    const text = typeof item?.texto === "string" ? item.texto.trim().slice(0, MAX_ITEM_LENGTH) : "";
    if (item?.acao !== "criar" || !text) continue;
    operations.push({ action: "create", text });
    if (operations.length === MAX_OPERATIONS) break;
  }
  return operations;
}

const INSTRUCTIONS = [
  "Você é a extração da Memória do Shearim, um chat de time em que pessoas e Agentes conversam juntos.",
  "Um Agente acabou de responder numa conversa. Leia a troca e decida o que vale os Agentes lembrarem em respostas futuras nesta conversa: decisões, correções, fatos e pedidos de lembrar ou guardar algo.",
  "Regras:",
  "- Guarde só o que uma pessoa disse. A resposta do Agente vem como contexto: nunca guarde algo só porque o Agente disse.",
  "- Não guarde o que já está na Memória da Conversa.",
  "- Não guarde cumprimentos, perguntas, conversa fiada nem o que só vale para agora.",
  "- Cada item é uma frase curta, em português do Brasil, que se entende sozinha, fora da conversa.",
  "- Sem nada a guardar, devolva a lista de operações vazia. Na dúvida, não guarde.",
].join("\n");

/**
 * O pedido da extração da resposta `sourceExecutionId` (já entregue): as mensagens de pessoa da
 * troca (as mesmas recentes que a resposta leu, até a mensagem de origem), a resposta como
 * contexto e a Memória da Conversa ativa, com os ids. Sem resposta (não deveria acontecer), nada.
 */
export async function buildExtraction(db: Db, sourceExecutionId: string): Promise<ModelContext | undefined> {
  const [source] = await db
    .select({ e: schema.executions, reply: messages.body, agentName: agents.name })
    .from(schema.executions)
    .innerJoin(messages, eq(messages.id, schema.executions.replyMessageId))
    .innerJoin(agents, eq(agents.id, schema.executions.agentId))
    .where(eq(schema.executions.id, sourceExecutionId));
  if (!source) return undefined;
  const [origin] = await db.select().from(messages).where(eq(messages.id, source.e.originMessageId));
  const [conversation] = await db.select().from(channels).where(eq(channels.id, source.e.channelId));
  const recent = await recentMessages(db, origin!, conversation!.recentMessages);
  // O que outros Agentes disseram nunca é fonte: só as pessoas.
  const people = recent.filter((m) => m.agentId === null);
  const remembered = await db
    .select({ id: memoryItems.id, text: memoryItems.text })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.conversationId, conversation!.id),
        eq(memoryItems.scope, "conversation"),
        eq(memoryItems.state, "active"),
      ),
    )
    .orderBy(memoryItems.seq);

  return {
    system: INSTRUCTIONS,
    messages: [
      {
        role: "user",
        content: [
          "## Memória da Conversa",
          remembered.length ? remembered.map((m) => `- [${m.id}] ${m.text}`).join("\n") : "(vazia)",
          "## Mensagens de pessoa da troca, da mais antiga para a mais nova",
          people.map((m) => `${m.author} (pessoa): ${m.body}`).join("\n\n"),
          `## A resposta de ${source.agentName} (Agente), só como contexto`,
          source.reply,
        ].join("\n\n"),
      },
    ],
  };
}
