import { inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { Clock } from "../clock";
import { findVisibleConversation } from "../conversations";
import { type Db, schema } from "../db/client";
import type { EventHub } from "../events";
import { adminOnly, type Env } from "../members";
import { MAX_ITEM_LENGTH } from "./extraction";
import {
  conversationMemory,
  correctItem,
  editableItem,
  isPromotable,
  promoteItem,
  publishMemory,
  selectMemory,
  undoItem,
  workspaceMemory,
  writeWorkspaceItem,
} from "./items";

/**
 * As rotas da Memória (spec #60). Cada Membro, Admin inclusive, só vê a Memória cuja conversa
 * de origem ele vê (ADR 0012): a conversa fechada de que ele não participa é como uma que não existe.
 *
 * Desfazer e corrigir são por item, em qualquer escopo (`editableItem`): quem vê a origem e, na
 * Memória do Workspace, só o Admin (`403 not_admin`). Quem não vê a origem recebe 404. Um item já
 * arquivado (desfeito ou substituído) dá `409 archived`.
 *
 * A Memória do Workspace (#66) todo Membro vê; só o Admin escreve nela.
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
    const text = await textOf(c.req.raw);
    if (!text) return invalidText(c);
    const id = await correctItem(db, { id: item.id, text, by: c.get("member"), now: clock.now() });
    if (id === "archived") return c.json({ error: "archived" }, 409);
    await publishMemory(db, events, [item.id, id]);
    const [created] = await selectMemory(db, inArray(schema.memoryItems.id, [id]));
    return c.json(created, 201);
  });

  /**
   * O Admin promove um item da Memória da Conversa de um Canal público à Memória do Workspace: a
   * versão nova, do Workspace e com a mesma origem, substitui a da Conversa, que fica arquivada.
   * Canal privado, DM ou item que não é da Memória da Conversa: `409 not_promotable`.
   */
  routes.post("/memory/:id/promote", adminOnly, async (c) => {
    const item = await editableItem(db, c.get("member"), c.req.param("id"));
    if (item === "not_found" || item === "not_admin") return c.json({ error: "not_found" }, 404);
    if (item.state === "active" && !(await isPromotable(db, item))) {
      return c.json(
        { error: "not_promotable", message: "Só um item da Memória da Conversa de um Canal público vai ao Workspace." },
        409,
      );
    }
    const id = await promoteItem(db, { id: item.id, by: c.get("member"), now: clock.now() });
    if (id === "archived") return c.json({ error: "archived" }, 409);
    await publishMemory(db, events, [item.id, id]);
    const [created] = await selectMemory(db, inArray(schema.memoryItems.id, [id]));
    return c.json(created, 201);
  });

  /** A Memória do Workspace: ativos e arquivados, do mais novo ao mais velho, para todo Membro. */
  routes.get("/workspace-memory", async (c) => c.json(await workspaceMemory(db)));

  /** O Admin escreve um item com `{ text }` direto na Memória do Workspace, sem origem. Devolve o item. */
  routes.post("/workspace-memory", adminOnly, async (c) => {
    const text = await textOf(c.req.raw);
    if (!text) return invalidText(c);
    const id = await writeWorkspaceItem(db, { text, by: c.get("member"), now: clock.now() });
    await publishMemory(db, events, [id]);
    const [created] = await selectMemory(db, inArray(schema.memoryItems.id, [id]));
    return c.json(created, 201);
  });

  return routes;
}

/** O `text` do corpo, sem os espaços das pontas, se é um texto de 1 a `MAX_ITEM_LENGTH` caracteres. */
async function textOf(req: Request): Promise<string | undefined> {
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return text && text.length <= MAX_ITEM_LENGTH ? text : undefined;
}

function invalidText(c: Context<Env>) {
  return c.json(
    { error: "invalid_input", message: `O texto é obrigatório, com até ${MAX_ITEM_LENGTH} caracteres.` },
    400,
  );
}
