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

/** Item de `GET /api/members`: quem se pode adicionar a um Canal. */
export interface MemberSummaryDto {
  id: string;
  displayName: string;
}

export type ChannelKind = "public" | "private";

/**
 * Quem participa de uma conversa: uma pessoa ou um Agente.
 * `photo` do Agente é um `data:` URL de imagem, ou `null`.
 */
export type ParticipantDto =
  | { kind: "member"; id: string; displayName: string }
  | { kind: "agent"; id: string; displayName: string; photo: string | null };

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

/** Quem escreveu: uma pessoa, ou um Agente (então com a foto dele). */
export type MessageAuthorDto =
  | { kind: "member"; id: string; displayName: string }
  | { kind: "agent"; id: string; displayName: string; photo: string | null };

/** Item de `GET /api/channels/:id/messages` e corpo do 201 de `POST` na mesma rota. */
export interface MessageDto {
  id: string;
  channelId: string;
  body: string;
  author: MessageAuthorDto;
  /**
   * A mensagem de origem, quando esta é a resposta ancorada de um Agente a ela.
   * O cliente mostra a resposta logo abaixo da origem, e não no fim da conversa.
   */
  originMessageId: string | null;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** Corpo de `POST /api/channels/:id/messages`. */
export interface SendMessageInput {
  body: string;
}

/** Corpo de `POST /api/channels/:id/agents`: põe um Agente no Canal (quem vê o Canal pode). */
export interface AddAgentInput {
  agentId: string;
}

// ---------- Agentes e Chave do Workspace ----------

/** Os modelos que um Agente pode usar. */
export const AGENT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/**
 * Item de `GET /api/agents` e corpo do 201 de `POST /api/agents`. A descrição é pública;
 * `instructions` só vem para o Admin.
 */
export interface AgentDto {
  id: string;
  name: string;
  /** `data:` URL de imagem (png, jpeg, webp ou gif), ou `null`. */
  photo: string | null;
  description: string;
  model: AgentModel;
  instructions?: string;
}

/** Corpo de `POST /api/agents` (só Admin). O nome não se repete (sem diferença de maiúsculas). */
export interface CreateAgentInput {
  name: string;
  photo?: string | null;
  description?: string;
  instructions?: string;
  model: AgentModel;
}

/** `GET`/`PUT /api/workspace-key` (só Admin). A Chave em si nunca volta ao navegador. */
export interface WorkspaceKeyDto {
  configured: boolean;
  /** Quando foi gravada pela última vez (ISO 8601), ou `null`. */
  updatedAt: string | null;
}

/** Corpo de `PUT /api/workspace-key`: a chave da Messages API. */
export interface SetWorkspaceKeyInput {
  apiKey: string;
}

// ---------- Execuções e Andamento ----------

/**
 * Em que pé está uma execução (cada chamada a modelo por causa de uma mensagem):
 * `queued` esperando a vez, `running` com o passo em `step`, `done` com a resposta em
 * `replyMessageId`, `failed` com o motivo, `not_acting` ("Agentes não agem", com o motivo;
 * não é falha).
 */
export type ExecutionState = "queued" | "running" | "done" | "failed" | "not_acting";

/** O passo de uma execução em andamento. `writing` é a bolha "escrevendo". */
export type ExecutionStep = "writing";

/**
 * O Andamento de uma execução, como todos que veem a conversa o veem.
 * Item de `GET /api/channels/:id/executions` (as que ainda não viraram resposta)
 * e de `execution.updated`.
 */
export interface ExecutionDto {
  id: string;
  channelId: string;
  /** A mensagem de pessoa que gerou a execução: a resposta entra ancorada sob ela. */
  originMessageId: string;
  agent: { id: string; displayName: string; photo: string | null };
  state: ExecutionState;
  step: ExecutionStep | null;
  /** Desde quando está no estado ou passo atual (ISO 8601): o cronômetro conta daqui. */
  since: string;
  /** 1 na primeira tentativa, 2 na segunda... (0 enquanto não começou). */
  attempt: number;
  /** Quem paga a execução em andamento. Só a Chave por enquanto (a Conta é do #26). */
  payer: "key" | null;
  /** Motivo da falha ou de "Agentes não agem", em pt-BR, para completar a frase. */
  reason: string | null;
  replyMessageId: string | null;
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
  /**
   * Um Canal apareceu ou mudou (criado, alguém entrou ou foi adicionado, Instruções ou N mudaram)
   * para quem pode vê-lo. Para quem acabou de ser adicionado a um privado, é a primeira vez que o vê.
   * O cliente trata como "insere ou troca pelo `id`".
   */
  | { type: "channel.updated"; channel: ChannelDto }
  /**
   * O Andamento de uma execução mudou (entrou na fila, começou a escrever, terminou, falhou),
   * para quem vê a conversa. Quando termina, a resposta chega antes como `message.created`.
   */
  | { type: "execution.updated"; execution: ExecutionDto };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

// ---------- erros ----------

export type ApiError =
  | { error: "no_identity"; reason: NoIdentityReason }
  | { error: "not_a_member" }
  | { error: "not_found" }
  | { error: "not_admin" }
  | { error: "name_taken"; message: string }
  | { error: "invalid_input"; message: string };
