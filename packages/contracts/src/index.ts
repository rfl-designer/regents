/**
 * Contratos compartilhados entre o servidor e o PWA: DTOs do HTTP.
 * Só tipos (e constantes pequenas). Nada de runtime pesado aqui.
 */

// ---------- identidade e Membros ----------

/** Por que uma requisição chegou sem identidade da tailnet (ADR 0007). */
export type NoIdentityReason = "tagged" | "funnel" | "unknown";

export type MemberRole = "admin" | "member";

/** `GET /api/me`: quem está usando o Shearim. */
export interface MeDto {
  id: string;
  login: string;
  displayName: string;
  role: MemberRole;
}

// ---------- Conversas ----------

export type ChannelKind = "public" | "private";

/** Item de `GET /api/channels`. */
export interface ChannelDto {
  id: string;
  name: string;
  kind: ChannelKind;
}

export interface MessageAuthorDto {
  id: string;
  displayName: string;
}

/** Item de `GET /api/channels/:id/messages` e corpo do 201 de `POST` na mesma rota. */
export interface MessageDto {
  id: string;
  channelId: string;
  body: string;
  author: MessageAuthorDto;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** Corpo de `POST /api/channels/:id/messages`. */
export interface SendMessageInput {
  body: string;
}

// ---------- eventos do WebSocket ----------

/** Onde o PWA abre o WebSocket de eventos. A identidade é a da requisição de upgrade. */
export const EVENTS_PATH = "/api/events";

/**
 * Tudo o que o servidor empurra pelo WebSocket. Cada evento é um JSON com `type`.
 * Comandos continuam no HTTP: o cliente não manda nada por aqui.
 *
 * Novos eventos (Desfecho, Andamento, não-lido, badge, presença, faixas) entram
 * como mais membros desta união, com `type` no formato `assunto.fato`.
 */
export type ServerEvent =
  /** Primeiro evento de toda conexão: daqui em diante, nada publicado se perde. */
  | { type: "ready"; me: MeDto }
  /** Mensagem nova numa conversa que o Membro vê. Também chega a quem a enviou. */
  | { type: "message.created"; message: MessageDto };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

// ---------- erros ----------

export type ApiError =
  | { error: "no_identity"; reason: NoIdentityReason }
  | { error: "not_a_member" }
  | { error: "not_found" }
  | { error: "invalid_input"; message: string };
