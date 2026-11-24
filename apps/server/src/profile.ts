import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import { type Env, type Member, memberById, toMeDto, toMemberDto } from "./members";
import { changeHandle, HANDLE_MAX, parseHandle } from "./mention-handles";

const NAME_MAX = 80;
const ABOUT_MAX = 500;

/** Sinal para desfazer a transação quando o identificador pedido já é de outro. */
class HandleTaken extends Error {}

/**
 * O perfil do próprio Membro (`/api/me`). O nome e a foto vêm da tailnet na primeira
 * entrada; depois o nome é do Membro, e a tailnet não o sobrescreve (o Membro é achado
 * pelo `UserProfile.ID`, e nada do `whois` é regravado depois da entrada).
 */
export function profileRoutes(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, events } = deps;
  const routes = new Hono<Env>();

  routes.get("/", (c) => c.json(toMeDto(c.get("member"))));

  routes.patch("/", async (c) => {
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const change: Partial<Pick<Member, "displayName" | "about">> = {};
    if (input.displayName !== undefined) {
      const name = typeof input.displayName === "string" ? input.displayName.trim() : "";
      if (!name) return c.json({ error: "invalid_input", message: "Dê um nome a você." }, 400);
      if (name.length > NAME_MAX) {
        return c.json({ error: "invalid_input", message: `O nome tem no máximo ${NAME_MAX} caracteres.` }, 400);
      }
      change.displayName = name;
    }
    if (input.about !== undefined) {
      if (typeof input.about !== "string") {
        return c.json({ error: "invalid_input", message: 'O "sobre mim" é um texto.' }, 400);
      }
      const about = input.about.trim();
      if (about.length > ABOUT_MAX) {
        return c.json({ error: "invalid_input", message: `O "sobre mim" tem no máximo ${ABOUT_MAX} caracteres.` }, 400);
      }
      change.about = about;
    }
    let handle: string | undefined;
    if (input.handle !== undefined) {
      handle = typeof input.handle === "string" ? parseHandle(input.handle) : undefined;
      if (!handle) {
        const message = `O identificador tem de 1 a ${HANDLE_MAX} letras, números ou _, sem espaço.`;
        return c.json({ error: "invalid_input", message }, 400);
      }
    }

    const me = c.get("member");
    const handleChanges = handle !== undefined && handle !== me.handle;
    if (Object.keys(change).length === 0 && !handleChanges) return c.json(toMeDto(me));
    let updated: Member;
    try {
      updated = await db.transaction(async (tx) => {
        if (handleChanges && !(await changeHandle(tx, { kind: "member", id: me.id }, handle!)).ok) {
          throw new HandleTaken();
        }
        if (Object.keys(change).length) await tx.update(schema.members).set(change).where(eq(schema.members.id, me.id));
        return (await memberById(tx, me.id))!;
      });
    } catch (err) {
      if (!(err instanceof HandleTaken)) throw err;
      return c.json({ error: "handle_taken", message: `@${handle} já é de outra pessoa ou Agente.` }, 409);
    }
    events.publish("everyone", { type: "member.updated", member: toMemberDto(updated) });
    return c.json(toMeDto(updated));
  });

  return routes;
}
