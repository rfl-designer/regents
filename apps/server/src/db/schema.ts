import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ADR 0001: uma Instalação, um Workspace. Nenhuma tabela tem `org_id`.
// Toda hora gravada vem do Clock injetado (nada de defaultNow em caminho testado).

export const memberRole = pgEnum("member_role", ["admin", "member"]);

export const members = pgTable("members", {
  id: uuid().primaryKey(),
  /** `UserProfile.ID` da tailnet, como texto. É a chave do Membro (ADR 0007). */
  tailnetUserId: text().notNull().unique(),
  login: text().notNull(),
  /** Vem da tailnet na primeira entrada; depois é do Membro (a tailnet não sobrescreve). */
  displayName: text().notNull(),
  /** Foto da tailnet na primeira entrada (`UserProfile.ProfilePicURL`); pode não ter. */
  profilePicUrl: text(),
  /** "Sobre mim", opcional: entra no "quem é quem" do contexto dos Agentes. */
  about: text().notNull().default(""),
  role: memberRole().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * O espaço de nomes dos identificadores de Menção, um só para Membros e Agentes (módulo 2).
 * O identificador é a chave: dois participantes nunca têm o mesmo, sejam de que espécie forem.
 * Cada linha tem um dono só: um Membro ou um Agente. Quem mexe aqui é `mention-handles.ts`.
 */
export const mentionHandles = pgTable(
  "mention_handles",
  {
    /** Minúsculo, sem acento, só `[a-z0-9_]`, sem o `@`. */
    handle: text().primaryKey(),
    memberId: uuid()
      .unique()
      .references(() => members.id),
    agentId: uuid()
      .unique()
      .references((): AnyPgColumn => agents.id),
  },
  (t) => [check("mention_handles_one_owner", sql`num_nonnulls(${t.memberId}, ${t.agentId}) = 1`)],
);

/** `public`/`private`: Canais. `dm`/`group`: DMs (#18). Ver `ConversationKind` nos contratos. */
export const channelKind = pgEnum("channel_kind", ["public", "private", "dm", "group"]);

/**
 * Toda conversa: Canais e DMs. Um id só para mensagens, participantes, Threads, não-lido e push.
 * O nome da tabela vem de antes das DMs; no código, `Conversation` (participation.ts).
 * Uma DM não tem nome; as Instruções ficam vazias e o N fica em 30 (o Admin só edita Canais).
 */
export const channels = pgTable(
  "channels",
  {
    id: uuid().primaryKey(),
    /** Nome do Canal, único. Vazio (null) numa DM. */
    name: text().unique(),
    kind: channelKind().notNull(),
    /** Instruções do Canal: entram no contexto de todo Agente que fala ali. Só o Admin edita. */
    instructions: text().notNull().default(""),
    /** N: quantas mensagens recentes os Agentes da conversa recebem (aceita 0). Só o Admin edita, só em Canal. */
    recentMessages: integer().notNull().default(30),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [check("channels_name_only_in_channels", sql`(${t.kind} in ('public', 'private')) = (${t.name} is not null)`)],
);

/**
 * Pessoas que participam de uma conversa (entraram num Canal público, foram adicionadas a um
 * privado, ou estão numa DM). Numa conversa fechada (privado, DM), é quem a vê e recebe os
 * eventos dela; num público, todo Membro vê.
 * Os Agentes de um Canal ficam ao lado, em `channel_agents`.
 */
export const channelParticipants = pgTable(
  "channel_participants",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    joinedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.memberId] }), index().on(t.memberId)],
);

/**
 * Agentes do Workspace. Só o Admin cria. A descrição é pública; as instruções dizem como ele age.
 * O nome não se repete (sem diferença de maiúsculas). A Menção casa com o identificador dele,
 * em `mention_handles` (gerado do nome na criação, no mesmo espaço de nomes dos Membros).
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    /** `data:` URL de imagem, ou nula. */
    photo: text(),
    description: text().notNull().default(""),
    instructions: text().notNull().default(""),
    model: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * A marca de embutida: a Articuladora (ADR 0004), uma só, criada pela migração `0009`.
     * A descrição e as instruções dela vêm do código (`articuladora.ts`), não destas colunas.
     */
    builtin: boolean().notNull().default(false),
  },
  (t) => [
    uniqueIndex("agents_name_lower_unique").on(sql`lower(${t.name})`),
    uniqueIndex("agents_one_builtin").on(t.builtin).where(sql`${t.builtin}`),
  ],
);

/** Agentes num Canal: a quem a Articuladora pode delegar ali. Ela própria está em todo Canal. */
export const channelAgents = pgTable(
  "channel_agents",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    addedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.agentId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey(),
    /** Ordem de gravação; desempata mensagens com a mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    /** Quem escreveu: uma pessoa ou um Agente, nunca os dois. */
    authorMemberId: uuid().references(() => members.id),
    authorAgentId: uuid().references(() => agents.id),
    /** Na resposta ancorada de um Agente: a mensagem que a gerou. */
    originMessageId: uuid().references((): AnyPgColumn => messages.id),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index().on(t.channelId, t.seq),
    check("messages_um_autor", sql`num_nonnulls(${t.authorMemberId}, ${t.authorAgentId}) = 1`),
  ],
);

/**
 * Leitura (Spec, módulo 10): quais mensagens cada Membro já viu. É um conjunto, não um cursor:
 * a resposta ancorada entra acima de mensagens mais novas, e um cursor de tempo não daria conta.
 */
export const messageReads = pgTable(
  "message_reads",
  {
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    messageId: uuid()
      .notNull()
      .references(() => messages.id),
    readAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.messageId] })],
);

/**
 * Configuração do Workspace: uma linha só (`id = 1`). A Chave do Workspace fica cifrada com a
 * chave mestra (AES-256-GCM). O Contexto do Workspace (#21) também mora aqui.
 */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    id: integer().primaryKey().default(1),
    keyCiphertext: text(),
    keyIv: text(),
    keyUpdatedAt: timestamp({ withTimezone: true }),
    /** Contexto do Workspace: texto curto do Admin que entra em toda execução. */
    context: text().notNull().default(""),
  },
  (t) => [check("workspace_settings_uma_linha", sql`${t.id} = 1`)],
);

export const executionState = pgEnum("execution_state", [
  "queued",
  "running",
  "retrying",
  "done",
  "failed",
  "not_acting",
  "cancelled",
]);
/**
 * `mention`: um Agente mencionado. `dm`: o Agente de uma DM com Agente, a cada mensagem.
 * `route`: o roteamento da Articuladora (o passo "decidindo"), que dá o Desfecho. `reply`: a
 * Articuladora responde ela mesma. `delegated`: um Agente do Canal a quem ela delegou.
 */
export const executionKind = pgEnum("execution_kind", ["mention", "dm", "route", "reply", "delegated"]);

/**
 * A fila de execuções (Spec, módulo 6): cada chamada a modelo por causa de uma mensagem.
 * Sobrevive ao reinício. O tipo diz por que o Agente foi chamado (`kind`).
 */
export const executions = pgTable(
  "executions",
  {
    id: uuid().primaryKey(),
    /** Ordem de chegada; desempata execuções com a mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    kind: executionKind().notNull(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    originMessageId: uuid()
      .notNull()
      .references(() => messages.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    state: executionState().notNull(),
    /** O passo em andamento (`writing`), ou nulo fora de `running`. */
    step: text(),
    /** Desde quando está no estado ou passo atual. */
    since: timestamp({ withTimezone: true }).notNull(),
    attempt: integer().notNull().default(0),
    /** Em `retrying`: quando a nova tentativa automática sai. */
    retryAt: timestamp({ withTimezone: true }),
    /** A nova tentativa da API em curso ("tentando de novo (n/m)"), ou nulo. */
    apiRetryAttempt: integer(),
    apiRetryMax: integer(),
    /** A tentativa atual veio do "Tentar de novo" do autor (a Spec quer a Conta dele pagando: #27). */
    retriedByAuthor: boolean().notNull().default(false),
    /** Quem paga a tentativa atual: `key` (a Conta chega no #26). */
    payer: text(),
    /** O motivo da última falha (fica durante a nova tentativa, para dizer "nas duas tentativas"). */
    reason: text(),
    /** Hora de chegada: quem troca de fila mantém a hora (Spec, Prioridade). */
    arrivedAt: timestamp({ withTimezone: true }).notNull(),
    replyMessageId: uuid().references(() => messages.id),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.state, t.arrivedAt, t.seq), index().on(t.channelId, t.state)],
);

export const outcomeDecision = pgEnum("outcome_decision", ["reply", "delegate", "none"]);

/**
 * O Desfecho (ADR 0004) que a Articuladora deu a uma mensagem de pessoa num Canal com outros
 * Agentes: responder, delegar (até 2 Agentes do Canal, cada um com a frase do que cobrir) ou
 * nenhum, sempre com o motivo de uma frase. Um por mensagem. A Menção não passa por aqui.
 */
export const outcomes = pgTable(
  "outcomes",
  {
    messageId: uuid()
      .primaryKey()
      .references(() => messages.id),
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    decision: outcomeDecision().notNull(),
    reason: text().notNull(),
    /** Os delegados, na ordem da Articuladora: `[{ agentId, cover }]` (vazio fora de `delegate`). */
    delegates: jsonb().$type<{ agentId: string; cover: string }[]>().notNull().default([]),
    decidedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.channelId)],
);

/**
 * As Menções de cada mensagem, na ordem em que aparecem no texto: a pessoa (`@nome` que
 * resolveu para um Membro que vê a conversa) ou o Agente citado. A Menção é do participante,
 * não do texto: se ele troca o identificador depois, a Menção continua dele.
 * Cada linha tem um dono só, como em `mention_handles`.
 */
export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: uuid()
      .notNull()
      .references(() => messages.id),
    /** Posição da primeira aparição no texto (0, 1, …). */
    ordinal: integer().notNull(),
    memberId: uuid().references(() => members.id),
    agentId: uuid().references(() => agents.id),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.ordinal] }),
    unique().on(t.messageId, t.memberId),
    unique().on(t.messageId, t.agentId),
    index().on(t.memberId),
    check("message_mentions_one_owner", sql`num_nonnulls(${t.memberId}, ${t.agentId}) = 1`),
  ],
);

export const joinRequestStatus = pgEnum("join_request_status", ["pending", "approved", "refused"]);

/**
 * Pedido de entrada (ADR 0007). Guarda o que a porta de identidade disse na hora do pedido,
 * para o Admin decidir. Uma pessoa (`tailnetUserId`) tem no máximo um pedido esperando;
 * os recusados ficam, e são o histórico de recusa que o Admin vê no pedido seguinte.
 */
export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid().primaryKey(),
    /** `UserProfile.ID` da tailnet, como texto. Outro ID é outra pessoa. */
    tailnetUserId: text().notNull(),
    login: text().notNull(),
    displayName: text().notNull(),
    profilePicUrl: text(),
    /** Nome do aparelho de onde veio o pedido. */
    device: text(),
    /** `Node.Hostinfo.ShareeNode`: pessoa de outra tailnet. */
    sharee: boolean().notNull(),
    status: joinRequestStatus().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByMemberId: uuid().references(() => members.id),
  },
  (t) => [
    uniqueIndex("join_requests_one_pending").on(t.tailnetUserId).where(sql`${t.status} = 'pending'`),
    index().on(t.tailnetUserId, t.createdAt),
  ],
);

// ---------- Contas (ADR 0005) ----------
// O login fica com o Claude Code na pasta `config_dir`; aqui só fica o que
// `claude auth status --json` diz dele. Nenhum token, em lugar nenhum.

/** "No limite" e "Precisa ligar de novo" entram com "Quem paga e fila" (#35). */
export const accountState = pgEnum("account_state", ["not_linked", "linked"]);

export const accounts = pgTable("accounts", {
  memberId: uuid()
    .primaryKey()
    .references(() => members.id),
  state: accountState().notNull(),
  email: text(),
  /** `orgId` da Anthropic (não é tenant: ADR 0001). */
  claudeOrgId: text(),
  subscriptionType: text(),
  planTier: text(),
  /** `loginExpiresAt` do `auth status --json`. A validade mostrada sai daqui (#35). */
  loginExpiresAt: timestamp({ withTimezone: true }),
  /** A pasta de `CLAUDE_CONFIG_DIR` em uso. */
  configDir: text(),
  linkedAt: timestamp({ withTimezone: true }),
  /** "Agora não" na oferta do primeiro acesso. */
  offerDismissedAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});
