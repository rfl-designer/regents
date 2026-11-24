import type {
  AddParticipantInput,
  ChannelDto,
  ChannelSettingsDto,
  CreateChannelInput,
  MessageDto,
  SendMessageInput,
} from "@shearim/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { Member } from "./members";
import { mentionsOf, recordMentions } from "./mentions";
import { addParticipants, audienceOf, canSee, participantsOf } from "./participation";

type Env = { Variables: { member: Member } };
type Channel = typeof schema.channels.$inferSelect;

const { channels, messages, members } = schema;

const NAME_MAX = 80;

/**
 * Rotas de Canais e mensagens. Um Canal privado só existe para quem participa dele:
 * para os outros (Admin inclusive), ele não aparece na lista, responde 404 e não manda eventos.
 * Uma mensagem de pessoa é gravada antes de qualquer outra coisa.
 */
export function conversationRoutes(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
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
    const all = await db.select().from(channels).orderBy(asc(channels.createdAt), asc(channels.name));
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
      return channel!;
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

  routes.get("/channels/:id/messages", async (c) => {
    const channel = await findVisibleChannel(db, c.get("member"), c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
        authorId: members.id,
        authorName: members.displayName,
        authorPic: members.profilePicUrl,
      })
      .from(messages)
      .innerJoin(members, eq(members.id, messages.authorMemberId))
      .where(eq(messages.channelId, channel.id))
      .orderBy(asc(messages.seq));
    const mentions = await mentionsOf(
      db,
      rows.map((r) => r.id),
    );
    return c.json(
      rows.map(
        (r): MessageDto => ({
          id: r.id,
          channelId: r.channelId,
          body: r.body,
          author: { id: r.authorId, displayName: r.authorName, profilePicUrl: r.authorPic },
          mentions: mentions.get(r.id) ?? [],
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    );
  });

  routes.post("/channels/:id/messages", async (c) => {
    const channel = await findVisibleChannel(db, c.get("member"), c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as Partial<SendMessageInput> | null;
    if (typeof input?.body !== "string" || input.body.trim() === "") {
      return c.json({ error: "invalid_input", message: "A mensagem está vazia." }, 400);
    }
    const author = c.get("member");
    const values = {
      id: crypto.randomUUID(),
      channelId: channel.id,
      authorMemberId: author.id,
      body: input.body,
      createdAt: clock.now(),
    };
    // A mensagem e as Menções dela são gravadas juntas, antes de qualquer outra coisa.
    const mentions = await db.transaction(async (tx) => {
      await tx.insert(messages).values(values);
      return recordMentions(tx, values.id, channel, values.body);
    });
    // Escrever num Canal público é entrar nele.
    const joined = await addParticipants(db, channel.id, [author.id], values.createdAt);
    const dto: MessageDto = {
      id: values.id,
      channelId: values.channelId,
      body: values.body,
      author: { id: author.id, displayName: author.displayName, profilePicUrl: author.profilePicUrl },
      mentions,
      createdAt: values.createdAt.toISOString(),
    };
    events.publish(await audienceOf(db, channel), { type: "message.created", message: dto });
    if (joined) await publishChannel(channel);
    return c.json(dto, 201);
  });

  // ---------- Instruções do Canal e N: só o Admin, em qualquer Canal, sem as mensagens ----------

  routes.get("/channel-settings", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const all = await db.select().from(channels).orderBy(asc(channels.createdAt), asc(channels.name));
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
      ? await db.update(channels).set(change).where(eq(channels.id, channel.id)).returning()
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

async function findChannel(db: Db, id: string) {
  if (!UUID.test(id)) return undefined;
  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  return channel;
}

/** O Canal, se o Membro o vê. Um privado de que ele não participa é como um que não existe. */
async function findVisibleChannel(db: Db, member: Member, id: string) {
  const channel = await findChannel(db, id);
  return channel && (await canSee(db, member.id, channel)) ? channel : undefined;
}
