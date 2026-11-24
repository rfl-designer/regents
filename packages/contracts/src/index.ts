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

// ---------- erros ----------

export type ApiError =
  | { error: "no_identity"; reason: NoIdentityReason }
  | { error: "not_a_member" }
  | { error: "not_found" }
  | { error: "invalid_input"; message: string };
