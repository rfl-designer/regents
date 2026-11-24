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
  /** Identificador de Menção, sem o `@`: único entre Membros e Agentes, editável. */
  handle: string;
  /** Foto da tailnet na primeira entrada; `null` se a tailnet não tinha. */
  profilePicUrl: string | null;
  /** "Sobre mim", opcional (vazio quando não escreveu). */
  about: string;
  role: MemberRole;
}

// ---------- Menção ----------

/**
 * `@nome` num texto: o `@` não pode vir colado a letra, número, `_`, `.` ou outro `@`
 * (assim `bruno@exemplo.com` não é Menção), e o nome vai até o primeiro caractere que não é
 * letra, número ou `_` (assim `@bruno,` e `(@bruno)` citam `bruno`). O grupo 1 é o nome.
 * Uma função, porque uma RegExp global guarda estado entre usos.
 */
export function mentionPattern() {
  return /(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_]+)/gu;
}

/** O identificador de Menção como é guardado: sem `@` na frente, sem acento, em minúsculas. */
export function normalizeHandle(text: string) {
  return text.trim().replace(/^@+/, "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
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

/**
 * Item de `GET /api/members` (quem se pode adicionar a uma conversa, quem é quem) e
 * do evento `member.updated`.
 */
export interface MemberSummaryDto {
  id: string;
  displayName: string;
  /** Identificador de Menção, sem o `@`. */
  handle: string;
  profilePicUrl: string | null;
  about: string;
}

/** Corpo de `PATCH /api/me`: o Membro edita o próprio perfil. Campo ausente fica como está. */
export interface UpdateProfileInput {
  /** Até 80 caracteres, não vazio. */
  displayName?: string;
  /**
   * Identificador de Menção (com ou sem `@`): minúsculas, acentos e maiúsculas são normalizados;
   * fica com `[a-z0-9_]`, até 32. Já de outro participante: 409 `handle_taken`.
   */
  handle?: string;
  /** "Sobre mim", até 500 caracteres; vazio apaga. */
  about?: string;
}

export type ChannelKind = "public" | "private";

/**
 * `dm`: entre duas partes (duas pessoas; com o #23, uma pessoa e um Agente).
 * `group`: DM em grupo, aberta com três pessoas ou mais. Um grupo continua grupo
 * mesmo se ficar com menos gente (quem é removido sai das DMs em grupo, não das `dm`).
 */
export type DmKind = "dm" | "group";

/** Toda conversa: Canal ou DM. O id de qualquer uma serve em `/api/conversations/:id/...`. */
export type ConversationKind = ChannelKind | DmKind;

/**
 * Quem participa de uma conversa. Hoje só pessoas; os Agentes (#20) entram
 * como mais um membro desta união (`kind: "agent"`).
 */
export type ParticipantDto = { kind: "member"; id: string; displayName: string };

/**
 * Item de `GET /api/channels` (e de `GET /api/channels/:id`). Público: todo Membro vê;
 * privado: só quem participa. Quem vê o Canal vê as Instruções e o N.
 */
export interface ChannelDto {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Instruções do Canal (pode ser vazio). Só o Admin edita. */
  instructions: string;
  /** N: quantas mensagens recentes os Agentes do Canal recebem. Padrão 30, aceita 0. */
  recentMessages: number;
  /** Em ordem de entrada. */
  participants: ParticipantDto[];
}

/** Corpo de `POST /api/channels`. Quem cria participa. */
export interface CreateChannelInput {
  name: string;
  kind: ChannelKind;
}

/** Corpo de `POST /api/channels/:id/participants`: adiciona uma pessoa (quem adiciona participa). */
export interface AddParticipantInput {
  memberId: string;
}

/**
 * Item de `GET /api/channel-settings` (só Admin): todo Canal, inclusive os privados
 * de que o Admin não participa, sem mensagens nem participantes.
 */
export interface ChannelSettingsDto {
  id: string;
  name: string;
  kind: ChannelKind;
  instructions: string;
  recentMessages: number;
}

/** Corpo de `PATCH /api/channel-settings/:id` (só Admin). Campo ausente fica como está. */
export interface UpdateChannelSettingsInput {
  instructions?: string;
  recentMessages?: number;
}

/**
 * Item de `GET /api/dms` e resposta de `POST /api/dms`. Uma DM não tem nome nem
 * Instruções, e o N dela é fixo em 30. Só os participantes a veem (o Admin inclusive fica de fora).
 */
export interface DmDto {
  id: string;
  kind: DmKind;
  /** Todos, inclusive quem pede a lista, em ordem de entrada (e de nome, entre quem entrou junto). */
  participants: ParticipantDto[];
}

/**
 * Corpo de `POST /api/dms`: abre a DM com essas pessoas (quem abre entra sozinho; pode vir na lista).
 * Uma pessoa: `dm`; duas ou mais: `group`. Abrir de novo com as mesmas pessoas devolve a mesma
 * DM (200); uma nova responde 201. A DM com Agente (#23) entra como mais um campo aqui.
 */
export interface OpenDmInput {
  memberIds: string[];
}

export interface MessageAuthorDto {
  id: string;
  displayName: string;
  profilePicUrl: string | null;
}

/**
 * Quem uma mensagem menciona. Hoje só pessoas: o `@nome` de um Membro que vê a conversa.
 * As Menções a Agentes (#20) entram como mais um membro desta união (`kind: "agent"`).
 */
export type MentionDto = { kind: "member"; id: string };

/**
 * Item de `GET /api/conversations/:id/messages` (e de `/api/channels/:id/messages`, só para Canais)
 * e corpo do 201 de `POST` nas mesmas rotas.
 */
export interface MessageDto {
  id: string;
  /** O id da conversa: um Canal ou uma DM (o nome vem de antes das DMs). */
  channelId: string;
  body: string;
  author: MessageAuthorDto;
  /** Na ordem em que aparecem no texto, uma vez por pessoa. Destaca a mensagem para quem foi mencionado. */
  mentions: MentionDto[];
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** Corpo de `POST /api/conversations/:id/messages` (e de `/api/channels/:id/messages`). */
export interface SendMessageInput {
  body: string;
}

// ---------- Conta (ADR 0005) ----------

/**
 * O estado da Conta do Claude do Membro, como "Minha Conta" mostra.
 * Só o próprio Membro vê (nem o Admin). "No limite até" e "Precisa ligar de novo"
 * entram aqui com "Quem paga e fila" (#35).
 */
export type AccountStatusDto =
  | { state: "not_linked" }
  /** `plan` já vem pronto para a tela, ex. "Claude Max". */
  | { state: "linked"; email: string; plan: string };

/**
 * O fluxo "Ligar minha Conta do Claude" em andamento, ou o fim dele que a tela ainda mostra.
 * - `starting`: o Claude Code está abrindo o login.
 * - `waiting_code`: a pessoa abre `url`, entra na Anthropic e cola o código até `expiresAt`.
 * - `checking`: o código foi entregue; o Shearim confere a Conta com uma chamada mínima.
 * - `duplicate`: essa assinatura já está ligada a outra pessoa; "Ligar mesmo assim" ou "Cancelar".
 * - `failed`: não ligou; `message` explica em linguagem simples.
 * - `expired`: passaram os 10 minutos; "Começar de novo".
 */
export type AccountLinkingDto =
  | { state: "starting" }
  | { state: "waiting_code"; url: string; expiresAt: string }
  | { state: "checking" }
  | { state: "duplicate" }
  | { state: "failed"; message: string }
  | { state: "expired" };

/** `GET /api/account` e corpo das respostas dos comandos da Conta. */
export interface AccountDto {
  status: AccountStatusDto;
  linking: AccountLinkingDto | null;
  /** Oferecer a ligação ao entrar (primeiro acesso, até "Agora não" ou ligar). */
  offer: boolean;
}

/** Corpo de `POST /api/account/linking/code`. */
export interface SubmitAccountCodeInput {
  code: string;
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
  /** A Conta do Membro (ou o fluxo de ligação) mudou. Vai só para as conexões do próprio Membro. */
  | { type: "account.updated"; account: AccountDto }
  /**
   * Um Canal apareceu ou mudou (criado, alguém entrou ou foi adicionado, Instruções ou N mudaram)
   * para quem pode vê-lo. Para quem acabou de ser adicionado a um privado, é a primeira vez que o vê.
   * O cliente trata como "insere ou troca pelo `id`".
   */
  | { type: "channel.updated"; channel: ChannelDto }
  /**
   * O perfil de um Membro mudou (nome, identificador de Menção, "sobre mim"). Para todo Membro,
   * inclusive as outras abas de quem editou: é assim que o "Você está como Fulano" acompanha.
   */
  | { type: "member.updated"; member: MemberSummaryDto }
  /** Uma DM apareceu para os participantes dela (quem abriu também recebe). Insere ou troca pelo `id`. */
  | { type: "dm.updated"; dm: DmDto }
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
  /** O tailscaled não respondeu ao `whois` (503): problema da Instalação, não de quem chegou. */
  | { error: "identity_unavailable" }
  | { error: "not_admin" }
  | { error: "already_member" }
  | { error: "already_decided"; status: JoinRequestStatus }
  | { error: "not_found" }
  | { error: "conflict"; message: string }
  | { error: "name_taken"; message: string }
  /** O identificador de Menção pedido já é de outra pessoa ou Agente. */
  | { error: "handle_taken"; message: string }
  | { error: "invalid_input"; message: string };
