import { MEMBER_REMOVED_CLOSE_CODE, type MemberRole, type UpdateMemberRoleInput } from "@shearim/contracts";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { createAccounts } from "./accounts";
import type { Clock } from "./clock";
import { type Channel, toChannelDto } from "./conversations";
import { type Db, isUuid, schema, type Tx } from "./db/client";
import { type Dm, toDmDto } from "./dms";
import type { EventHub } from "./events";
import type { Executions } from "./executions";
import { type Env, isActiveAdmin, memberById, toMemberDto } from "./members";
import { audienceOf } from "./participation";
import type { Push } from "./push";
import { forgetMemberCredentials } from "./tools/connectors";
import { leaveWikiLists } from "./wiki/reach";

const { members, channels, channelParticipants, threadFollows } = schema;

const ROLES: readonly MemberRole[] = ["admin", "member"];

/** O motivo à vista de todos, nas execuções de quem foi removido ("Faro não respondeu: …"). */
export const REMOVED_REASON = "quem escreveu saiu do Workspace";

export const LAST_ADMIN_MESSAGE = "O Workspace precisa de pelo menos um Admin. Torne outro Membro Admin antes.";

/**
 * O Admin gerencia os Membros (Spec, módulo 2): torna Admin, rebaixa e remove.
 * O Workspace sempre tem pelo menos um Admin: toda mudança de papel passa por `lockAdmins`,
 * que serializa as decisões (dois Admins rebaixando um ao outro ao mesmo tempo não zeram os Admins).
 */
export function memberAdminRoutes(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  executions: Pick<Executions, "cancelAuthoredBy">;
  accounts: Pick<ReturnType<typeof createAccounts>, "cancel" | "unlink">;
  push: Pick<Push, "forget">;
}) {
  const { db, clock, events, executions, accounts, push } = deps;
  const routes = new Hono<Env>();

  routes.use("/members/:id", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.patch("/members/:id", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<UpdateMemberRoleInput> | null;
    const role = input?.role;
    if (!role || !ROLES.includes(role)) {
      return c.json({ error: "invalid_input", message: "O papel é Admin ou Membro." }, 400);
    }
    const id = c.req.param("id");
    const result = await db.transaction(async (tx) => {
      const check = await lockAdmins(tx, c.get("member").id, id);
      if (check.kind !== "ok") return check;
      if (check.target.role === role) return { kind: "unchanged" as const, member: check.target };
      if (role === "member" && check.admins <= 1) return { kind: "last_admin" as const };
      await tx.update(members).set({ role }).where(eq(members.id, id));
      return { kind: "changed" as const, member: (await memberById(tx, id))! };
    });
    if (result.kind === "not_admin") return c.json({ error: "not_admin" }, 403);
    if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.kind === "last_admin") return c.json({ error: "last_admin", message: LAST_ADMIN_MESSAGE }, 409);
    const dto = toMemberDto(result.member);
    if (result.kind === "changed") events.publish("everyone", { type: "member.updated", member: dto });
    return c.json(dto);
  });

  /**
   * Remove o Membro: ele "saiu do Workspace". A linha fica (as mensagens continuam dele, com a
   * marca), e quem volta pelo Pedido de entrada é o mesmo Membro. Ninguém remove a si mesmo.
   */
  routes.delete("/members/:id", async (c) => {
    const me = c.get("member");
    const id = c.req.param("id");
    if (id === me.id) {
      return c.json(
        { error: "cannot_remove_self", message: "Ninguém sai do Workspace sozinho: outro Admin remove." },
        409,
      );
    }
    const result = await db.transaction(async (tx) => {
      const check = await lockAdmins(tx, me.id, id);
      if (check.kind !== "ok") return check;
      if (check.target.role === "admin" && check.admins <= 1) return { kind: "last_admin" as const };
      // Quem volta, volta como Membro comum.
      await tx.update(members).set({ leftAt: clock.now(), role: "member" }).where(eq(members.id, id));
      // As credenciais dele nos Conectores vão junto: quem volta liga de novo.
      await forgetMemberCredentials(tx, id);
      // E sai das listas das Wikis restritas: quem volta, volta fora delas.
      await leaveWikiLists(tx, id);
      return { kind: "removed" as const, left: await leaveClosedConversations(tx, id) };
    });
    if (result.kind === "not_admin") return c.json({ error: "not_admin" }, 403);
    if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.kind === "last_admin") return c.json({ error: "last_admin", message: LAST_ADMIN_MESSAGE }, 409);

    // Daqui em diante o HTTP já o recusa; os aparelhos dele param de receber push, e as conexões
    // abertas recebem o aviso e fecham.
    await push.forget(id);
    events.publish("everyone", { type: "member.removed", memberId: id });
    events.disconnect(id, MEMBER_REMOVED_CLOSE_CODE, "removido do Workspace");
    // Quem fica nas conversas de que ele saiu vê a troca.
    for (const conversation of result.left) {
      const to = await audienceOf(db, conversation);
      if (conversation.kind === "private") {
        events.publish(to, { type: "channel.updated", channel: await toChannelDto(db, conversation as Channel) });
      } else {
        events.publish(to, { type: "dm.updated", dm: await toDmDto(db, conversation as Dm) });
      }
    }
    // Nada do que ele pediu fica no limbo: o que estava aberto aparece cancelado, com o motivo.
    await executions.cancelAuthoredBy(id, REMOVED_REASON);
    // A Conta dele é desligada (`claude auth logout` e a pasta apagada), e uma ligação pela metade, encerrada.
    await accounts.cancel(id);
    await accounts.unlink(id);
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Tira o Membro dos Canais privados e das DMs em grupo, e das Threads seguidas neles: quem volta
 * não herda esses acessos.
 * Continua nos Canais públicos e nas DMs a dois (`dm`), que são o histórico dele.
 * Devolve as conversas de que ele saiu.
 */
async function leaveClosedConversations(tx: Tx, memberId: string) {
  const closed = await tx
    .select({ conversation: channels })
    .from(channelParticipants)
    .innerJoin(channels, eq(channels.id, channelParticipants.channelId))
    .where(and(eq(channelParticipants.memberId, memberId), inArray(channels.kind, ["private", "group"])));
  if (closed.length === 0) return [];
  const ids = closed.map((r) => r.conversation.id);
  await tx
    .delete(channelParticipants)
    .where(and(eq(channelParticipants.memberId, memberId), inArray(channelParticipants.channelId, ids)));
  // As Threads que ele seguia ali também ficam para trás (quem volta não é avisado delas).
  await tx
    .delete(threadFollows)
    .where(and(eq(threadFollows.memberId, memberId), inArray(threadFollows.conversationId, ids)));
  return closed.map((r) => r.conversation);
}

/**
 * Trava as decisões sobre papéis e confere, dentro da trava, que quem decide ainda é Admin
 * e que o alvo é Membro. Devolve quantos Admins há agora.
 */
async function lockAdmins(tx: Tx, actorId: string, targetId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shearim:admins'))`);
  const actor = await memberById(tx, actorId);
  if (!actor || actor.leftAt || actor.role !== "admin") return { kind: "not_admin" as const };
  const target = isUuid(targetId) ? await memberById(tx, targetId) : undefined;
  if (!target || target.leftAt) return { kind: "not_found" as const };
  const [row] = await tx.select({ n: count() }).from(members).where(isActiveAdmin);
  return { kind: "ok" as const, target, admins: row?.n ?? 0 };
}
