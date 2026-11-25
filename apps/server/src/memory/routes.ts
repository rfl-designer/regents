import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { findVisibleConversation } from "../conversations";
import { type Db, isUuid, schema } from "../db/client";
import type { EventHub } from "../events";
import type { Env } from "../members";
import { MAX_ITEM_LENGTH } from "./extraction";
import {
  agentMemory,
  conversationMemory,
  correctItem,
  editableItem,
  publishMemory,
  selectMemory,
  undoItem,
} from "./items";

/**
 * As rotas da Memória (spec #60). Cada Membro, Admin inclusive, só vê a Memória cuja conversa
 * de origem ele vê (ADR 0012): a conversa fechada de que ele não participa é como uma que não existe.
 *
 * Desfazer e corrigir são por item, em qualquer escopo (`editableItem`): quem vê a origem e, na
 * Memória do Workspace, só o Admin (`403 not_admin`). Quem não vê a origem recebe 404. Um item já
 * arquivado (desfeito ou substituído) dá `409 archived`.
 */
export function memoryRoutes(deps: { db: Db; clock: Clock; events: EventHub }) {
  const { db, clock, events } = deps;
  const routes = new Hono<Env>();

  /** A lista "Memória" de um Canal ou DM, com as Threads: ativos e arquivados, do mais novo ao mais velho. */
  routes.get("/conversations/:id/memory", async (c) => {
    const conversation = await findVisibleConversation(db, c.get("member"), c.req.param("id"));
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json(await conversationMemory(db, conversation.id));
  });

  /**
   * A Memória do Agente (a tela do Agente, para todo Membro): só os itens cuja conversa de origem
   * quem olha vê, Admin inclusive. Ativos e arquivados, do mais novo ao mais velho.
   */
  routes.get("/agents/:id/memory", async (c) => {
    const id = c.req.param("id");
    const { agents } = schema;
    const [agent] = isUuid(id)
      ? await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
      : [];
    if (!agent) return c.json({ error: "not_found" }, 404);
    return c.json(await agentMemory(db, agent.id, c.get("member").id));
  });

  /** Desfaz um item: ele fica arquivado, sem versão nova, e sai do resumo. Devolve o item. */
  routes.post("/memory/:id/undo", async (c) => {
    const item = await editableItem(db, c.get("member"), c.req.param("id"));
    if (item === "not_found") return c.json({ error: "not_found" }, 404);
    if (item === "not_admin") return c.json({ error: "not_admin" }, 403);
    if ((await undoItem(db, { id: item.id, now: clock.now() })) === "archived") {
      return c.json({ error: "archived" }, 409);
    }
    await publishMemory(db, events, [item.id]);
    const [undone] = await selectMemory(db, inArray(schema.memoryItems.id, [item.id]));
    return c.json(undone);
  });

  /**
   * Corrige um item com `{ text }`: a versão nova (de quem corrigiu, com a mesma origem) substitui
   * a anterior, que fica arquivada e aponta para ela. Devolve a versão nova.
   */
  routes.post("/memory/:id/correct", async (c) => {
    const item = await editableItem(db, c.get("member"), c.req.param("id"));
    if (item === "not_found") return c.json({ error: "not_found" }, 404);
    if (item === "not_admin") return c.json({ error: "not_admin" }, 403);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MAX_ITEM_LENGTH) {
      return c.json(
        { error: "invalid_input", message: `O texto é obrigatório, com até ${MAX_ITEM_LENGTH} caracteres.` },
        400,
      );
    }
    const id = await correctItem(db, { id: item.id, text, by: c.get("member"), now: clock.now() });
    if (id === "archived") return c.json({ error: "archived" }, 409);
    await publishMemory(db, events, [item.id, id]);
    const [created] = await selectMemory(db, inArray(schema.memoryItems.id, [id]));
    return c.json(created, 201);
  });

  return routes;
}
