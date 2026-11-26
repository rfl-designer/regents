import { isChannelKind, joinPt } from "@regents/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";
import { isActive } from "../members";
import { canSee } from "../participation";
import { ToolFailure, type ToolRun, WRITE_NOTE, type WriteTool } from "./port";
import { reachOf } from "./reach";

const { channels, channelAgents, channelParticipants, members, messages } = schema;

/** Os motivos da falha da escrita. Nenhum diz o nome da conversa: ele pode estar fora do alcance. */
const OUT_OF_REACH = "a conversa não existe ou quem escreveu não pode escrever nela";
const AGENT_NOT_IN = "o Agente não participa dessa conversa";
const MESSAGE_MAX = 4000;

type Conversation = typeof channels.$inferSelect;

/**
 * O alcance da escrita (Spec #44): só conversas de que o Agente participa e em que o autor da
 * mensagem de origem pode escrever (é Membro e vê a conversa: num Canal público, todo Membro),
 * e nunca fora do alcance de leitura da resposta: o resumo do Pedido diz o nome da conversa a
 * todos que a veem, e de um Canal público ele não pode nomear um Canal privado.
 * Conferido ao criar o Pedido e de novo ao executá-lo.
 */
async function writableBy(db: Db, run: ToolRun, conversation: Conversation | undefined) {
  if (!conversation || !(await reachOf(db, run)).find(conversation.id)) throw new ToolFailure(OUT_OF_REACH);
  const [author] = await db
    .select({ id: members.id })
    .from(messages)
    .innerJoin(members, eq(members.id, messages.authorMemberId))
    .where(and(eq(messages.id, run.originMessageId), isActive));
  if (!author || !(await canSee(db, author.id, conversation))) throw new ToolFailure(OUT_OF_REACH);
  const [agent] = await db
    .select({ id: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, conversation.id), eq(channelAgents.agentId, run.agentId)));
  if (!agent) throw new ToolFailure(AGENT_NOT_IN);
  return conversation;
}

/** "#anuncios", ou "a DM com Ana e Bruno". */
async function labelOf(db: Db, conversation: Conversation) {
  if (isChannelKind(conversation.kind)) return `#${conversation.name}`;
  const people = await db
    .select({ name: members.displayName })
    .from(channelParticipants)
    .innerJoin(members, eq(members.id, channelParticipants.memberId))
    .where(eq(channelParticipants.channelId, conversation.id))
    .orderBy(asc(members.displayName));
  const names = people.map((p) => p.name);
  return `a DM com ${joinPt(names) || "ninguém"}`;
}

/** A conversa pelo nome do Canal ("#anuncios", sem diferença de maiúsculas) ou pelo id. */
async function findConversation(db: Db, ref: string) {
  const trimmed = ref.trim();
  if (isUuid(trimmed)) return (await db.select().from(channels).where(eq(channels.id, trimmed)))[0];
  const name = trimmed.replace(/^#+/, "").trim();
  if (!name) return undefined;
  return (await db.select().from(channels).where(sql`lower(${channels.name}) = lower(${name})`))[0];
}

function textOf(input: unknown) {
  const text = (input as { texto?: unknown } | null)?.texto;
  if (typeof text !== "string" || !text.trim()) throw new ToolFailure("o texto da mensagem está vazio");
  if (text.trim().length > MESSAGE_MAX) throw new ToolFailure(`o texto passa de ${MESSAGE_MAX} caracteres`);
  return text.trim();
}

/** A ação guardada no Pedido: a conversa, a Thread (ou nada) e o texto, exatamente. */
interface PostAction {
  conversationId: string;
  threadRootId: string | null;
  body: string;
}

function actionOf(raw: Record<string, unknown>): PostAction {
  return {
    conversationId: String(raw.conversationId),
    threadRootId: typeof raw.threadRootId === "string" ? raw.threadRootId : null,
    body: String(raw.body),
  };
}

/** Confere de novo o alcance (e a Thread) e posta como o Agente. */
const performPost: WriteTool["perform"] = async ({ db, run, post }, raw) => {
  const action = actionOf(raw);
  const [conversation] = await db.select().from(channels).where(eq(channels.id, action.conversationId));
  const target = await writableBy(db, run, conversation);
  if (action.threadRootId) {
    const [root] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.id, action.threadRootId), eq(messages.channelId, target.id), isNull(messages.threadRootId)),
      );
    if (!root) throw new ToolFailure("a mensagem da Thread não existe mais");
  }
  await post({ agentId: run.agentId, ...action });
  const where = await labelOf(db, target);
  return action.threadRootId ? `resposta postada na Thread em ${where}` : `mensagem postada em ${where}`;
};

/** Postar uma mensagem numa conversa, como o Agente. */
const postMessage: WriteTool = {
  id: "postar_mensagem",
  title: "postar mensagem",
  label: "preparando a mensagem",
  description: `Posta uma mensagem, como você, num Canal ou DM de que você participa. ${WRITE_NOTE}`,
  origin: "workspace",
  access: "write",
  inputSchema: {
    type: "object",
    properties: {
      conversa: { type: "string", description: "O Canal (ex. #anuncios) ou o id da conversa." },
      texto: { type: "string", description: "O texto exato da mensagem." },
    },
    required: ["conversa", "texto"],
    additionalProperties: false,
  },
  async prepare({ db, run }, input) {
    const ref = (input as { conversa?: unknown } | null)?.conversa;
    const body = textOf(input);
    const target = await writableBy(db, run, typeof ref === "string" ? await findConversation(db, ref) : undefined);
    return {
      action: { conversationId: target.id, threadRootId: null, body } satisfies PostAction,
      summary: `Postar em ${await labelOf(db, target)}: “${body}”`,
    };
  },
  perform: performPost,
};

/** Responder numa Thread, como o Agente: a Thread da mensagem indicada (ou a Thread em que ela está). */
const replyInThread: WriteTool = {
  id: "responder_thread",
  title: "responder em Thread",
  label: "preparando a resposta na Thread",
  description: `Responde, como você, na Thread de uma mensagem (pelo id dela) numa conversa de que você participa. ${WRITE_NOTE}`,
  origin: "workspace",
  access: "write",
  inputSchema: {
    type: "object",
    properties: {
      mensagem: { type: "string", description: "O id da mensagem que abre a Thread (ou de uma mensagem dela)." },
      texto: { type: "string", description: "O texto exato da resposta." },
    },
    required: ["mensagem", "texto"],
    additionalProperties: false,
  },
  async prepare({ db, run }, input) {
    const ref = (input as { mensagem?: unknown } | null)?.mensagem;
    const body = textOf(input);
    const [message] =
      typeof ref === "string" && isUuid(ref.trim())
        ? await db.select().from(messages).where(eq(messages.id, ref.trim()))
        : [];
    const [conversation] = message ? await db.select().from(channels).where(eq(channels.id, message.channelId)) : [];
    const target = await writableBy(db, run, conversation);
    const rootId = message!.threadRootId ?? message!.id;
    const [root] = await db
      .select({ body: messages.body, member: members.displayName, agent: schema.agents.name })
      .from(messages)
      .leftJoin(members, eq(members.id, messages.authorMemberId))
      .leftJoin(schema.agents, eq(schema.agents.id, messages.authorAgentId))
      .where(eq(messages.id, rootId));
    const opening = root!.body.length > 60 ? `${root!.body.slice(0, 60).trimEnd()}…` : root!.body;
    return {
      action: { conversationId: target.id, threadRootId: rootId, body } satisfies PostAction,
      summary: `Responder na Thread de ${root!.member ?? root!.agent ?? "alguém"} em ${await labelOf(db, target)} (“${opening}”): “${body}”`,
    };
  },
  perform: performPost,
};

/** As escritas do Workspace (Spec #44): postar mensagem e responder em Thread. */
export const WORKSPACE_WRITES: readonly WriteTool[] = [postMessage, replyInThread];
