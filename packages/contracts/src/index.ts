/**
 * Contratos compartilhados entre o servidor e o PWA: DTOs do HTTP.
 * Só tipos (e constantes pequenas). Nada de runtime pesado aqui.
 */

import type { WikiServerEvent } from "./wiki";

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

/** "Faro", "Faro e Prisma", "Faro, Prisma e Lince" (vazio: ""). */
export function joinPt(list: readonly string[]) {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} e ${list.at(-1)}`;
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
  /** O pedido mais recente; `null` se nunca pediu, ou se o aprovado ficou para trás numa remoção. */
  joinRequest: JoinRequestDto | null;
  /** Quando um Admin removeu a pessoa do Workspace (ISO 8601), se foi removida e ainda não voltou. */
  removedAt: string | null;
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
  role: MemberRole;
}

/**
 * Corpo de `PATCH /api/members/:id` (só Admin): torna o Membro Admin ou o rebaixa.
 * Rebaixar o último Admin: 409 `last_admin` (o Workspace sempre tem pelo menos um).
 */
export interface UpdateMemberRoleInput {
  role: MemberRole;
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

export const CHANNEL_KINDS: readonly ChannelKind[] = ["public", "private"];
export const DM_KINDS: readonly DmKind[] = ["dm", "group"];
/** A conversa é um Canal (público ou privado). */
export const isChannelKind = (kind: string): kind is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(kind);
/** A conversa é uma DM (entre duas partes ou em grupo). */
export const isDmKind = (kind: string): kind is DmKind => (DM_KINDS as readonly string[]).includes(kind);

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
  | {
      kind: "member";
      id: string;
      displayName: string;
      profilePicUrl: string | null;
      /** Um Admin removeu a pessoa: a mensagem mostra "saiu do Workspace". Volta a `false` se ela voltar. */
      leftWorkspace: boolean;
    }
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
  /**
   * Só na cópia do autor da mensagem de origem, na resposta paga pela Chave: o porquê ligado à
   * Conta dele ao lado de "⚠ pela Chave do Workspace" (o estado dela quando a Chave passou a
   * pagar, que fica com a resposta). Ausente para os outros e quando a Conta não explica nada.
   */
  yourAccount?: YourAccountDto;
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
  /**
   * O badge do ícone: a soma de todas as não-lidas das conversas do Membro e dos Pedidos de
   * aprovação que esperam a decisão dele.
   */
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
  /** As Ferramentas concedidas a ele, na ordem do catálogo, para todo Membro (Spec #44). */
  tools: AgentToolSummaryDto[];
  /**
   * As linhas geradas da descrição pública, sobre o que ele alcança fora do Workspace (uma por
   * Conector com credencial do Workspace, e uma pelo GitHub, com os repositórios da lista dele):
   * "acessa CRM com a credencial do Workspace".
   */
  reach: string[];
  /**
   * A Memória do Agente ligada, para todo Membro (spec #60, #67). Vem ligada, inclusive na
   * Articuladora; só o Admin muda. Desligada, ele não guarda nem lê Memória.
   */
  memoryEnabled: boolean;
  instructions?: string;
  /** Só para o Admin: os repositórios do GitHub a que o Agente está restrito (nulo: todos os da instalação). */
  githubRepositories?: string[] | null;
  /**
   * Só para o Admin: o orçamento mensal na Chave, em dólares (nulo: sem teto). Conta só o que a
   * Chave pagou; a Conta de cada Membro não entra.
   */
  monthlyBudgetUsd?: number | null;
  /** Só para o Admin: quanto o Agente gastou na Chave no mês corrente (UTC), em dólares. */
  keySpendUsd?: number;
  /**
   * Só para o Admin: o gasto do mês chegou ao orçamento. O Agente deixa de usar a Chave ("Agentes
   * não agem" para quem não tem Conta) e os Admins veem a faixa.
   */
  overBudget?: boolean;
}

/** Corpo de `POST /api/agents` (só Admin). O nome não se repete (sem diferença de maiúsculas). */
export interface CreateAgentInput {
  name: string;
  photo?: string | null;
  description?: string;
  instructions?: string;
  model: AgentModel;
  /** Orçamento mensal na Chave, em dólares (`>= 0`); ausente ou nulo: sem teto. */
  monthlyBudgetUsd?: number | null;
}

/**
 * Corpo de `PATCH /api/agents/:id` (só Admin). Campo ausente fica. Da Articuladora (`builtin`),
 * só `name`, `photo`, `model`, `monthlyBudgetUsd` e `memoryEnabled`: `description` e
 * `instructions` dão `403 builtin_locked`. Trocar o nome troca o identificador de Menção (`handle`).
 */
export type UpdateAgentInput = Partial<CreateAgentInput> & {
  /** Liga ou desliga a Memória do Agente (#67). */
  memoryEnabled?: boolean;
};

// ---------- GitHub, o Conector embutido (ADR 0010) ----------

/**
 * O GitHub do Workspace, só para o Admin (`GET /api/github`):
 * - `none`: nenhum GitHub App criado ("Criar o GitHub App");
 * - `created`: o App existe, falta instalar na conta do time ("Instalar no GitHub");
 * - `installed`: instalado; as Ferramentas do GitHub alcançam os repositórios escolhidos lá.
 *
 * `failure` é a instalação que o GitHub deixou de reconhecer (removida ou suspensa lá), vista na
 * última chamada de uma Ferramenta: as Ferramentas falham com motivo até o Admin instalar de novo.
 * Os segredos do App nunca voltam.
 */
export interface GitHubDto {
  state: "none" | "created" | "installed";
  app: { name: string; slug: string; owner: string; htmlUrl: string } | null;
  installation: { id: number; account: string; installedAt: string } | null;
  failure: { reason: string; at: string } | null;
}

/** Corpo de `POST /api/github/manifest`: o endereço da Instalação e, opcional, a organização dona do App. */
export interface StartGitHubManifestInput {
  /** O `location.origin` do PWA: para onde o GitHub manda o navegador de volta. */
  origin: string;
  /** A organização do time no GitHub; sem ela, o App fica na conta pessoal de quem cria. */
  organization?: string;
}

/** O formulário que o PWA envia ao GitHub (`POST action`, campo `manifest`). */
export interface GitHubManifestDto {
  action: string;
  manifest: string;
}

/** `POST /api/github/installation`: a página do GitHub onde o Admin instala o App e escolhe os repositórios. */
export interface GitHubInstallDto {
  url: string;
}

/**
 * `GET /api/agents/:id/github` (só Admin): os repositórios do Agente na tela dele. `repositories`
 * é a lista dele (nula: alcança tudo o que a instalação alcança); `available`, os que a instalação
 * alcança agora (`dono/nome`), para escolher; `failure`, por que não deu para perguntar ao GitHub.
 */
export interface AgentGitHubDto {
  repositories: string[] | null;
  available: string[];
  failure: string | null;
}

/** Corpo de `PUT /api/agents/:id/github`: a lista nova (nula: sem lista, todos os da instalação). */
export interface SetAgentGitHubInput {
  repositories: string[] | null;
}

// ---------- Ferramentas (Spec #44) ----------

/**
 * De onde vem uma Ferramenta: o próprio Workspace, a web, o GitHub (o Conector embutido, ADR 0010)
 * ou um Conector MCP (com o Conector dela em `connector`).
 */
export type ToolOrigin = "workspace" | "web" | "github" | "connector";
/** `read` só lê; `write` escreve, e toda escrita passa por um Pedido de aprovação. */
export type ToolAccess = "read" | "write";

/**
 * Uma Ferramenta concedida a um Agente, como todo Membro a vê na lista de Agentes
 * (`AgentDto.tools`): o nome e a origem. As concessões só o Admin edita.
 */
export interface AgentToolSummaryDto {
  /** O id estável da Ferramenta (ex. `listar_agentes`). */
  id: string;
  /** O nome em pt-BR ("listar Agentes"). */
  title: string;
  origin: ToolOrigin;
  /** Só nas de um Conector (`origin: "connector"`): qual, e de quem é a credencial. */
  connector?: ToolConnectorDto;
}

/** O Conector de uma Ferramenta, como a lista de Agentes e a tela do Agente o mostram. */
export interface ToolConnectorDto {
  id: string;
  name: string;
  /** De quem é a credencial que a Ferramenta usa: do Workspace (uma só para todos) ou do autor. */
  credential: ConnectorCredentialMode;
}

/**
 * De quem é a credencial de um Conector: do Workspace (uma só, colada pelo Admin) ou de cada
 * Membro (`member`: cada um liga a sua em Perfil › Conectores, e a resposta usa a do autor).
 */
export type ConnectorCredentialMode = "workspace" | "member";

/**
 * Um Conector (Spec #44): a ligação do Workspace a um servidor MCP remoto, adicionada pelo Admin.
 * `GET /api/connectors`, `GET /api/connectors/:id` (relê o catálogo), `POST /api/connectors`
 * (`CreateConnectorInput`), `PUT /api/connectors/:id/credential` (`{ token }`) e
 * `DELETE /api/connectors/:id`, todos só do Admin. O token nunca volta.
 */
export interface ConnectorDto {
  id: string;
  name: string;
  /** O endereço do servidor MCP (streamable HTTP). */
  url: string;
  credential: ConnectorCredentialMode;
  /**
   * `refused`: o servidor recusou a credencial do Workspace (401) numa chamada; o Admin cola outra.
   * No modo de cada Membro é sempre `ok` (a recusa é da credencial de cada um, no Perfil dele).
   */
  credentialState: "ok" | "refused";
  /** Quando a credencial foi recusada (ISO 8601), ou `null`. */
  refusedAt: string | null;
  /** O catálogo do `tools/list`, na ordem do servidor. */
  tools: ConnectorToolDto[];
  /** Ao reler o catálogo (`GET /api/connectors/:id`): por que não deu (o catálogo é o último lido). */
  catalogError: string | null;
}

/** Uma Ferramenta do catálogo de um Conector. Só o que o servidor marca como "só leitura" é `read`. */
export interface ConnectorToolDto {
  /** O id da Ferramenta no Shearim (o que se concede e o que o modelo recebe), ex. `crm__buscar_cliente`. */
  id: string;
  /** O nome dela no servidor. */
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
}

/**
 * Corpo de `POST /api/connectors`: o nome (não se repete), o endereço, o modo da credencial
 * (padrão: do Workspace) e um token, que lê o catálogo. No modo do Workspace, ele é a credencial
 * do Workspace; no de cada Membro, vira a credencial do próprio Admin (que a desliga no Perfil).
 */
export interface CreateConnectorInput {
  name: string;
  url: string;
  token: string;
  credential?: ConnectorCredentialMode;
}

/**
 * Ligar um Conector pelo login do próprio servidor MCP (OAuth, #56), quando ele oferece. O PWA
 * manda o endereço da Instalação na tailnet (`origin`, o `location.origin` dele): é para lá que o
 * servidor de autorização devolve o navegador (`${origin}${CONNECTOR_LOGIN_CALLBACK_PATH}`), e o
 * retorno grava a credencial e leva de volta à tela de onde saiu, com `?conector=ligado` ou
 * `?erro=<motivo>`.
 *
 * - `POST /api/connectors/login` (Admin, `CreateConnectorLoginInput`): adicionar pelo login; o
 *   Conector só existe depois do retorno (o login do Admin lê o catálogo). Volta a `CONNECTORS_PATH`.
 * - `POST /api/connectors/:id/credential/login` (Admin, `{ origin }`): religar a credencial do
 *   Workspace (`409 member_credential` no modo de cada Membro). Volta a `CONNECTORS_PATH`.
 * - `POST /api/me/connectors/:id/credential/login` (`{ origin }`): o Membro liga a dele. Volta a
 *   `MY_CONNECTORS_PATH`.
 *
 * Respondem `ConnectorLoginDto`; `422 oauth_unavailable` quando o servidor não oferece login
 * (cole um token), `422 connector_unreachable` quando ele não responde. A credencial do login se
 * renova sozinha antes de vencer; a renovação recusada é a credencial recusada.
 */
export interface CreateConnectorLoginInput {
  name: string;
  url: string;
  credential?: ConnectorCredentialMode;
  origin: string;
}

export interface StartConnectorLoginInput {
  origin: string;
}

/** Para onde o navegador vai fazer o login (o `authorization_endpoint` do servidor, com PKCE). */
export interface ConnectorLoginDto {
  authorizationUrl: string;
}

/**
 * Um Conector com credencial de cada Membro, em Perfil › Conectores (`MY_CONNECTORS_PATH`), como o
 * próprio Membro o vê: `GET /api/me/connectors`; ligar com `PUT /api/me/connectors/:id/credential`
 * (`{ token }`, `422 credential_refused` se o servidor o recusa) e desligar com `DELETE` no mesmo
 * caminho. O token nunca volta. Vai também no evento `my_connector.updated`, só ao Membro.
 */
export interface MyConnectorDto {
  id: string;
  name: string;
  url: string;
  /** `off`: não ligou; `ok`: ligada; `refused`: o servidor recusou (401) numa chamada, ligue de novo. */
  credentialState: "off" | "ok" | "refused";
  /** Quando foi recusada (ISO 8601), ou `null`. */
  refusedAt: string | null;
}

/**
 * Uma Ferramenta do Workspace na tela do Agente (só Admin): `GET /api/agents/:id/tools`, e a
 * resposta de `PUT`/`DELETE /api/agents/:id/tools/:toolId` (conceder, retirar).
 */
export interface AgentToolDto {
  /** O id estável da Ferramenta (ex. `listar_agentes`), o mesmo nome que o modelo recebe. */
  id: string;
  /** O nome em pt-BR, como o Admin e o Andamento o mostram ("listar Agentes"). */
  title: string;
  description: string;
  origin: ToolOrigin;
  access: ToolAccess;
  granted: boolean;
  /** Só nas de um Conector: qual, e de quem é a credencial. */
  connector?: ToolConnectorDto;
}

/**
 * Um uso de Ferramenta no Andamento: `running` enquanto roda ("listando os Agentes"), `done`, ou
 * `failed` com o motivo ("listar Agentes falhou: não terminou em 60 s"). A resposta segue sem ela.
 */
export interface ToolCallDto {
  id: string;
  /** O id da Ferramenta. */
  tool: string;
  /** O nome em pt-BR ("listar Agentes"). */
  title: string;
  /** O que ela está fazendo, para o passo em andamento ("listando os Agentes"). */
  label: string;
  state: "running" | "done" | "failed";
  /** Em `failed`: o motivo, em pt-BR. */
  reason: string | null;
  /** Quando começou (ISO 8601). */
  startedAt: string;
  /**
   * Em `done`, numa Ferramenta de Conector com a credencial de cada Membro: de quem foi a
   * credencial, para todos ("usou o CRM de Ana").
   */
  used?: string;
  /**
   * Só na cópia do autor, numa Ferramenta indisponível porque ele não ligou (ou teve recusada) a
   * credencial dele: o atalho "Ligar <Conector>" (Perfil › Conectores).
   */
  connect?: { connectorId: string; name: string };
}

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
  /** O incidente da Chave aberto agora, ou `null`. */
  incident: KeyIncidentDto | null;
}

/**
 * Um incidente da Chave (Spec, módulo 9): a Anthropic recusou a Chave (`auth_failed`) ou ela
 * está sem crédito (`billing_failed`). Um por vez: abre na primeira recusa e termina na primeira
 * chamada bem-sucedida pela Chave. Os Admins veem a faixa enquanto está aberto.
 */
export interface KeyIncidentDto {
  id: string;
  kind: "auth_failed" | "billing_failed";
  /** Quando abriu (ISO 8601). */
  openedAt: string;
}

/** O orçamento de um Agente como o Admin o vê (`agent_budget.updated`): os mesmos campos do `AgentDto`. */
export interface AgentBudgetDto {
  agentId: string;
  name: string;
  monthlyBudgetUsd: number | null;
  keySpendUsd: number;
  overBudget: boolean;
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
 * agem", com o motivo; não é falha), `cancelled` (sem motivo: "cancelada por quem escreveu"; com
 * motivo, cancelada pelo Shearim, ex. "quem escreveu saiu do Workspace") e `awaiting_approval`
 * (o Pedido de aprovação espera o autor).
 */
export type ExecutionState =
  | "queued"
  | "running"
  | "retrying"
  | "done"
  | "failed"
  | "not_acting"
  | "cancelled"
  /**
   * O Agente pediu uma escrita (ADR 0011): a execução criou o Pedido de aprovação e terminou, sem
   * ocupar vaga, "esperando aprovação de <autor>". Na decisão, vira `done` e uma execução de
   * continuação entra na fila para terminar a resposta.
   */
  | "awaiting_approval";
/**
 * Os estados em que a execução ainda não terminou: o autor pode cancelar. Esperando aprovação
 * conta como aberta: cancelar a mensagem cancela o Pedido de aprovação junto.
 */
export const OPEN_STATES: readonly ExecutionState[] = ["queued", "running", "retrying", "awaiting_approval"];

/**
 * O passo de uma execução em andamento. `writing` é a bolha "escrevendo"; `deciding` é o
 * roteamento da Articuladora ("Sophya decidindo quem responde"); `tool` é uma Ferramenta rodando
 * (o rótulo dela, "listando os Agentes", está no último item de `ExecutionDto.tools`);
 * `remembering` é a extração da Memória lendo a troca (não aparece no Andamento).
 */
export type ExecutionStep = "deciding" | "writing" | "tool" | "remembering";

/**
 * O Andamento de uma execução, como todos que veem a conversa o veem.
 * Item de `GET /api/channels/:id/executions` (as que ainda não viraram resposta)
 * e de `execution.updated`.
 */
/**
 * Por que a execução existe: `mention` (Menção), `dm` (o Agente de uma DM com Agente), `route` (o
 * roteamento da Articuladora: "Sophya decidindo quem responde"), `reply` (ela responde),
 * `delegated` (um Agente a quem ela passou a mensagem) ou `memory` (a extração da Memória, depois
 * de entregue a resposta do Agente: ADR 0013). A extração só aparece no Andamento quando não
 * guardou (`failed`, `not_acting`); o que ela guardou chega como `memory.updated`.
 */
export type ExecutionKind = "mention" | "dm" | "route" | "reply" | "delegated" | "memory";

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
   * Motivo da falha (em `retrying` e `failed`), de "Agentes não agem" ou do cancelamento que não foi
   * de quem escreveu (`cancelled`, ex. "quem escreveu saiu do Workspace"), em pt-BR, para completar
   * a frase "Faro não respondeu: …". Na extração da Memória (`memory`) em `done`, o que ela
   * devolveu e não foi guardado ("não guardou na Memória: …"), nulo quando guardou tudo. Nulo nos
   * outros estados e no cancelamento por quem escreveu.
   * Quando o motivo é estado da Conta do autor (ex. "a sua Conta do Claude não pode ser usada
   * agora"), só a cópia do autor o traz; os outros veem um motivo que não fala da Conta.
   */
  reason: string | null;
  /**
   * "⏸ na fila": a execução (em `queued`) espera quem pague por ela (a Conta do autor no limite ou
   * em "Precisa ligar de novo", sem Chave utilizável). Todos veem; o porquê e a hora da volta só o
   * autor vê, em `yourAccount`. Não segura as outras mensagens da fila.
   */
  held: boolean;
  /**
   * "esperando a vez" (Spec, módulo 6, Ordem e Tetos): pronta para sair (em `queued`, ou em
   * `retrying` com a hora vencida), mas o trabalhador ainda não pôde pô-la para rodar, porque o
   * mesmo Agente responde antes a outra mensagem da conversa ou porque o teto de quem paga está
   * cheio (2 respostas por Conta, 4 na Chave, 8 processos no host). Todos veem.
   */
  waitingTurn: boolean;
  /**
   * Só na cópia do autor da mensagem de origem (os outros recebem nulo): o motivo ligado à Conta
   * dele, quando ela explica a fila, a Chave pagando ou "Agentes não agem". Nulo quando a Conta
   * não tem nada a ver com o que se vê.
   */
  yourAccount: YourAccountDto | null;
  replyMessageId: string | null;
  /**
   * Os usos de Ferramenta da tentativa atual, na ordem: o que está rodando e os que falharam ficam
   * à vista (a resposta segue sem a Ferramenta que falhou). Vazio sem Ferramentas.
   */
  tools: ToolCallDto[];
  /**
   * "parou no limite de Ferramentas": a tentativa atual chegou ao teto de turnos de Ferramenta e o
   * Agente responde com o que tem, numa última chamada sem Ferramentas (#53).
   */
  toolLimit: boolean;
}

// ---------- Memória (spec #60) ----------

/**
 * O escopo de um item de Memória: `conversation` (a Memória da Conversa: os fatos e as decisões
 * de um Canal ou DM, com as Threads), `agent` (a Memória do Agente) ou `workspace`.
 */
export type MemoryScope = "workspace" | "conversation" | "agent";

/**
 * Um item de Memória, como quem vê a conversa de origem o vê (ADR 0012). Item de
 * `GET /api/conversations/:id/memory`, de `GET /api/agents/:id/memory` e de `memory.updated`.
 */
export interface MemoryItemDto {
  id: string;
  scope: MemoryScope;
  /** A conversa de origem. Nula só no item que um Admin escreveu direto na Memória do Workspace. */
  conversationId: string | null;
  /**
   * A mensagem de origem: a mensagem de pessoa da troca que gerou o item, com a Thread dela e um
   * trecho, para a lista mostrar de onde veio e saltar até ela. Nula como `conversationId`.
   */
  origin: { messageId: string; threadRootId: string | null; author: string; excerpt: string } | null;
  /**
   * Na Memória do Agente (`scope: "agent"`): de quem é a lição (o Andamento mostra "guardou na
   * Memória de Faro: …"). Nulo nos outros escopos.
   */
  agent: { id: string; name: string } | null;
  text: string;
  /**
   * Quem guardou: a extração (o Shearim, ao fim da resposta de um Agente: o Andamento da mensagem
   * de origem mostra "guardou na Memória: …"), um Membro ou um Admin.
   */
  createdBy: "extraction" | "member" | "admin";
  /** `archived`: desfeito ou substituído por `replacedById`. Nada é apagado. */
  state: "active" | "archived";
  replacedById: string | null;
  createdAt: string;
  archivedAt: string | null;
}

/**
 * O estado da Conta do autor que explica o Andamento, só para ele:
 * - `limited`: no limite até `until` ("⏸ na fila até qui., 15:45", "· sua Conta no limite até 18:00");
 * - `needs_relink`: "Precisa ligar de novo" ("⏸ na fila até você ligar sua Conta de novo");
 * - `not_linked`: ele não ligou uma Conta ("Agentes não agem: você não ligou uma Conta e …").
 */
export type YourAccountDto = { state: "limited"; until: string } | { state: "needs_relink" } | { state: "not_linked" };

// ---------- Habilidades (spec #74) ----------

/** De onde veio a Habilidade: escrita na tela (`written`) ou importada de um `SKILL.md` (`imported`). */
export type SkillOrigin = "written" | "imported";

/** Tamanho máximo do nome e da descrição de uma Habilidade, em caracteres: entram no catálogo de toda resposta. */
export const SKILL_NAME_MAX = 80;
export const SKILL_DESCRIPTION_MAX = 500;
/** Tamanho máximo do corpo de uma Habilidade, em caracteres: ele vai inteiro ao modelo quando carregado. */
export const SKILL_BODY_MAX = 100_000;

/**
 * Uma Habilidade (só Admin): `GET /api/skills`, `GET`/`PATCH /api/skills/:id` e a resposta de
 * `POST /api/skills`. `agents` são os Agentes em que ela está ativa (o impacto de editar ou apagar).
 */
export interface SkillDto {
  id: string;
  name: string;
  /** Diz quando usar: é o que o Agente vê no catálogo. */
  description: string;
  /** O procedimento em markdown: o Agente o carrega pela Ferramenta "carregar Habilidade". */
  body: string;
  origin: SkillOrigin;
  agents: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/skills` (só Admin). */
export interface CreateSkillInput {
  name: string;
  description: string;
  body: string;
}

/** `PATCH /api/skills/:id` (só Admin): campo ausente fica. */
export type UpdateSkillInput = Partial<CreateSkillInput>;

/**
 * Uma Habilidade na tela do Agente (só Admin), com a marca de ativa nele: `GET
 * /api/agents/:id/skills` e a resposta de `PUT`/`DELETE /api/agents/:id/skills/:skillId`.
 */
export interface AgentSkillDto {
  id: string;
  name: string;
  description: string;
  active: boolean;
  /**
   * Uma Habilidade do Shearim, e não do Workspace ("Sincronizar a Wiki", na Articuladora): sempre
   * ativa, só para leitura (não se ativa, desativa nem edita).
   */
  builtin?: true;
}

// ---------- Pedido de aprovação (ADR 0011) ----------

/**
 * Em que pé está um Pedido de aprovação: `pending` (o autor decide), `approved` (o Shearim fez a
 * escrita, ou ela falhou: `failure`), `rejected` (com o motivo opcional), `expired` (24 h sem
 * decisão) ou `cancelled` (a mensagem foi cancelada).
 */
export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "cancelled";

/**
 * Um Pedido de aprovação: a escrita que um Agente pediu durante uma resposta, à vista de todos que
 * veem a conversa, ancorada sob a mensagem de origem. Só o autor (`author`) aprova ou recusa, sem
 * editar. Item de `GET /api/conversations/:id/approvals` e de `approval.created`/`approval.updated`.
 */
export interface ApprovalRequestDto {
  id: string;
  channelId: string;
  originMessageId: string;
  /** A execução que pediu a escrita. */
  executionId: string;
  agent: { id: string; displayName: string; photo: string | null };
  /** O autor da mensagem de origem: o único que decide. */
  author: { id: string; displayName: string };
  /** A Ferramenta de escrita (id e nome em pt-BR). */
  tool: string;
  toolTitle: string;
  /** Exatamente o que vai ser feito, em pt-BR ("Postar em #anuncios: “…”"). */
  summary: string;
  state: ApprovalState;
  /** Na recusa: o motivo que o autor deu, ou nulo. */
  rejectReason: string | null;
  /** Na aprovação: o resultado da ação ("mensagem postada em #anuncios"). */
  result: string | null;
  /** Na aprovação: o motivo de a ação ter falhado (ex. o autor perdeu o acesso), ou nulo. */
  failure: string | null;
  /**
   * Na aprovação: a ação pode ter sido feita sem o Shearim saber (não terminou no prazo, o servidor
   * reiniciou no meio). `failure` diz por quê e onde conferir; o cartão diz "resultado incerto".
   */
  uncertain: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/** Corpo de `POST /api/conversations/:id/approvals/:approvalId/reject`. */
export interface RejectApprovalInput {
  reason?: string;
}

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
  /**
   * `plan` já vem pronto para a tela, ex. "Claude Max". `extraUsage`: "usando uso extra" (a última
   * execução passou do plano com o uso extra ligado).
   */
  | { state: "linked"; email: string; plan: string; validity: AccountValidityDto | null; extraUsage: boolean }
  | { state: "limited"; email: string; plan: string; until: string; validity: AccountValidityDto | null }
  | { state: "needs_relink"; email: string; plan: string };

/**
 * A validade do login da Conta (ADR 0005). `until` é a data mais cedo em que ele pode cair: o
 * `loginExpiresAt` do `claude auth status` (ou o `credential_expires_at` de uma execução, se vier
 * antes) menos 3 dias. "Minha Conta" mostra "vale até DD/MM".
 * - `ok`: faltam mais de 3 dias.
 * - `soon`: faltam 3 dias ou menos: o selo no menu pessoal e a linha da Conta em destaque.
 * - `any_time`: passou de `until`: "pode vencer a qualquer momento".
 *
 * `afterwards` diz o que acontece depois do vencimento: as mensagens seguem pela Chave do
 * Workspace (`key`) ou, sem ela, esperam na fila até ligar de novo (`queue`).
 */
export interface AccountValidityDto {
  until: string;
  state: "ok" | "soon" | "any_time";
  afterwards: "key" | "queue";
}

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
 * `GET /api/devices`: os aparelhos do Membro em que ele já ligou o push, na ordem em que foram
 * ligados. É a lista da tela de Notificações e a base das faixas de push parado; `DELETE
 * /api/devices/:id` remove um. Mudanças chegam em `devices.updated`.
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
/**
 * O inverso de `conversationPath`: o padrão do caminho de uma conversa. O `public/sw.js` do PWA,
 * que é JavaScript sem bundler, repete este padrão; um teste confere que é o mesmo.
 */
export const CONVERSATION_PATH_PATTERN = /^\/c\/([0-9a-f-]{36})$/i;
/** A conversa que o caminho abre (`/c/<id>`), ou `null`. */
export const conversationOfPath = (pathname: string) => CONVERSATION_PATH_PATTERN.exec(pathname)?.[1] ?? null;
/**
 * A mensagem que o service worker manda à janela aberta quando a pessoa toca numa notificação:
 * `{ type: SW_NAVIGATE_MESSAGE, navigate }` (o `sw.js` repete o texto; um teste confere).
 */
export const SW_NAVIGATE_MESSAGE = "navigate";
/**
 * Caminho do PWA que abre uma conversa já numa mensagem (ela vem para o meio da tela e pisca): é
 * para onde leva o push da falha, que fica sob a mensagem com o "Tentar de novo".
 */
export const messagePath = (conversationId: string, messageId: string) =>
  `${conversationPath(conversationId)}?m=${messageId}`;
/** A seção Instalação no PWA: é para onde levam os pushes do Admin sobre o backup e a chave do nó. */
export const INSTALLATION_PATH = "/instalacao";
/** A seção Membros (o Admin decide os Pedidos de entrada): para onde leva o push de cada pedido. */
export const MEMBERS_PATH = "/membros";
/** O GitHub do Workspace (ADR 0010): para onde voltam os retornos do manifest e da instalação. */
export const GITHUB_PATH = "/github";
/** A Chave do Workspace: para onde leva o push do incidente da Chave. */
export const WORKSPACE_KEY_PATH = "/chave";
/** Os Agentes (orçamento e gasto): para onde leva o push do estouro de orçamento. */
export const AGENTS_PATH = "/agentes";
/** "Minha Conta": para onde levam os pushes da Conta (queda, assinatura repetida). */
export const ACCOUNT_PATH = "/conta";
/** Perfil › Conectores: onde o Membro liga as credenciais dele (e para onde leva o push da recusa). */
export const MY_CONNECTORS_PATH = "/perfil/conectores";
/** Os Conectores (só Admin): para onde volta o login de um Conector com a credencial do Workspace. */
export const CONNECTORS_PATH = "/conectores";
/** Onde o servidor de autorização de um Conector devolve o navegador depois do login (OAuth, #56). */
export const CONNECTOR_LOGIN_CALLBACK_PATH = "/api/connector-login/callback";

// ---------- eventos do WebSocket ----------

/** Onde o PWA abre o WebSocket de eventos. A identidade é a da requisição de upgrade. */
export const EVENTS_PATH = "/api/events";

/**
 * Código com que o servidor fecha as conexões de quem foi removido do Workspace, logo depois
 * do `member.removed`. Reabrir dá 403: a pessoa volta só pelo Pedido de entrada.
 */
export const MEMBER_REMOVED_CLOSE_CODE = 4403;

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
  /** A credencial do Membro num Conector mudou (ligada, desligada, recusada). Só para ele. */
  | { type: "my_connector.updated"; connector: MyConnectorDto }
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
  /**
   * Um Admin removeu o Membro: ele "saiu do Workspace". Para todo Membro, inclusive o removido,
   * cujas conexões fecham em seguida (`MEMBER_REMOVED_CLOSE_CODE`). As mensagens dele passam a
   * mostrar a marca (`leftWorkspace`).
   */
  | { type: "member.removed"; memberId: string }
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
  /**
   * Um item de Memória foi criado ou mudou (arquivado, substituído), para quem vê a conversa de
   * origem (ADR 0012). O cliente trata como "insere ou troca pelo `id`".
   */
  | { type: "memory.updated"; item: MemoryItemDto }
  /**
   * O Admin apagou um Agente (#65), para todos: ele sai das listas e dos Canais, e a Memória do
   * Agente dele sai junto (o cliente tira os itens com `agent.id` igual). A Memória da Conversa que
   * ele gerou e as mensagens dele ficam.
   */
  | { type: "agent.deleted"; agentId: string }
  /** A Articuladora deu o Desfecho de uma mensagem, para quem vê a conversa. */
  | { type: "outcome.created"; outcome: OutcomeDto }
  /** Um Pedido de aprovação novo, ou que mudou de estado: para quem vê a conversa. */
  | { type: "approval.created"; approval: ApprovalRequestDto }
  | { type: "approval.updated"; approval: ApprovalRequestDto }
  /** A Sincronização e a Wiki (spec #74), para quem vê a Wiki. */
  | WikiServerEvent
  /**
   * As não-lidas do Membro mudaram (chegou mensagem numa conversa dele, ou ele leu algo em
   * qualquer aba ou aparelho). Vai só para as conexões do próprio Membro.
   */
  | { type: "unread.updated"; unread: UnreadDto }
  /**
   * Os aparelhos do Membro mudaram: um parou de receber push (404/410 do push service), ligou o
   * push de novo, passou a ser de outra pessoa ou foi removido. A lista inteira, como em
   * `GET /api/devices` (o último push entregue não gera evento). Só para as conexões do próprio
   * Membro: é o que faz as faixas de push parado aparecerem e sumirem em todo aparelho.
   */
  | { type: "devices.updated"; devices: DeviceDto[] }
  /** O Membro passou a seguir uma Thread. Vai só para as conexões dele. */
  | { type: "thread.followed"; thread: FollowedThreadDto }
  /**
   * O incidente da Chave abriu (`incident`) ou terminou (`null`, na primeira chamada bem-sucedida).
   * Só para Admins: é a faixa "a Chave do Workspace foi recusada / está sem crédito".
   */
  | { type: "key_incident.updated"; incident: KeyIncidentDto | null }
  /**
   * O gasto de um Agente na Chave ou o orçamento dele mudou. Só para Admins: acompanha o gasto na
   * tela de Agentes e faz a faixa de orçamento estourado aparecer e sumir.
   */
  | { type: "agent_budget.updated"; budget: AgentBudgetDto }
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
  | { error: "invalid_input"; message: string }
  /** Rebaixar ou remover o último Admin: o Workspace sempre tem pelo menos um. */
  | { error: "last_admin"; message: string }
  /** Ninguém sai do Workspace sozinho: só outro Admin remove. */
  | { error: "cannot_remove_self"; message: string };

// ---------- Wiki (spec #74) ----------

export * from "./wiki";
