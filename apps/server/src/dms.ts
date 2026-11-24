import type { DmDto, DmKind, OpenDmInput } from "@shearim/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type ConversationRow, isUuid } from "./conversations";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { Member } from "./members";
import { addParticipants, audienceOf, participantsOf } from "./participation";

type Env = { Variables: { member: Member } };
type Dm = ConversationRow & { kind: DmKind };

const { channels, channelParticipants, members } = schema;

const DM_KINDS: readonly DmKind[] = ["dm", "group"];

/** Numa DM, o N (mensagens recentes no contexto dos Agentes, #23) é fixo: o Admin só edita o de Canais. */
export const DM_RECENT_MESSAGES = 30;

/**
 * DMs: conversas sem nome, fora dos Canais, que só os participantes veem.
 * Ficam na mesma tabela dos Canais (o mesmo id serve para mensagens, participantes e eventos);
 * as mensagens vão por `/api/conversations/:id/messages`.
 */
export function dmRoutes(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
  const routes = new Hono<Env>();

  routes.get("/dms", async (c) => {
    const me = c.get("member");
    const mine = db
      .select({ id: channelParticipants.channelId })
      .from(channelParticipants)
      .where(eq(channelParticipants.memberId, me.id));
    const rows = (await db
      .select()
      .from(channels)
      .where(and(inArray(channels.kind, [...DM_KINDS]), inArray(channels.id, mine)))
      .orderBy(asc(channels.createdAt), asc(channels.id))) as Dm[];
    const participants = await participantsOf(
      db,
      rows.map((r) => r.id),
    );
    return c.json(rows.map((r) => dmDto(r, participants.get(r.id) ?? [])));
  });

  /** Abre a DM com essas pessoas ou devolve a que já existe com exatamente as mesmas. */
  routes.post("/dms", async (c) => {
    const me = c.get("member");
    const input = (await c.req.json().catch(() => null)) as Partial<OpenDmInput> | null;
    if (!Array.isArray(input?.memberIds) || !input.memberIds.every((id) => typeof id === "string")) {
      return c.json({ error: "invalid_input", message: "Escolha com quem conversar." }, 400);
    }
    const others = [...new Set(input.memberIds)].filter((id) => id !== me.id);
    if (others.length === 0) return c.json({ error: "invalid_input", message: "Escolha com quem conversar." }, 400);
    const found = others.every(isUuid)
      ? await db.select({ id: members.id }).from(members).where(inArray(members.id, others))
      : [];
    if (found.length !== others.length) {
      return c.json({ error: "invalid_input", message: "Alguém ali não é Membro do Workspace." }, 400);
    }

    const everyone = [me.id, ...others];
    const kind: DmKind = others.length === 1 ? "dm" : "group";
    const now = clock.now();
    const { dm, created } = await db.transaction(async (tx) => {
      // Serializa a abertura: duas aberturas simultâneas com as mesmas pessoas dão numa DM só.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shearim:dm-nova'))`);
      const existing = await findDmWith(tx, kind, me.id, everyone);
      if (existing) return { dm: existing, created: false };
      const [row] = await tx
        .insert(channels)
        .values({ id: crypto.randomUUID(), name: null, kind, recentMessages: DM_RECENT_MESSAGES, createdAt: now })
        .returning();
      await addParticipants(tx, row!.id, everyone, now);
      return { dm: row as Dm, created: true };
    });

    const dto = await toDmDto(db, dm);
    if (created) events.publish(await audienceOf(db, dm), { type: "dm.updated", dm: dto });
    return c.json(dto, created ? 201 : 200);
  });

  return routes;
}

/** A DM desse tipo cujos participantes são exatamente `everyone` (procurada entre as de `me`). */
async function findDmWith(db: Db, kind: DmKind, me: string, everyone: string[]): Promise<Dm | undefined> {
  const mine = db
    .select({ id: channelParticipants.channelId })
    .from(channelParticipants)
    .where(eq(channelParticipants.memberId, me));
  const [match] = await db
    .select({ id: channelParticipants.channelId })
    .from(channelParticipants)
    .innerJoin(channels, eq(channels.id, channelParticipants.channelId))
    .where(and(eq(channels.kind, kind), inArray(channelParticipants.channelId, mine)))
    .groupBy(channelParticipants.channelId)
    .having(sql`count(*) = ${everyone.length} and bool_and(${inArray(channelParticipants.memberId, everyone)})`);
  if (!match) return undefined;
  const [row] = await db.select().from(channels).where(eq(channels.id, match.id));
  return row as Dm;
}

function dmDto(dm: Dm, participants: DmDto["participants"]): DmDto {
  return { id: dm.id, kind: dm.kind, participants };
}

async function toDmDto(db: Db, dm: Dm) {
  return dmDto(dm, (await participantsOf(db, [dm.id])).get(dm.id) ?? []);
}
