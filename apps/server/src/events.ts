import { EVENTS_CLOSE_UPDATING, type ServerEvent } from "@shearim/contracts";
import type { MiddlewareHandler } from "hono";
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
  close(code: number, reason: string): void;
}

export function createEventHub() {
  const connections = new Set<Connection>();
  let restarting = false;

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
  const upgrade = upgradeWebSocket((c) => {
    const member: Member = c.get("member");
    let connection: Connection | undefined;
    return {
      onOpen(_event, ws) {
        connection = {
          memberId: member.id,
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
        };
        connections.add(connection);
        ws.send(JSON.stringify({ type: "ready", me: toMeDto(member) } satisfies ServerEvent));
      },
      onClose() {
        if (connection) connections.delete(connection);
      },
    };
  });

  /** Durante o dreno, ninguém abre conexão nova: ela cairia de novo em segundos. */
  const route: MiddlewareHandler = (c, next) =>
    restarting ? Promise.resolve(c.json({ error: "updating" }, 503)) : upgrade(c, next);

  /**
   * O servidor vai reiniciar (dreno do SIGTERM, ou o Ctrl-C do dev): fecha toda conexão com 1012
   * e recusa as novas. Sem isso, o `server.stop()` espera as conexões e o cliente vê só um 1006.
   */
  function closeForRestart() {
    restarting = true;
    for (const c of connections) c.close(EVENTS_CLOSE_UPDATING, "o Shearim vai reiniciar");
    connections.clear();
  }

  return { hub, route, closeForRestart };
}
