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
 * `dm`: entre duas partes (duas pessoas, ou uma pessoa e um Agente).
 * `group`: DM em grupo, aberta com três pessoas ou mais. Um grupo continua grupo
 * mesmo se ficar com menos gente (quem é removido sai das DMs em grupo, não das `dm`).
 */
export type DmKind = "dm" | "group";

/** Toda conversa: Canal ou DM. O id de qualquer uma serve em `/api/conversations/:id/...`. */
export type ConversationKind = ChannelKind | DmKind;

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
 * DM (200); uma nova responde 201.
 * Com `agentId` (e nenhuma outra pessoa), é a DM de quem abre com aquele Agente (`dm`), uma por
 * Agente; o Agente responde a cada mensagem dela. Numa DM entre pessoas, Agente só entra por Menção.
 */
export interface OpenDmInput {
  memberIds: string[];
  agentId?: string;
}

/**
 * Quem escreveu: uma pessoa (com a foto da tailnet, ou `null`), ou um Agente (com a foto dele,
 * um `data:` URL, ou `null`).
 */
export type MessageAuthorDto =
  | { kind: "member"; id: string; displayName: string; profilePicUrl: string | null }
  | { kind: "agent"; id: string; displayName: string; photo: string | null };

/**
 * Quem uma mensagem menciona: o `@identificador` de um Membro que vê a conversa, ou de um
 * Agente (a Menção a um Agente é o que o faz responder ali).
 */
export type MentionDto = { kind: "member"; id: string } | { kind: "agent"; id: string };

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
  /**
   * A mensagem de origem, quando esta é a resposta ancorada de um Agente a ela.
   * O cliente mostra a resposta logo abaixo da origem, e não no fim da conversa.
   */
  originMessageId: string | null;
  /**
   * Numa Thread, a mensagem-raiz em que ela pendura (do fluxo principal da mesma conversa); nulo
   * no fluxo principal. O cliente mostra a mensagem de Thread no painel da Thread, não no Canal.
   */
  threadRootId: string | null;
  /**
   * Na ordem em que aparecem no texto, uma vez por participante (pessoa ou Agente).
   * Destaca a mensagem para quem foi mencionado.
   */
  mentions: MentionDto[];
  /** ISO 8601, UTC. */
  createdAt: string;
  /**
   * Só na resposta de Agente paga pela Chave do Workspace: `"key"` ("⚠ pela Chave do Workspace",
   * que todos veem). Ausente pela Conta do autor e nas mensagens de pessoa.
   */
  payer?: "key";
}

/** Corpo de `POST /api/conversations/:id/messages` (e de `/api/channels/:id/messages`). */
export interface SendMessageInput {
  body: string;
  /**
   * Responder numa Thread: a mensagem-raiz, do fluxo principal da mesma conversa. A primeira
   * resposta abre a Thread. Ausente ou nulo: a mensagem vai para o fluxo principal.
   */
  threadRootId?: string | null;
}

/**
 * Uma Thread seguida (Spec, módulo 3): o Membro acompanha a Thread e é avisado dela. Segue,
 * sozinho, quem escreveu a raiz, quem respondeu na Thread e quem foi mencionado nela (ou na raiz).
 * Agentes não seguem. `GET /api/threads/followed` (as de quem pede) e `thread.followed`.
 */
export interface FollowedThreadDto {
  conversationId: string;
  rootMessageId: string;
  /** Desde quando segue (ISO 8601): só o que chega na Thread daí em diante conta como não-lida. */
  since: string;
}

/** Corpo de `POST /api/channels/:id/agents`: põe um Agente no Canal (quem vê o Canal pode). */
export interface AddAgentInput {
  agentId: string;
}

// ---------- Leitura e não-lido (Spec, módulo 10) ----------

/**
 * As não-lidas do Membro numa conversa. Conta toda mensagem (a resposta ancorada inclusive) que
 * chegou depois de ele entrar na conversa, não é dele e ainda não apareceu na tela dele.
 */
export interface ConversationUnreadDto {
  conversationId: string;
  count: number;
  /** Quantas das não-lidas mencionam o Membro: a lista de conversas destaca essas (e as DMs). */
  mentions: number;
  /** A primeira não-lida na ordem de exibição (respostas ancoradas sob a origem): onde a conversa abre. */
  firstUnreadId: string | null;
}

/**
 * `GET /api/unread`, a resposta de `POST /api/conversations/:id/reads` e `unread.updated`:
 * as não-lidas de quem pede, só dele.
 */
export interface UnreadDto {
  /** Só as conversas com alguma não-lida. */
  conversations: ConversationUnreadDto[];
  /** A soma de todas as não-lidas das conversas do Membro: o badge do ícone. */
  total: number;
  /** Não-lidas que mencionam o Membro, em todas as conversas. */
  mentions: number;
  /** Não-lidas em DMs (`dm` e `group`). */
  dms: number;
}

/** `GET /api/conversations/:id/unread`: as não-lidas de quem pede, na ordem de exibição. */
export interface UnreadMessagesDto {
  messageIds: string[];
}

/** Corpo de `POST /api/conversations/:id/reads`: mensagens que apareceram na tela de quem tem a conversa aberta. */
export interface MarkReadInput {
  messageIds: string[];
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
  /**
   * Identificador de Menção, sem o `@`: do mesmo espaço de nomes dos Membros. Gerado do nome
   * na criação (`Faro` → `faro`; `faro2` se um Membro já tinha `faro`).
   */
  handle: string;
  /** `data:` URL de imagem (png, jpeg, webp ou gif), ou `null`. */
  photo: string | null;
  description: string;
  model: AgentModel;
  /**
   * A Articuladora (ADR 0004): o Agente embutido do Shearim, em todo Canal. Não se apaga nem sai
   * de um Canal; o Admin muda o nome, a foto e o modelo, mas a descrição, as instruções e o
   * contrato de roteamento dela são do Shearim.
   */
  builtin: boolean;
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

/**
 * Corpo de `PATCH /api/agents/:id` (só Admin). Campo ausente fica. Da Articuladora (`builtin`),
 * só `name`, `photo` e `model`: `description` e `instructions` dão `403 builtin_locked`.
 * Trocar o nome troca o identificador de Menção (`handle`).
 */
export type UpdateAgentInput = Partial<CreateAgentInput>;

/** `GET`/`PUT /api/workspace-key` (só Admin). A Chave em si nunca volta ao navegador. */
/** Sem backup bom há mais que isto, o Admin recebe push e vê a faixa (Spec, história 14). */
export const BACKUP_STALE_HOURS = 36;
/** Quantos dias antes de a chave do nó vencer na tailnet o Admin recebe push (história 15). */
export const NODE_KEY_WARNING_DAYS = 14;
/** Por quantos dias os backups noturnos ficam em `./backups`. */
export const BACKUP_RETENTION_DAYS = 14;

/** Um backup noturno, bom ou não. */
export interface BackupRunDto {
  /** Quando terminou (ISO 8601). */
  at: string;
  ok: boolean;
  /** O nome do arquivo em `./backups`, quando deu certo. */
  file: string | null;
  bytes: number | null;
  /** O que deu errado, quando falhou. */
  error: string | null;
}

/** Quando a chave do nó da Instalação vence na tailnet (o `Self.KeyExpiry` do tailscaled). */
export type NodeKeyDto =
  | { kind: "expires"; expiresAt: string }
  /** Vencimento desligado (o padrão de um nó com tag). */
  | { kind: "never" }
  /** Não deu para perguntar ao tailscaled (ou não há tailnet, no desenvolvimento). */
  | { kind: "unknown"; reason: string };

/** O que pede a faixa do Admin sobre a Instalação. */
export type InstallationAlertDto =
  /** O último backup noturno falhou. */
  | { kind: "backup_failed"; at: string; error: string }
  /** Faz mais de 36 h sem um backup bom (`lastGoodAt` nulo: nunca houve um). */
  | { kind: "backup_stale"; lastGoodAt: string | null };

/** A seção Instalação (Spec, módulo 13; `GET /api/installation`), só para o Admin. */
export interface InstallationDto {
  /** A versão do Shearim que está rodando (a tag da imagem). */
  version: string;
  /** A última migração aplicada no banco. */
  migration: string;
  backup: { last: BackupRunDto | null; lastGoodAt: string | null };
  nodeKey: NodeKeyDto;
  alerts: InstallationAlertDto[];
}

export interface WorkspaceKeyDto {
  configured: boolean;
  /** Quando foi gravada pela última vez (ISO 8601), ou `null`. */
  updatedAt: string | null;
}

/** Corpo de `PUT /api/workspace-key`: a chave da Messages API. */
export interface SetWorkspaceKeyInput {
  apiKey: string;
}

/** Tamanho máximo do Contexto do Workspace, em caracteres: ele é curto e entra em toda execução. */
export const WORKSPACE_CONTEXT_MAX = 4000;

/**
 * `GET`/`PUT /api/workspace-context` (só Admin): o Contexto do Workspace, um texto curto sobre
 * quem é o Workspace e como ele fala. Entra no contexto de todo Agente, em todo Canal e DM.
 */
export interface WorkspaceContextDto {
  context: string;
}

// ---------- Execuções e Andamento ----------

/**
 * Em que pé está uma execução (cada chamada a modelo por causa de uma mensagem):
 * `queued` esperando a vez, `running` com o passo em `step`, `retrying` (falhou uma vez, com o
 * motivo, e volta sozinha em `retryAt`), `done` com a resposta em `replyMessageId`, `failed` com
 * o motivo (depois da nova tentativa; o autor pode "Tentar de novo"), `not_acting` ("Agentes não
 * agem", com o motivo; não é falha) e `cancelled` ("cancelada por quem escreveu").
 */
export type ExecutionState = "queued" | "running" | "retrying" | "done" | "failed" | "not_acting" | "cancelled";

/**
 * O passo de uma execução em andamento. `writing` é a bolha "escrevendo"; `deciding` é o
 * roteamento da Articuladora ("Sophya decidindo quem responde").
 */
export type ExecutionStep = "deciding" | "writing";

/**
 * O Andamento de uma execução, como todos que veem a conversa o veem.
 * Item de `GET /api/channels/:id/executions` (as que ainda não viraram resposta)
 * e de `execution.updated`.
 */
/**
 * Por que a execução existe: `mention` (Menção), `dm` (o Agente de uma DM com Agente), `route` (o
 * roteamento da Articuladora: "Sophya decidindo quem responde"), `reply` (ela responde) ou
 * `delegated` (um Agente a quem ela passou a mensagem).
 */
export type ExecutionKind = "mention" | "dm" | "route" | "reply" | "delegated";

export interface ExecutionDto {
  id: string;
  kind: ExecutionKind;
  channelId: string;
  /** A mensagem de pessoa que gerou a execução: a resposta entra ancorada sob ela. */
  originMessageId: string;
  agent: { id: string; displayName: string; photo: string | null };
  state: ExecutionState;
  step: ExecutionStep | null;
  /** Desde quando está no estado ou passo atual (ISO 8601): o cronômetro conta daqui. */
  since: string;
  /** 1 na primeira tentativa, 2 na nova tentativa automática (0 enquanto não começou). */
  attempt: number;
  /** Em `retrying`: quando a nova tentativa automática sai (ISO 8601). Nulo nos outros estados. */
  retryAt: string | null;
  /** A API está sendo tentada de novo agora: "tentando de novo (n/m)". Some quando o texto volta. */
  apiRetry: { attempt: number; max: number } | null;
  /**
   * `key` quando quem paga é a Chave do Workspace ("pela Chave do Workspace", inclusive depois da
   * troca no meio). Nulo pela Conta do autor (o estado da Conta é só dele) e antes de decidir.
   */
  payer: "key" | null;
  /**
   * Motivo da falha (em `retrying` e `failed`) ou de "Agentes não agem", em pt-BR, para completar
   * a frase "Faro não respondeu: …". Nulo nos outros estados. Quando o motivo é estado da Conta do
   * autor (ex. "a sua Conta do Claude não pode ser usada agora"), só a cópia do autor o traz; os
   * outros veem um motivo que não fala da Conta.
   */
  reason: string | null;
  /**
   * "⏸ na fila": a execução (em `queued`) espera quem pague por ela (a Conta do autor no limite ou
   * em "Precisa ligar de novo", sem Chave utilizável). Todos veem; o porquê e a hora da volta só o
   * autor vê, em `yourAccount`. Não segura as outras mensagens da fila.
   */
  held: boolean;
  /**
   * Só na cópia do autor da mensagem de origem (os outros recebem nulo): o motivo ligado à Conta
   * dele, quando ela explica a fila, a Chave pagando ou "Agentes não agem". Nulo quando a Conta
   * não tem nada a ver com o que se vê.
   */
  yourAccount: YourAccountDto | null;
  replyMessageId: string | null;
}

/**
 * O estado da Conta do autor que explica o Andamento, só para ele:
 * - `limited`: no limite até `until` ("⏸ na fila até qui., 15:45", "· sua Conta no limite até 18:00");
 * - `needs_relink`: "Precisa ligar de novo" ("⏸ na fila até você ligar sua Conta de novo");
 * - `not_linked`: ele não ligou uma Conta ("Agentes não agem: você não ligou uma Conta e …").
 */
export type YourAccountDto = { state: "limited"; until: string } | { state: "needs_relink" } | { state: "not_linked" };

// ---------- Desfecho (ADR 0004) ----------

/** `reply`: a Articuladora responde ela mesma. `delegate`: passa para Agentes do Canal. `none`: nenhum Agente precisa agir. */
export type OutcomeDecision = "reply" | "delegate" | "none";

/**
 * O Desfecho que a Articuladora deu a uma mensagem de pessoa num Canal com outros Agentes.
 * Item de `GET /api/conversations/:id/outcomes` e de `outcome.created`. A Menção pula o
 * roteamento e não tem Desfecho aqui: a resposta ancorada é o Desfecho.
 * O PWA mostra `delegate` como "↳ Sophya passou para Faro e Prisma" e `none` como `⌀` ao lado da
 * hora, com o motivo e as frases ao passar o mouse ou tocar; `reply` não tem linha extra.
 */
export interface OutcomeDto {
  /** A mensagem de pessoa que recebeu o Desfecho. */
  messageId: string;
  channelId: string;
  decision: OutcomeDecision;
  /** O motivo, uma frase. */
  reason: string;
  /** A Articuladora, com o nome de agora. */
  by: { id: string; displayName: string };
  /** Até 2, na ordem dela, cada um com a frase do que cobrir (vazio fora de `delegate`). */
  delegates: { agent: { id: string; displayName: string }; cover: string }[];
}

// ---------- Conta (ADR 0005) ----------

/**
 * O estado da Conta do Claude do Membro, como "Minha Conta" mostra.
 * Só o próprio Membro vê (nem o Admin).
 * - `limited`: "No limite até HH:MM" (`until`); as mensagens dele saem pela Chave ou esperam na fila.
 * - `needs_relink`: "Precisa ligar de novo" (o login caiu); ligar de novo é o mesmo fluxo de ligar.
 */
export type AccountStatusDto =
  | { state: "not_linked" }
  /** `plan` já vem pronto para a tela, ex. "Claude Max". */
  | { state: "linked"; email: string; plan: string }
  | { state: "limited"; email: string; plan: string; until: string }
  | { state: "needs_relink"; email: string; plan: string };

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

// ---------- Presença e push ----------

/**
 * `PUT /api/presence`: qual conversa esta conexão (aba ou PWA) tem aberta e visível agora
 * (aba em foco, ou PWA em primeiro plano), ou `null` quando nenhuma. Enquanto alguma conexão
 * do Membro tem a conversa à vista, o push dela cala. Some quando a conexão cai.
 */
export interface SetPresenceInput {
  connectionId: string;
  conversationId: string | null;
}

/** `GET /api/push/key`: a chave pública VAPID, o `applicationServerKey` do `pushManager.subscribe`. */
export interface PushKeyDto {
  publicKey: string;
}

/**
 * `PUT /api/push/subscriptions/:aparelho`: a inscrição deste aparelho, como o navegador a dá
 * (`PushSubscription.toJSON()`). O aparelho é o id que o PWA gerou para si. Reenviar a mesma
 * inscrição não muda nada; uma nova troca a anterior do aparelho.
 */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * `GET /api/devices`: os aparelhos do Membro em que ele já ligou o push. A lista na tela de
 * Notificações e as faixas de push parado são do #33.
 */
export interface DeviceDto {
  /** O id que o PWA gerou para o aparelho. */
  id: string;
  /** O nome do aparelho na tailnet, quando ela informa. */
  label: string | null;
  /** Tem inscrição de push viva. */
  pushing: boolean;
  /** Quando o push service disse que a inscrição morreu ("parou em DD/MM"). ISO 8601, UTC. */
  pushStoppedAt: string | null;
  /** O último push entregue a ele. ISO 8601, UTC. */
  lastPushAt: string | null;
}

/** Caminho do PWA que abre uma conversa (é o `navigate` da notificação). */
export const conversationPath = (conversationId: string) => `/c/${conversationId}`;
/** A seção Instalação no PWA: é para onde levam os pushes do Admin sobre o backup e a chave do nó. */
export const INSTALLATION_PATH = "/instalacao";

// ---------- eventos do WebSocket ----------

/** Onde o PWA abre o WebSocket de eventos. A identidade é a da requisição de upgrade. */
export const EVENTS_PATH = "/api/events";

/**
 * Código de fechamento do WebSocket quando o servidor vai reiniciar (1012, "service restart"):
 * o dreno de uma atualização. O PWA mostra "Atualizando o Shearim" e reconecta sozinho.
 * Qualquer outro fechamento é queda de conexão ("Reconectando…").
 */
export const EVENTS_CLOSE_UPDATING = 1012;

/**
 * Tudo o que o servidor empurra pelo WebSocket. Cada evento é um JSON com `type`.
 * Comandos continuam no HTTP: o cliente não manda nada por aqui.
 *
 * Novos eventos (Desfecho, Andamento, não-lido, badge, presença, faixas) entram
 * como mais membros desta união, com `type` no formato `assunto.fato`.
 */
export type ServerEvent =
  /**
   * Primeiro evento de toda conexão: daqui em diante, nada publicado se perde. `connectionId`
   * é o desta conexão: a Presença (`PUT /api/presence`) diz qual conversa ela tem à vista.
   */
  | { type: "ready"; me: MeDto; connectionId: string }
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
  | { type: "join_request.decided"; joinRequest: JoinRequestAdminDto }
  /**
   * O Andamento de uma execução mudou (entrou na fila, começou a escrever, terminou, falhou),
   * para quem vê a conversa. Quando termina, a resposta chega antes como `message.created`.
   */
  | { type: "execution.updated"; execution: ExecutionDto }
  /** A Articuladora deu o Desfecho de uma mensagem, para quem vê a conversa. */
  | { type: "outcome.created"; outcome: OutcomeDto }
  /**
   * As não-lidas do Membro mudaram (chegou mensagem numa conversa dele, ou ele leu algo em
   * qualquer aba ou aparelho). Vai só para as conexões do próprio Membro.
   */
  | { type: "unread.updated"; unread: UnreadDto }
  /** O Membro passou a seguir uma Thread. Vai só para as conexões dele. */
  | { type: "thread.followed"; thread: FollowedThreadDto }
  /**
   * O estado da Instalação mudou (backup novo, backup que falhou, 36 h sem backup bom). Só para
   * Admins: é o que acende e apaga a faixa.
   */
  | { type: "installation.updated"; installation: InstallationDto };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

// ---------- erros ----------

export type ApiError =
  | { error: "no_identity"; reason: NoIdentityReason }
  | { error: "not_a_member" }
  /** O tailscaled não respondeu ao `whois` (503): problema da Instalação, não de quem chegou. */
  | { error: "identity_unavailable" }
  /** O servidor está no dreno de uma atualização (503 no upgrade do WebSocket): já vai voltar. */
  | { error: "updating" }
  | { error: "not_admin" }
  /** Mexer no que é do Shearim na Articuladora (descrição, instruções). */
  | { error: "builtin_locked"; message: string }
  | { error: "already_member" }
  | { error: "already_decided"; status: JoinRequestStatus }
  | { error: "not_found" }
  | { error: "conflict"; message: string }
  | { error: "name_taken"; message: string }
  /** O identificador de Menção pedido já é de outra pessoa ou Agente. */
  | { error: "handle_taken"; message: string }
  | { error: "invalid_input"; message: string };
