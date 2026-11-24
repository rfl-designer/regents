import type { SetPresenceInput } from "@shearim/contracts";
import { Hono } from "hono";
import { findVisibleConversation } from "./conversations";
import type { Db } from "./db/client";
import type { EventHub } from "./events";
import type { Env } from "./members";

/**
 * Presença (Spec, módulo 11): por Membro e conexão (uma aba ou um PWA, num aparelho), qual
 * conversa está aberta e visível agora. É ela que faz o push calar. Vive na memória do processo,
 * presa à conexão de WebSocket: a conexão que cai leva a Presença junto, então uma aba que morre
 * sem avisar não deixa o push calado para sempre. Depois de um reinício, o PWA reconecta e diz
 * de novo.
 */
export interface Presence {
  /** Quem tem essa conversa à vista agora, em alguma conexão. */
  watchersOf(conversationId: string): Set<string>;
}

export function createPresence(deps: {
  db: Db;
  events: EventHub;
  /** O Membro passou a ter essa conversa à vista (o push zera o "3 novas" dela). */
  onOpened?: (memberId: string, conversationId: string) => void;
}) {
  const { db, events, onOpened } = deps;
  /** connectionId → o Membro e a conversa à vista. */
  const watching = new Map<string, { memberId: string; conversationId: string }>();
  events.onClose((connectionId) => watching.delete(connectionId));

  const presence: Presence = {
    watchersOf(conversationId) {
      const who = new Set<string>();
      for (const w of watching.values()) if (w.conversationId === conversationId) who.add(w.memberId);
      return who;
    },
  };

  const routes = new Hono<Env>();
  routes.put("/presence", async (c) => {
    const me = c.get("member");
    const input = (await c.req.json().catch(() => null)) as Partial<SetPresenceInput> | null;
    const connectionId = typeof input?.connectionId === "string" ? input.connectionId : "";
    const conversationId = input?.conversationId;
    if (conversationId !== null && typeof conversationId !== "string") {
      return c.json({ error: "invalid_input", message: "Diga a conversa à vista, ou null." }, 400);
    }
    // Só a própria conexão, e aberta: a de outra pessoa (ou uma que já caiu) é como se não existisse.
    if (events.ownerOf(connectionId) !== me.id) return c.json({ error: "not_found" }, 404);
    if (conversationId === null) {
      watching.delete(connectionId);
      return c.body(null, 204);
    }
    const conversation = await findVisibleConversation(db, me, conversationId);
    if (!conversation) return c.json({ error: "not_found" }, 404);
    // A conexão pode ter caído enquanto o banco respondia.
    if (events.ownerOf(connectionId) !== me.id) return c.json({ error: "not_found" }, 404);
    const before = watching.get(connectionId)?.conversationId;
    watching.set(connectionId, { memberId: me.id, conversationId: conversation.id });
    if (before !== conversation.id) onOpened?.(me.id, conversation.id);
    return c.body(null, 204);
  });

  return { presence, routes };
}
