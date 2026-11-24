import type {
  AddAgentInput,
  AddParticipantInput,
  ChannelDto,
  ChannelKind,
  ChannelSettingsDto,
  CreateChannelInput,
  MessageDto,
  SendMessageInput,
} from "@shearim/contracts";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { Executions } from "./executions";
import type { Member } from "./members";
import { mentionedAgents } from "./mentions";
import { listMessages as listConversationMessages } from "./messages";
import { addAgent, addParticipants, audienceOf, canSee, participantsOf } from "./participation";

type Env = { Variables: { member: Member } };
/** Uma linha de `channels`: um Canal ou uma DM. */
export type ConversationRow = typeof schema.channels.$inferSelect;
type Channel = ConversationRow & { kind: ChannelKind; name: string };

const CHANNEL_KINDS: readonly ChannelKind[] = ["public", "private"];
const isChannel = (row: ConversationRow): row is Channel => (CHANNEL_KINDS as readonly string[]).includes(row.kind);

const { channels, messages, members, agents } = schema;

const NAME_MAX = 80;

/**
 * Rotas de Canais e das mensagens de toda conversa (Canal ou DM). Uma conversa fechada (Canal
 * privado, DM) só existe para quem participa dela: para os outros (Admin inclusive), ela não
 * aparece na lista, responde 404 e não manda eventos. As DMs se abrem em `dms.ts`.
 * Uma mensagem de pessoa é gravada antes de qualquer outra coisa (inclusive das execuções
 * que as Menções dela disparam).
 */
export function conversationRoutes(deps: { db: Db; clock: Clock; events: EventHub; executions: Executions }) {
  const { db, clock, events, executions } = deps;
  const routes = new Hono<Env>();

  /** Avisa quem vê o Canal de como ele está agora. */
  async function publishChannel(channel: Channel) {
    events.publish(await audienceOf(db, channel), {
      type: "channel.updated",
      channel: await toChannelDto(db, channel),
    });
  }

  routes.get("/channels", async (c) => {
    const me = c.get("member");
    const all = (await db
      .select()
      .from(channels)
      .where(inArray(channels.kind, [...CHANNEL_KINDS]))
      .orderBy(asc(channels.createdAt), asc(channels.name))) as Channel[];
    const participants = await participantsOf(
      db,
      all.map((ch) => ch.id),
    );
    const visible = all.filter(
      (ch) => ch.kind === "public" || participants.get(ch.id)?.some((p) => p.kind === "member" && p.id === me.id),
    );
    return c.json(visible.map((ch) => channelDto(ch, participants.get(ch.id) ?? [])));
  });

  routes.post("/channels", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<CreateChannelInput> | null;
    const name = typeof input?.name === "string" ? input.name.trim().replace(/^#+/, "").trim() : "";
    if (!name) return c.json({ error: "invalid_input", message: "Dê um nome ao Canal." }, 400);
    if (name.length > NAME_MAX) {
      return c.json({ error: "invalid_input", message: `O nome do Canal tem no máximo ${NAME_MAX} caracteres.` }, 400);
    }
    if (input?.kind !== "public" && input?.kind !== "private") {
      return c.json({ error: "invalid_input", message: "O Canal é público ou privado." }, 400);
    }
    const kind = input.kind;
    const me = c.get("member");
    const now = clock.now();

    const created = await db.transaction(async (tx) => {
      // Serializa a criação para a checagem de nome (sem diferença de maiúsculas) valer.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shearim:canal-novo'))`);
      const [taken] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(sql`lower(${channels.name}) = lower(${name})`);
      if (taken) return undefined;
      const [channel] = await tx
        .insert(channels)
        .values({ id: crypto.randomUUID(), name, kind, createdAt: now })
        .returning();
      await addParticipants(tx, channel!.id, [me.id], now);
      return channel as Channel;
    });
    if (!created) return c.json({ error: "name_taken", message: `Já existe um Canal chamado #${name}.` }, 409);

    await publishChannel(created);
    return c.json(await toChannelDto(db, created), 201);
  });

  routes.get("/channels/:id", async (c) => {
    const channel = await findVisibleChannel(db, c.get("member"), c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    return c.json(await toChannelDto(db, channel));
  });

  /** Entrar num Canal público. Num privado só entra quem é adicionado (para os outros, 404). */
  routes.post("/channels/:id/join", async (c) => {
    const me = c.get("member");
    const channel = await findVisibleChannel(db, me, c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    if (await addParticipants(db, channel.id, [me.id], clock.now())) await publishChannel(channel);
    return c.json(await toChannelDto(db, channel));
  });

  /** Quem vê o Canal adiciona uma pessoa (num privado, só quem participa o vê). */
  routes.post("/channels/:id/participants", async (c) => {
    const channel = await findVisibleChannel(db, c.get("member"), c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as Partial<AddParticipantInput> | null;
    const memberId = typeof input?.memberId === "string" && UUID.test(input.memberId) ? input.memberId : undefined;
    const [person] = memberId ? await db.select({ id: members.id }).from(members).where(eq(members.id, memberId)) : [];
    if (!person) return c.json({ error: "invalid_input", message: "Essa pessoa não é Membro do Workspace." }, 400);

    if (await addParticipants(db, channel.id, [person.id], clock.now())) await publishChannel(channel);
    return c.json(await toChannelDto(db, channel));
  });

  /** Quem vê o Canal põe um Agente nele (é a quem a Articuladora pode delegar ali). */
  routes.post("/channels/:id/agents", async (c) => {
    const channel = await findVisibleChannel(db, c.get("member"), c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as Partial<AddAgentInput> | null;
    const agentId = typeof input?.agentId === "string" && UUID.test(input.agentId) ? input.agentId : undefined;
    const [agent] = agentId ? await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)) : [];
    if (!agent) return c.json({ error: "invalid_input", message: "Esse Agente não existe no Workspace." }, 400);

    if (await addAgent(db, channel.id, agent.id, clock.now())) await publishChannel(channel);
    return c.json(await toChannelDto(db, channel));
  });

  async function listMessages(c: Context<Env>, conversation: ConversationRow | undefined) {
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json(await listConversationMessages(db, conversation.id));
  }

  /** O Andamento do que ainda não virou resposta (na fila, escrevendo, falhou, não agem). */
  async function listExecutions(c: Context<Env>, conversation: ConversationRow | undefined) {
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json(await executions.openIn(conversation.id));
  }

  async function sendMessage(c: Context<Env>, conversation: ConversationRow | undefined) {
    if (!conversation) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as Partial<SendMessageInput> | null;
    if (typeof input?.body !== "string" || input.body.trim() === "") {
      return c.json({ error: "invalid_input", message: "A mensagem está vazia." }, 400);
    }
    const author = c.get("member");
    const values = {
      id: crypto.randomUUID(),
      channelId: conversation.id,
      authorMemberId: author.id,
      body: input.body,
      createdAt: clock.now(),
    };
    await db.insert(messages).values(values);
    // Escrever num Canal público é entrar nele (numa conversa fechada, quem escreve já participa).
    const joined =
      conversation.kind === "public" && (await addParticipants(db, conversation.id, [author.id], values.createdAt));
    const dto: MessageDto = {
      id: values.id,
      channelId: values.channelId,
      body: values.body,
      author: { kind: "member", id: author.id, displayName: author.displayName },
      originMessageId: null,
      createdAt: values.createdAt.toISOString(),
    };
    events.publish(await audienceOf(db, conversation), { type: "message.created", message: dto });
    if (joined && isChannel(conversation)) await publishChannel(conversation);
    // Só depois de gravada e anunciada, a mensagem dispara os Agentes mencionados.
    // Em DM, a Menção a Agentes é do #23: por enquanto, só nos Canais.
    if (isChannel(conversation)) await executions.enqueueMentions(dto, await mentionedAgents(db, dto.body));
    return c.json(dto, 201);
  }

  // Mensagens de qualquer conversa (Canal ou DM) pelo id dela; a rota de Canal aceita só Canais.
  const visibleConversation = (c: Context<Env>) => findVisibleConversation(db, c.get("member"), c.req.param("id")!);
  const visibleChannel = (c: Context<Env>) => findVisibleChannel(db, c.get("member"), c.req.param("id")!);
  routes.get("/conversations/:id/messages", async (c) => listMessages(c, await visibleConversation(c)));
  routes.post("/conversations/:id/messages", async (c) => sendMessage(c, await visibleConversation(c)));
  routes.get("/channels/:id/messages", async (c) => listMessages(c, await visibleChannel(c)));
  routes.post("/channels/:id/messages", async (c) => sendMessage(c, await visibleChannel(c)));
  routes.get("/conversations/:id/executions", async (c) => listExecutions(c, await visibleConversation(c)));
  routes.get("/channels/:id/executions", async (c) => listExecutions(c, await visibleChannel(c)));

  // ---------- Instruções do Canal e N: só o Admin, em qualquer Canal, sem as mensagens ----------

  routes.get("/channel-settings", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    // Só Canais: uma DM não tem Instruções, e o N dela é fixo em 30.
    const all = (await db
      .select()
      .from(channels)
      .where(inArray(channels.kind, [...CHANNEL_KINDS]))
      .orderBy(asc(channels.createdAt), asc(channels.name))) as Channel[];
    return c.json(all.map(settingsDto));
  });

  routes.patch("/channel-settings/:id", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const channel = await findChannel(db, c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const change: Partial<Pick<Channel, "instructions" | "recentMessages">> = {};
    if (input.instructions !== undefined) {
      if (typeof input.instructions !== "string") {
        return c.json({ error: "invalid_input", message: "As Instruções do Canal são um texto." }, 400);
      }
      change.instructions = input.instructions;
    }
    if (input.recentMessages !== undefined) {
      if (!Number.isInteger(input.recentMessages) || (input.recentMessages as number) < 0) {
        return c.json({ error: "invalid_input", message: "O N é um número inteiro, de 0 para cima." }, 400);
      }
      change.recentMessages = input.recentMessages as number;
    }
    const [updated] = Object.keys(change).length
      ? ((await db.update(channels).set(change).where(eq(channels.id, channel.id)).returning()) as Channel[])
      : [channel];
    // Quem participa vê as Instruções mudarem; o Admin de fora fica só com a resposta.
    if (updated !== channel) await publishChannel(updated!);
    return c.json(settingsDto(updated!));
  });

  return routes;
}

function settingsDto(channel: Channel): ChannelSettingsDto {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    instructions: channel.instructions,
    recentMessages: channel.recentMessages,
  };
}

function channelDto(channel: Channel, participants: ChannelDto["participants"]): ChannelDto {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    instructions: channel.instructions,
    recentMessages: channel.recentMessages,
    participants,
  };
}

async function toChannelDto(db: Db, channel: Channel) {
  return channelDto(channel, (await participantsOf(db, [channel.id])).get(channel.id) ?? []);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: string) {
  return UUID.test(id);
}

async function findConversation(db: Db, id: string): Promise<ConversationRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}

/** Um Canal (uma DM, pelas rotas de Canal, é como uma conversa que não existe). */
async function findChannel(db: Db, id: string) {
  const row = await findConversation(db, id);
  return row && isChannel(row) ? row : undefined;
}

/** A conversa, se o Membro a vê. Uma fechada de que ele não participa é como uma que não existe. */
async function findVisibleConversation(db: Db, member: Member, id: string) {
  const row = await findConversation(db, id);
  return row && (await canSee(db, member.id, row)) ? row : undefined;
}

async function findVisibleChannel(db: Db, member: Member, id: string) {
  const channel = await findChannel(db, id);
  return channel && (await canSee(db, member.id, channel)) ? channel : undefined;
}
