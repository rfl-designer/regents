import type { ApproveJoinRequestDto, JoinRequestAdminDto, JoinRequestDto, MyJoinRequestDto } from "@shearim/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Audience, EventHub } from "./events";
import type { Identity } from "./identity/port";
import { type Member, toMeDto } from "./members";

export type TailnetUser = Extract<Identity, { kind: "user" }>;
type JoinRequest = typeof schema.joinRequests.$inferSelect;

const { joinRequests, members } = schema;

/**
 * Ganchos para quem reage a Pedidos de entrada fora do HTTP e do WebSocket.
 * `joinRequestCreated` roda depois de gravar um pedido novo (não quando a pessoa repete
 * o pedido que já espera). É o ponto onde o push aos Admins (#34) se pendura.
 */
export interface JoinRequestHooks {
  joinRequestCreated?(request: JoinRequestAdminDto): void;
}

export interface JoinRequestDeps {
  db: Db;
  clock: Clock;
  events: EventHub;
  hooks?: JoinRequestHooks;
}

/**
 * Rotas de quem pede para entrar (`/api/join-request`). Respondem a qualquer identidade
 * da tailnet, Membro ou não: é por aqui que quem ainda não é Membro vê o próprio pedido.
 */
export function myJoinRequestRoutes(deps: JoinRequestDeps) {
  const { db, clock, events, hooks } = deps;
  const routes = new Hono<{ Variables: { who: TailnetUser; member?: Member } }>();

  routes.get("/", async (c) => {
    const who = c.get("who");
    const latest = await latestOf(db, who.userId);
    return c.json({
      you: { login: who.login, displayName: who.displayName },
      joinRequest: latest ? toDto(latest) : null,
    } satisfies MyJoinRequestDto);
  });

  routes.post("/", async (c) => {
    if (c.get("member")) return c.json({ error: "already_member" }, 409);
    const who = c.get("who");
    const [created] = await db
      .insert(joinRequests)
      .values({
        id: crypto.randomUUID(),
        tailnetUserId: who.userId,
        login: who.login,
        displayName: who.displayName,
        profilePicUrl: who.profilePicUrl ?? null,
        device: who.device ?? null,
        sharee: who.sharee,
        status: "pending",
        createdAt: clock.now(),
      })
      // Um pedido esperando por pessoa: pedir de novo enquanto espera devolve o mesmo.
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [pending] = await db
        .select()
        .from(joinRequests)
        .where(and(eq(joinRequests.tailnetUserId, who.userId), eq(joinRequests.status, "pending")));
      return c.json(toDto(pending!), 200);
    }
    const [dto] = await toAdminDtos(db, [created]);
    events.publish(await adminAudience(db), { type: "join_request.created", joinRequest: dto! });
    try {
      hooks?.joinRequestCreated?.(dto!);
    } catch (err) {
      // O pedido já está gravado e o Admin o vê na lista; uma falha do aviso não o desfaz.
      console.error("shearim: o gancho joinRequestCreated falhou", err);
    }
    return c.json(toDto(created), 201);
  });

  return routes;
}

/**
 * Rotas do Admin (`/api/join-requests`): ver os pedidos que esperam, aprovar e recusar.
 * Montadas depois do portão de Membro; aqui só se confere o papel.
 */
export function joinRequestAdminRoutes(deps: JoinRequestDeps) {
  const { db, clock, events } = deps;
  const routes = new Hono<{ Variables: { member: Member } }>();

  routes.use("*", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.get("/", async (c) => {
    const pending = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.status, "pending"))
      .orderBy(asc(joinRequests.createdAt));
    return c.json(await toAdminDtos(db, pending));
  });

  routes.post("/:id/approve", async (c) => {
    const admin = c.get("member");
    const result = await db.transaction(async (tx) => {
      const request = await pendingForUpdate(tx, c.req.param("id"));
      if (request.kind !== "pending") return request;
      const now = clock.now();
      const [member] = await tx
        .insert(members)
        .values({
          id: crypto.randomUUID(),
          tailnetUserId: request.row.tailnetUserId,
          login: request.row.login,
          displayName: request.row.displayName,
          role: "member",
          createdAt: now,
        })
        .returning();
      const [decided] = await tx
        .update(joinRequests)
        .set({ status: "approved", decidedAt: now, decidedByMemberId: admin.id })
        .where(eq(joinRequests.id, request.row.id))
        .returning();
      return { kind: "decided" as const, row: decided!, member: member! };
    });
    if (result.kind !== "decided") return refusal(c, result);
    const [dto] = await toAdminDtos(db, [result.row]);
    events.publish(await adminAudience(db), { type: "join_request.decided", joinRequest: dto! });
    return c.json({ joinRequest: dto!, member: toMeDto(result.member) } satisfies ApproveJoinRequestDto);
  });

  routes.post("/:id/refuse", async (c) => {
    const admin = c.get("member");
    const result = await db.transaction(async (tx) => {
      const request = await pendingForUpdate(tx, c.req.param("id"));
      if (request.kind !== "pending") return request;
      const [decided] = await tx
        .update(joinRequests)
        .set({ status: "refused", decidedAt: clock.now(), decidedByMemberId: admin.id })
        .where(eq(joinRequests.id, request.row.id))
        .returning();
      return { kind: "decided" as const, row: decided! };
    });
    if (result.kind !== "decided") return refusal(c, result);
    const [dto] = await toAdminDtos(db, [result.row]);
    events.publish(await adminAudience(db), { type: "join_request.decided", joinRequest: dto! });
    return c.json(dto!);
  });

  return routes;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Pending =
  | { kind: "pending"; row: JoinRequest }
  | { kind: "not_found" }
  | { kind: "already_decided"; row: JoinRequest };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trava o pedido para decidir: dois Admins clicando juntos não decidem duas vezes. */
async function pendingForUpdate(tx: Tx, id: string): Promise<Pending> {
  if (!UUID.test(id)) return { kind: "not_found" };
  const [row] = await tx.select().from(joinRequests).where(eq(joinRequests.id, id)).for("update");
  if (!row) return { kind: "not_found" };
  return row.status === "pending" ? { kind: "pending", row } : { kind: "already_decided", row };
}

function refusal(
  c: { json: (body: unknown, status: 404 | 409) => Response },
  r: Exclude<Pending, { kind: "pending" }>,
) {
  if (r.kind === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json({ error: "already_decided", status: r.row.status }, 409);
}

/** O que o Admin vê de cada pedido, com o histórico de recusa da mesma pessoa. */
async function toAdminDtos(db: Db, rows: JoinRequest[]): Promise<JoinRequestAdminDto[]> {
  if (rows.length === 0) return [];
  const refused = await db
    .select({ id: joinRequests.id, tailnetUserId: joinRequests.tailnetUserId, decidedAt: joinRequests.decidedAt })
    .from(joinRequests)
    .where(
      and(
        eq(joinRequests.status, "refused"),
        inArray(
          joinRequests.tailnetUserId,
          rows.map((r) => r.tailnetUserId),
        ),
      ),
    );
  return rows.map((r) => {
    const before = refused.filter((x) => x.tailnetUserId === r.tailnetUserId && x.id !== r.id);
    const last = before.map((x) => x.decidedAt!).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      ...toDto(r),
      login: r.login,
      displayName: r.displayName,
      profilePicUrl: r.profilePicUrl,
      device: r.device,
      sharee: r.sharee,
      previousRefusals: before.length,
      lastRefusedAt: last?.toISOString() ?? null,
    };
  });
}

/** Pedidos de entrada são assunto só dos Admins. */
async function adminAudience(db: Db): Promise<Audience> {
  const admins = await db.select({ id: members.id }).from(members).where(eq(members.role, "admin"));
  return { members: admins.map((a) => a.id) };
}

async function latestOf(db: Db, tailnetUserId: string) {
  const [latest] = await db
    .select()
    .from(joinRequests)
    .where(eq(joinRequests.tailnetUserId, tailnetUserId))
    .orderBy(desc(joinRequests.createdAt))
    .limit(1);
  return latest;
}

function toDto(r: JoinRequest): JoinRequestDto {
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}
