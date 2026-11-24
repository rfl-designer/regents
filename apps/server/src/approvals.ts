import type { ApprovalRequestDto, RejectApprovalInput } from "@shearim/contracts";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { Clock } from "./clock";
import { findVisibleConversation } from "./conversations";
import { type Db, isUuid, schema, type Tx } from "./db/client";
import type { EventHub } from "./events";
import type { Env } from "./members";
import { audienceOf } from "./participation";
import type { PostAsAgent, ToolPort } from "./tools/port";

const { approvalRequests, agents, members, channels, executions } = schema;
type Row = typeof approvalRequests.$inferSelect;

/** Um Pedido pendente expira 24 h depois de criado (ADR 0011). */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
const REASON_MAX = 500;

/** O hash da ação guardada: o JSON com as chaves em ordem, em SHA-256. */
export function actionHash(action: Record<string, unknown>) {
  const stable = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : Array.isArray(v)
        ? v.map(stable)
        : v;
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(action))).digest("hex");
}

/**
 * Grava o Pedido de aprovação de uma escrita (na mesma transação que encerra a execução em
 * "esperando aprovação"). O autor é o da mensagem de origem. Devolve o id.
 */
export async function insertApproval(
  tx: Db | Tx,
  values: {
    executionId: string;
    channelId: string;
    originMessageId: string;
    agentId: string;
    tool: string;
    toolTitle: string;
    action: Record<string, unknown>;
    summary: string;
    now: Date;
  },
) {
  const [origin] = await tx
    .select({ authorId: schema.messages.authorMemberId })
    .from(schema.messages)
    .where(eq(schema.messages.id, values.originMessageId));
  const id = crypto.randomUUID();
  const { now, ...rest } = values;
  await tx.insert(approvalRequests).values({
    ...rest,
    id,
    authorMemberId: origin!.authorId!,
    actionHash: actionHash(values.action),
    state: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
  });
  return id;
}

async function views(db: Db, where: SQL | undefined): Promise<ApprovalRequestDto[]> {
  const rows = await db
    .select({ r: approvalRequests, agentName: agents.name, agentPhoto: agents.photo, authorName: members.displayName })
    .from(approvalRequests)
    .innerJoin(agents, eq(agents.id, approvalRequests.agentId))
    .innerJoin(members, eq(members.id, approvalRequests.authorMemberId))
    .where(where)
    .orderBy(asc(approvalRequests.seq));
  return rows.map(({ r, agentName, agentPhoto, authorName }) => ({
    id: r.id,
    channelId: r.channelId,
    originMessageId: r.originMessageId,
    executionId: r.executionId,
    agent: { id: r.agentId, displayName: agentName, photo: agentPhoto },
    author: { id: r.authorMemberId, displayName: authorName },
    tool: r.tool,
    toolTitle: r.toolTitle,
    summary: r.summary,
    state: r.state,
    rejectReason: r.rejectReason,
    result: r.result,
    failure: r.failure,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  }));
}

/** Anuncia o Pedido a quem vê a conversa (criado, ou com o estado novo). Devolve o DTO. */
export async function publishApproval(
  db: Db,
  events: EventHub,
  id: string,
  type: "approval.created" | "approval.updated",
) {
  const [approval] = await views(db, eq(approvalRequests.id, id));
  const [conversation] = await db.select().from(channels).where(eq(channels.id, approval!.channelId));
  events.publish(await audienceOf(db, conversation!), { type, approval: approval! });
  return approval!;
}

/**
 * O que a continuação sabe das escritas que a resposta já pediu (ADR 0011): cada Pedido da cadeia,
 * do mais antigo ao mais novo, com a decisão e o resultado (ou a falha, ou a recusa e o motivo).
 */
export async function continuationNote(db: Db, approvalRequestId: string) {
  const chain: (Row & { authorName: string })[] = [];
  let next: string | null = approvalRequestId;
  while (next) {
    const [row] = await db
      .select({ r: approvalRequests, authorName: members.displayName, before: executions.approvalRequestId })
      .from(approvalRequests)
      .innerJoin(members, eq(members.id, approvalRequests.authorMemberId))
      .innerJoin(executions, eq(executions.id, approvalRequests.executionId))
      .where(eq(approvalRequests.id, next));
    if (!row) break;
    chain.unshift({ ...row.r, authorName: row.authorName });
    next = row.before;
  }
  const lines = chain.map((r) => {
    const asked = `- Você pediu: ${r.summary}.`;
    if (r.state === "rejected") {
      return `${asked} ${r.authorName} recusou${r.rejectReason ? `, com o motivo: ${r.rejectReason}` : ", sem dar motivo"}.`;
    }
    if (r.failure) return `${asked} ${r.authorName} aprovou, mas a ação falhou: ${r.failure}.`;
    return `${asked} ${r.authorName} aprovou, e o Shearim fez: ${r.result}.`;
  });
  return [
    "Você já começou esta resposta e pediu escritas, que passaram por Pedido de aprovação de quem escreveu:",
    ...lines,
    "Continue a resposta a partir daí. Não peça de novo o que já foi feito; o que foi recusado, só peça de novo se for diferente.",
  ].join("\n");
}

/**
 * Os Pedidos de aprovação (ADR 0011): a lista de uma conversa (quem a vê) e a decisão, só do autor
 * da mensagem de origem. Aprovar confere o hash da ação guardada e executa-a pela porta de
 * Ferramentas (que confere o alcance de novo), sem passar pelo modelo; recusar guarda o motivo
 * opcional. As duas enfileiram a continuação da resposta.
 */
export function approvalRoutes(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  tools: ToolPort;
  post: PostAsAgent;
  /** A continuação depois da decisão (`executions.continueAfter`). */
  continueAfter(executionId: string, approvalRequestId: string): Promise<void>;
}) {
  const { db, clock, events, tools, post } = deps;
  const routes = new Hono<Env>();

  routes.get("/conversations/:id/approvals", async (c) => {
    const conversation = await findVisibleConversation(db, c.get("member"), c.req.param("id"));
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json(await views(db, eq(approvalRequests.channelId, conversation.id)));
  });

  /** O Pedido da conversa, se quem chama a vê e é o autor; o erro HTTP, senão. */
  async function decidable(c: Context<Env>) {
    const conversation = await findVisibleConversation(db, c.get("member"), c.req.param("id") ?? "");
    const id = c.req.param("approvalId") ?? "";
    if (!conversation || !isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.channelId, conversation.id)));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.authorMemberId !== c.get("member").id) return c.json({ error: "not_author" }, 403);
    if (row.state !== "pending") return c.json({ error: "not_pending" }, 409);
    return row;
  }

  /** Passa de pendente para `state`, se ainda está pendente (duas decisões ao mesmo tempo: só uma ganha). */
  async function decide(row: Row, change: Partial<typeof approvalRequests.$inferInsert>) {
    const updated = await db
      .update(approvalRequests)
      .set({ ...change, decidedAt: clock.now() })
      .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.state, "pending")))
      .returning({ id: approvalRequests.id });
    return updated.length > 0;
  }

  routes.post("/conversations/:id/approvals/:approvalId/approve", async (c) => {
    const row = await decidable(c);
    if (row instanceof Response) return row;
    if (!(await decide(row, { state: "approved" }))) return c.json({ error: "not_pending" }, 409);
    // A ação executada é exatamente a aprovada: o hash confere, e o alcance é conferido de novo.
    const [execution] = await db.select().from(executions).where(eq(executions.id, row.executionId));
    const outcome =
      actionHash(row.action) !== row.actionHash
        ? { ok: false as const, reason: "a ação guardada não confere com a que foi pedida" }
        : await tools.perform(
            row.tool,
            {
              executionId: row.executionId,
              attempt: execution!.attempt,
              agentId: row.agentId,
              channelId: row.channelId,
              originMessageId: row.originMessageId,
            },
            row.action,
            post,
          );
    await db
      .update(approvalRequests)
      .set(outcome.ok ? { result: outcome.result } : { failure: outcome.reason })
      .where(eq(approvalRequests.id, row.id));
    const approval = await publishApproval(db, events, row.id, "approval.updated");
    await deps.continueAfter(row.executionId, row.id);
    return c.json(approval);
  });

  routes.post("/conversations/:id/approvals/:approvalId/reject", async (c) => {
    const row = await decidable(c);
    if (row instanceof Response) return row;
    const input = (await c.req.json().catch(() => ({}))) as Partial<RejectApprovalInput> | null;
    const raw = input?.reason;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return c.json({ error: "invalid_input", message: "O motivo é um texto." }, 400);
    }
    const reason = raw?.trim() || null;
    if (reason && reason.length > REASON_MAX) {
      return c.json({ error: "invalid_input", message: `O motivo tem no máximo ${REASON_MAX} caracteres.` }, 400);
    }
    if (!(await decide(row, { state: "rejected", rejectReason: reason }))) return c.json({ error: "not_pending" }, 409);
    const approval = await publishApproval(db, events, row.id, "approval.updated");
    await deps.continueAfter(row.executionId, row.id);
    return c.json(approval);
  });

  return routes;
}
