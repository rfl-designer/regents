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
}

interface Connection {
  memberId: string;
  send(data: string): void;
}

export function createEventHub() {
  const connections = new Set<Connection>();

  const hub: EventHub = {
    publish(to, event) {
      const data = JSON.stringify(event);
      const members = to === "everyone" ? undefined : new Set(to.members);
      for (const c of connections) if (!members || members.has(c.memberId)) c.send(data);
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
        connection = { memberId: member.id, send: (data) => ws.send(data) };
        connections.add(connection);
        ws.send(JSON.stringify({ type: "ready", me: toMeDto(member) } satisfies ServerEvent));
      },
      onClose() {
        if (connection) connections.delete(connection);
      },
    };
  });

  return { hub, route };
}
