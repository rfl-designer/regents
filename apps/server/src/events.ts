import type { ServerEvent } from "@shearim/contracts";
import { upgradeWebSocket } from "hono/bun";
import type { Member } from "./members";
import { toMeDto } from "./members";

/**
 * A quem um evento vai. `"everyone"` é toda conexão aberta de Membro;
 * `{ members }` são só as conexões desses Membros (todas as abas e aparelhos deles).
 *
 * Quem publica decide o público: um Canal privado ou uma DM resolve os
 * participantes e passa `{ members }`; o que é só do autor (estado da Conta)
 * passa `{ members: [autor] }`.
 */
export type Audience = "everyone" | { members: readonly string[] };

/** O ponto único por onde o servidor empurra eventos às conexões de WebSocket. */
export interface EventHub {
  publish(to: Audience, event: ServerEvent): void;
  /** De quem é a conexão aberta com esse id (o `connectionId` do `ready`), ou `undefined`. */
  ownerOf(connectionId: string): string | undefined;
  /** Chama `fn` sempre que uma conexão fecha (a Presença dela some junto). */
  onClose(fn: (connectionId: string) => void): void;
}

interface Connection {
  id: string;
  memberId: string;
  send(data: string): void;
}

export function createEventHub() {
  const connections = new Map<string, Connection>();
  const closeListeners: ((connectionId: string) => void)[] = [];

  const hub: EventHub = {
    publish(to, event) {
      const data = JSON.stringify(event);
      const members = to === "everyone" ? undefined : new Set(to.members);
      for (const c of connections.values()) if (!members || members.has(c.memberId)) c.send(data);
    },
    ownerOf: (connectionId) => connections.get(connectionId)?.memberId,
    onClose(fn) {
      closeListeners.push(fn);
    },
  };

  /**
   * Rota de upgrade. Roda depois do middleware de `/api/*`, então a conexão já
   * vem com o Membro que a porta de identidade reconheceu, ou nem sobe (403).
   */
  const route = upgradeWebSocket((c) => {
    const member: Member = c.get("member");
    let connection: Connection | undefined;
    return {
      onOpen(_event, ws) {
        connection = { id: crypto.randomUUID(), memberId: member.id, send: (data) => ws.send(data) };
        connections.set(connection.id, connection);
        ws.send(
          JSON.stringify({ type: "ready", me: toMeDto(member), connectionId: connection.id } satisfies ServerEvent),
        );
      },
      onClose() {
        if (!connection) return;
        connections.delete(connection.id);
        for (const fn of closeListeners) fn(connection.id);
      },
    };
  });

  return { hub, route };
}
