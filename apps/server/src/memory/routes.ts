import { Hono } from "hono";
import { findVisibleConversation } from "../conversations";
import type { Db } from "../db/client";
import type { Env } from "../members";
import { conversationMemory } from "./items";

/**
 * As rotas da Memória (spec #60). Cada Membro, Admin inclusive, só vê a Memória cuja conversa
 * de origem ele vê (ADR 0012): a conversa fechada de que ele não participa é como uma que não existe.
 */
export function memoryRoutes(deps: { db: Db }) {
  const { db } = deps;
  const routes = new Hono<Env>();

  /** A lista "Memória" de um Canal ou DM, com as Threads: ativos e arquivados, do mais novo ao mais velho. */
  routes.get("/conversations/:id/memory", async (c) => {
    const conversation = await findVisibleConversation(db, c.get("member"), c.req.param("id"));
    if (!conversation) return c.json({ error: "not_found" }, 404);
    return c.json(await conversationMemory(db, conversation.id));
  });

  return routes;
}
