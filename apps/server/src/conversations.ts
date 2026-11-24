import type { ChannelDto, MessageDto, SendMessageInput } from "@shearim/contracts";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Audience, EventHub } from "./events";
import type { Member } from "./members";

type Env = { Variables: { member: Member } };

const { channels, messages, members } = schema;

/** Rotas de Canais e mensagens. Uma mensagem de pessoa é gravada antes de qualquer outra coisa. */
export function conversationRoutes(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
  const routes = new Hono<Env>();

  routes.get("/channels", async (c) => {
    const rows = await db
      .select({ id: channels.id, name: channels.name, kind: channels.kind })
      .from(channels)
      .orderBy(asc(channels.createdAt), asc(channels.name));
    return c.json(rows satisfies ChannelDto[]);
  });

  routes.get("/channels/:id/messages", async (c) => {
    const channel = await findChannel(db, c.req.param("id"));
    if (!channel) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
        authorId: members.id,
        authorName: members.displayName,
      })
      .from(messages)
      .innerJoin(members, eq(members.id, messages.authorMemberId))
      .where(eq(messages.channelId, channel.id))
      .orderBy(asc(messages.seq));
    return c.json(
      rows.map(
        (r): MessageDto => ({
          id: r.id,
          channelId: r.channelId,
          body: r.body,
          author: { id: r.authorId, displayName: r.authorName },
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    );
  });

  routes.post("/channels/:id/messages", async (c) => {
    const channel = await findChannel(db, c.req.param("id"));
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
    await db.insert(messages).values(values);
    const dto: MessageDto = {
      id: values.id,
      channelId: values.channelId,
      body: values.body,
      author: { id: author.id, displayName: author.displayName },
      createdAt: values.createdAt.toISOString(),
    };
    events.publish(audienceOf(channel), { type: "message.created", message: dto });
    return c.json(dto, 201);
  });

  return routes;
}

/** Quem recebe os eventos de um Canal. Hoje só há Canal público, que todo Membro vê. */
function audienceOf(_channel: typeof channels.$inferSelect): Audience {
  return "everyone";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findChannel(db: Db, id: string) {
  if (!UUID.test(id)) return undefined;
  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  return channel;
}
