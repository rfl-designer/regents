import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
  displayName: text().notNull(),
  role: memberRole().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

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
 * O nome não se repete (sem diferença de maiúsculas); a Menção casa com ele até o #19 trazer
 * o identificador de Menção único entre Membros e Agentes.
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
  },
  (t) => [uniqueIndex("agents_name_lower_unique").on(sql`lower(${t.name})`)],
);

/** Agentes num Canal: a quem a Articuladora (#22) pode delegar ali. */
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
 * Configuração do Workspace: uma linha só (`id = 1`). A Chave do Workspace fica cifrada com a
 * chave mestra (AES-256-GCM); o Contexto do Workspace (#21) entra aqui também.
 */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    id: integer().primaryKey().default(1),
    keyCiphertext: text(),
    keyIv: text(),
    keyUpdatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [check("workspace_settings_uma_linha", sql`${t.id} = 1`)],
);

export const executionState = pgEnum("execution_state", ["queued", "running", "done", "failed", "not_acting"]);
export const executionKind = pgEnum("execution_kind", ["mention"]);

/**
 * A fila de execuções (Spec, módulo 6): cada chamada a modelo por causa de uma mensagem.
 * Sobrevive ao reinício. Hoje só há a Menção (`kind`); o roteamento, a resposta da
 * Articuladora e os delegados (#22) entram como outros tipos.
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
    /** Quem paga a tentativa atual: `key` (a Conta chega no #26). */
    payer: text(),
    reason: text(),
    /** Hora de chegada: quem troca de fila mantém a hora (Spec, Prioridade). */
    arrivedAt: timestamp({ withTimezone: true }).notNull(),
    replyMessageId: uuid().references(() => messages.id),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.state, t.arrivedAt, t.seq), index().on(t.channelId, t.state)],
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
