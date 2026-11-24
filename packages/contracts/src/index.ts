/**
 * Contratos compartilhados entre o servidor e o PWA: DTOs do HTTP.
 * Só tipos (e constantes pequenas). Nada de runtime pesado aqui.
 */

// ---------- identidade e Membros ----------

/** Por que uma requisição chegou sem identidade da tailnet (ADR 0007). */
export type NoIdentityReason = "tagged" | "funnel" | "unknown";

/**
 * O motivo e o que fazer, em pt-BR, para quem chega sem identidade. A página estática
 * do servidor e o PWA usam os mesmos textos.
 */
export const NO_IDENTITY_TEXT: Record<NoIdentityReason, { why: string; whatToDo: string }> = {
  tagged: {
    why: "Este aparelho entrou na tailnet com uma tag, e nós com tag não têm uma pessoa por trás.",
    whatToDo: "Abra o Shearim num aparelho que esteja na tailnet com a sua própria conta do Tailscale.",
  },
  funnel: {
    why: "O acesso veio pela internet aberta (Funnel), e o Shearim só atende quem está na tailnet.",
    whatToDo: "Ligue o Tailscale neste aparelho, entre com a sua conta e abra o endereço da tailnet.",
  },
  unknown: {
    why: "A tailnet não disse quem é você.",
    whatToDo: "Confira se o Tailscale está ligado e com a sua conta neste aparelho, e tente de novo.",
  },
};

export type MemberRole = "admin" | "member";

/** `GET /api/me`: quem está usando o Shearim. */
export interface MeDto {
  id: string;
  login: string;
  displayName: string;
  role: MemberRole;
}

// ---------- Pedido de entrada ----------

export type JoinRequestStatus = "pending" | "approved" | "refused";

/** O pedido como quem pediu o vê: só o estado. */
export interface JoinRequestDto {
  id: string;
  status: JoinRequestStatus;
  /** ISO 8601, UTC. */
  createdAt: string;
  decidedAt: string | null;
}

/**
 * `GET /api/join-request`: quem a tailnet diz que é você e o seu pedido mais recente
 * (`null` se nunca pediu). Responde também a quem ainda não é Membro.
 */
export interface MyJoinRequestDto {
  you: { login: string; displayName: string };
  joinRequest: JoinRequestDto | null;
}

/** O pedido como o Admin o vê, para decidir (`GET /api/join-requests`). */
export interface JoinRequestAdminDto extends JoinRequestDto {
  login: string;
  displayName: string;
  profilePicUrl: string | null;
  /** Nome do aparelho de onde veio o pedido, quando a tailnet diz. */
  device: string | null;
  /** Pessoa de outra tailnet (`Node.Hostinfo.ShareeNode`). */
  sharee: boolean;
  /** Quantos pedidos dessa pessoa (mesmo `UserProfile.ID`) já foram recusados antes deste. */
  previousRefusals: number;
  lastRefusedAt: string | null;
}

/** Resposta de `POST /api/join-requests/:id/approve`. */
export interface ApproveJoinRequestDto {
  joinRequest: JoinRequestAdminDto;
  member: MeDto;
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
  | { type: "message.created"; message: MessageDto }
  /** Pedido de entrada novo. Só para Admins. */
  | { type: "join_request.created"; joinRequest: JoinRequestAdminDto }
  /** Um Admin aprovou ou recusou um pedido. Só para Admins (os outros tiram o card da lista). */
  | { type: "join_request.decided"; joinRequest: JoinRequestAdminDto };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

// ---------- erros ----------

export type ApiError =
  | { error: "no_identity"; reason: NoIdentityReason }
  | { error: "not_a_member" }
  | { error: "not_admin" }
  | { error: "already_member" }
  | { error: "already_decided"; status: JoinRequestStatus }
  | { error: "not_found" }
  | { error: "invalid_input"; message: string };
