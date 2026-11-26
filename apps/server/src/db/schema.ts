import type { YourAccountDto } from "@shearim/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
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
  /**
   * Quando o Admin removeu o Membro ("saiu do Workspace"). Nulo enquanto ele é Membro.
   * A linha fica: as mensagens continuam dele, e quem volta pelo Pedido de entrada é o mesmo Membro.
   */
  leftAt: timestamp({ withTimezone: true }),
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
     * A marca de embutida: a Articuladora (ADR 0004), uma só, criada pela migração `0012`.
     * A descrição e as instruções dela vêm do código (`articuladora.ts`), não destas colunas.
     */
    builtin: boolean().notNull().default(false),
    /**
     * Orçamento mensal na Chave, em dólares (Spec, módulo 9): conta só o que a Chave pagou no mês.
     * Nulo: sem teto.
     */
    monthlyBudgetUsd: doublePrecision(),
    /**
     * A Memória do Agente ligada (spec #60, #67): desligada, as respostas dele não põem extração
     * na fila e não recebem o resumo nem a busca na Memória. Só o Admin muda; vem ligada.
     */
    memoryEnabled: boolean().notNull().default(true),
    /**
     * O Admin apagou o Agente (#65). A linha fica, só com o nome, a foto e a descrição de antes,
     * para o histórico das conversas (as mensagens, o Andamento, os Desfechos e os gastos dele
     * apontam para ela); ele sai das listas, dos Canais e do identificador de Menção, e não age
     * mais. A Memória do Agente sai junto; a Memória da Conversa que ele gerou fica.
     */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // O nome volta a ficar livre quando o Agente é apagado.
    uniqueIndex("agents_name_lower_unique").on(sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
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
    /**
     * Numa Thread: a mensagem-raiz (do fluxo principal da mesma conversa) em que ela pendura.
     * Nulo no fluxo principal. A resposta ancorada a uma mensagem de Thread fica na mesma Thread.
     */
    threadRootId: uuid().references((): AnyPgColumn => messages.id),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index().on(t.channelId, t.seq),
    index().on(t.threadRootId, t.seq),
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
  "awaiting_approval",
]);
/**
 * `mention`: um Agente mencionado. `dm`: o Agente de uma DM com Agente, a cada mensagem.
 * `route`: o roteamento da Articuladora (o passo "decidindo"), que dá o Desfecho. `reply`: a
 * Articuladora responde ela mesma. `delegated`: um Agente do Canal a quem ela delegou. `memory`:
 * a extração da Memória (ADR 0013), que lê a troca depois que a resposta foi entregue.
 */
export const executionKind = pgEnum("execution_kind", ["mention", "dm", "route", "reply", "delegated", "memory"]);

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
    /**
     * A Thread da mensagem de origem (a raiz), ou nulo no fluxo principal. A "conversa para a
     * ordem" (Spec, módulo 6, Ordem; #42) é o par `(channel_id, thread_root_id)`: o fluxo
     * principal e cada Thread contam como conversas separadas para a série por Agente.
     */
    threadRootId: uuid().references(() => messages.id),
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
    /** Quem paga a tentativa atual: `account` (a Conta do autor) ou `key` (a Chave do Workspace). */
    payer: text(),
    /**
     * Pela Chave: o estado da Conta do autor quando a Chave passou a pagar (o porquê ao lado de
     * "⚠ pela Chave do Workspace", só para ele), que fica com a resposta. Nulo pela Conta.
     */
    payerAccount: jsonb().$type<YourAccountDto>(),
    /** O motivo da última falha (fica durante a nova tentativa, para dizer "nas duas tentativas"). */
    reason: text(),
    /**
     * O motivo como só o autor o vê, quando ele é estado da Conta dele (`reason` é o que os outros
     * veem). Nulo quando é o mesmo para todos.
     */
    authorReason: text(),
    /**
     * Em `queued`: espera quem pague (a Conta do autor no limite ou em "Precisa ligar de novo", sem
     * Chave utilizável). Fica fora da vez até `heldUntil` (nulo: até a Conta ou a Chave mudar).
     */
    held: boolean().notNull().default(false),
    heldUntil: timestamp({ withTimezone: true }),
    /** Hora de chegada: quem troca de fila mantém a hora (Spec, Prioridade). */
    arrivedAt: timestamp({ withTimezone: true }).notNull(),
    replyMessageId: uuid().references(() => messages.id),
    finishedAt: timestamp({ withTimezone: true }),
    /**
     * A tentativa atual chegou ao teto de turnos de Ferramenta ("parou no limite de Ferramentas"):
     * o Agente responde com o que tem, numa última chamada sem Ferramentas (#53).
     */
    toolLimit: boolean().notNull().default(false),
    /**
     * Na continuação (ADR 0011): o Pedido de aprovação depois de cuja decisão ela segue a resposta.
     * Nulo na execução que a mensagem disparou.
     */
    approvalRequestId: uuid().references((): AnyPgColumn => approvalRequests.id),
    /**
     * Na extração da Memória (`memory`): a execução da resposta cuja troca ela lê (a resposta já
     * entregue, `reply_message_id` dela). Nulo nas outras.
     */
    sourceExecutionId: uuid().references((): AnyPgColumn => executions.id),
    /**
     * Na resposta entregue: os itens de Memória que entraram no resumo do contexto dela (#62), que
     * a extração recebe com os ids. Vazio nas outras. Sem FK: o item nunca é apagado (só o da
     * Memória do Agente, com o Agente), e um id que sumiu só deixa de aparecer.
     */
    memoryItemIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [index().on(t.state, t.arrivedAt, t.seq), index().on(t.channelId, t.state)],
);

/**
 * Uso por execução (Spec, Esquema): Agente, pagador e custo de cada chamada que terminou bem.
 * Só a Chave grava aqui (o gasto da Conta é da assinatura do Membro e não aparece para o Admin).
 * O gasto do mês de um Agente é a soma de `cost_usd` com `month` = o mês do relógio (UTC).
 */
export const executionUsage = pgTable(
  "execution_usage",
  {
    id: uuid().primaryKey(),
    executionId: uuid()
      .notNull()
      .references(() => executions.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    /** Sempre `key` por enquanto. */
    payer: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    costUsd: doublePrecision().notNull(),
    /** O mês do gasto (`YYYY-MM`, UTC), pelo relógio injetado. */
    month: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.agentId, t.month)],
);

/**
 * Estouros de orçamento já avisados: um por Agente por mês, para o push aos Admins (#34) sair
 * no máximo uma vez, mesmo que o Admin aumente o orçamento e ele estoure de novo.
 */
export const budgetOverruns = pgTable(
  "budget_overruns",
  {
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    month: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.month] })],
);

export const keyIncidentKind = pgEnum("key_incident_kind", ["auth_failed", "billing_failed"]);

/**
 * Incidentes da Chave (Spec, módulo 9): `authentication_error` ou `billing_error` na Chave abre
 * um (se não há outro aberto); a primeira chamada bem-sucedida pela Chave o encerra.
 */
export const keyIncidents = pgTable(
  "key_incidents",
  {
    id: uuid().primaryKey(),
    kind: keyIncidentKind().notNull(),
    openedAt: timestamp({ withTimezone: true }).notNull(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("key_incidents_one_open").on(sql`(${t.closedAt} is null)`).where(sql`${t.closedAt} is null`)],
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

/**
 * Threads seguidas (Spec, módulo 3): quem acompanha cada Thread e é avisado dela. Segue sozinho
 * quem escreveu a raiz, quem respondeu na Thread e quem foi mencionado nela (ou na raiz), a
 * partir da mensagem que o fez seguir (`since`). Agentes não seguem. Seguir à mão, e deixar de
 * seguir, ficam fora da v1.
 */
export const threadFollows = pgTable(
  "thread_follows",
  {
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    rootMessageId: uuid()
      .notNull()
      .references(() => messages.id),
    /** A conversa da Thread (a mesma da raiz). */
    conversationId: uuid()
      .notNull()
      .references(() => channels.id),
    since: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.rootMessageId] }), index().on(t.rootMessageId)],
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
/** `needs_relink`: "Precisa ligar de novo" (o login caiu; a pasta fica até ligar de novo ou desligar). */
export const accountState = pgEnum("account_state", ["not_linked", "linked", "needs_relink"]);

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
  /** `loginExpiresAt` do `auth status --json` (ao ligar e uma vez por dia). A validade sai daqui. */
  loginExpiresAt: timestamp({ withTimezone: true }),
  /**
   * O `credential_expires_at` da execução mais recente pela Conta. A validade mostrada é a mais
   * cedo entre esta e `loginExpiresAt`, menos 3 dias.
   */
  credentialExpiresAt: timestamp({ withTimezone: true }),
  /** Quando saiu o aviso de vencimento (3 dias antes da validade) deste login: um só por login. */
  expiryWarnedAt: timestamp({ withTimezone: true }),
  /** "usando uso extra": a execução mais recente que trouxe `rate_limit_event` passou do plano. */
  extraUsage: boolean().notNull().default(false),
  /** A pasta de `CLAUDE_CONFIG_DIR` em uso. */
  configDir: text(),
  /** "No limite até HH:MM": a Conta não paga até esta hora (o `resetsAt` do limite). */
  limitedUntil: timestamp({ withTimezone: true }),
  linkedAt: timestamp({ withTimezone: true }),
  /** "Agora não" na oferta do primeiro acesso. */
  offerDismissedAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

// ---------- Push (Spec, módulo 12) ----------

/**
 * O par VAPID do Workspace: gerado na primeira subida e nunca trocado (trocar invalida todas as
 * inscrições). Uma linha só (`id = 1`). As chaves vão em base64url, como o `web-push` as usa.
 */
export const vapidKeys = pgTable(
  "vapid_keys",
  {
    id: integer().primaryKey().default(1),
    publicKey: text().notNull(),
    privateKey: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [check("vapid_keys_uma_linha", sql`${t.id} = 1`)],
);

/**
 * Os aparelhos de um Membro (cada PWA instalado ou navegador, com o id que o PWA gerou para si).
 * Guarda quando o push parou ("parou em DD/MM", quando o push service disse que a inscrição
 * morreu) e o último push entregue; a lista e as faixas são do #33.
 */
export const devices = pgTable(
  "devices",
  {
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    /** Gerado pelo PWA e guardado nele; só vale junto com o Membro. */
    id: uuid().notNull(),
    /** O nome do aparelho que a tailnet informa, quando informa. */
    label: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    lastPushAt: timestamp({ withTimezone: true }),
    /** Quando o push service respondeu 404/410 e a inscrição foi apagada. Nulo enquanto recebe. */
    pushStoppedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.id] })],
);

/**
 * A inscrição de push de um aparelho (`PushSubscription` do navegador): no máximo uma por
 * aparelho, e um endpoint é de um aparelho só. `origin` é de onde o PWA se inscreveu: o
 * `navigate` da notificação aponta para lá.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    endpoint: text().primaryKey(),
    memberId: uuid().notNull(),
    deviceId: uuid().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    origin: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.memberId, t.deviceId),
    foreignKey({ columns: [t.memberId, t.deviceId], foreignColumns: [devices.memberId, devices.id] }),
  ],
);

/**
 * Quantos pushes de uma conversa um Membro recebeu desde a última vez que a abriu: é o "3 novas
 * em #vendas" da notificação que substitui as anteriores. Abrir a conversa zera (apaga a linha).
 */
export const pushStreaks = pgTable(
  "push_streaks",
  {
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    conversationId: uuid()
      .notNull()
      .references(() => channels.id),
    count: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.conversationId] })],
);

/**
 * A Instalação (Spec, módulo 13): uma linha só, criada na primeira subida. `createdAt` é de quando
 * as 36 h sem backup bom começam a contar enquanto nunca houve um.
 */
export const installation = pgTable(
  "installation",
  {
    id: integer().primaryKey().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [check("installation_uma_linha", sql`${t.id} = 1`)],
);

/** Cada backup noturno, bom ou não (o serviço `backup` do compose grava; o app lê). */
export const backups = pgTable(
  "backups",
  {
    id: uuid().primaryKey(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: timestamp({ withTimezone: true }).notNull(),
    ok: boolean().notNull(),
    /** O nome do arquivo em `./backups`, quando deu certo. */
    file: text(),
    bytes: bigint({ mode: "number" }),
    error: text(),
  },
  (t) => [index().on(t.finishedAt)],
);

/**
 * Os pushes do Admin sobre a Instalação que já saíram, para cada um sair uma vez só (também
 * depois de reiniciar): `kind` é o aviso, `ref` o que ele avisa (o backup que falhou, o último
 * backup bom de quando faltou um, o vencimento da chave do nó).
 */
export const installationAlerts = pgTable(
  "installation_alerts",
  {
    kind: text().notNull(),
    ref: text().notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.ref] })],
);

// ---------- Ferramentas (Spec #44) ----------

/**
 * Os Conectores (Spec #44): servidores MCP remotos que o Admin liga ao Workspace. `key` é o prefixo
 * dos ids das Ferramentas dele (`crm__buscar_cliente`), tirado do nome. No modo do Workspace, o
 * token vai cifrado com a chave mestra, como a Chave; `credentialState` vira `refused` quando o
 * servidor o recusa (401), até o Admin colar outro.
 */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    key: text().notNull().unique(),
    /** `mcp`: um servidor MCP remoto. */
    kind: text().notNull(),
    url: text().notNull(),
    /** `workspace`: uma credencial só, a do Workspace; `member`: a de cada Membro (`memberConnectorCredentials`). */
    credentialMode: text().notNull(),
    tokenCiphertext: text(),
    tokenIv: text(),
    /** `ok` ou `refused`. */
    credentialState: text().notNull(),
    refusedAt: timestamp({ withTimezone: true }),
    /**
     * Credencial do Workspace ligada pelo login do servidor (OAuth, #56): o token de renovação, o
     * cliente registrado e os metadados do servidor de autorização, em JSON cifrado. Sem login
     * (token colado), nulos.
     */
    oauthCiphertext: text(),
    oauthIv: text(),
    /** Quando o token de acesso do login vence; a renovação vem antes. Nulo: não vence (ou colado). */
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("connectors_name_lower").on(sql`lower(${t.name})`)],
);

/**
 * As credenciais de cada Membro nos Conectores do modo `member` (Spec #44): o token que ele colou
 * em Perfil › Conectores, cifrado com a chave mestra, e o estado (`ok`, ou `refused` quando o
 * servidor o recusou). Desligar apaga a linha; remover o Membro do Workspace também.
 */
export const memberConnectorCredentials = pgTable(
  "member_connector_credentials",
  {
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    tokenCiphertext: text().notNull(),
    tokenIv: text().notNull(),
    /** `ok` ou `refused`. */
    state: text().notNull(),
    refusedAt: timestamp({ withTimezone: true }),
    /** Ligada pelo login do servidor (OAuth, #56): como em `connectors`. Colada: nulos. */
    oauthCiphertext: text(),
    oauthIv: text(),
    expiresAt: timestamp({ withTimezone: true }),
    connectedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectorId, t.memberId] })],
);

/**
 * Os logins de Conector em andamento (#56): o `state` que o servidor de autorização devolve no
 * retorno, quem começou (só ele termina), para quê (`create`: adicionar o Conector; `workspace`:
 * religar a credencial do Workspace; `member`: a credencial do Membro) e, cifrado, o verificador
 * PKCE, o cliente registrado e os metadados. O retorno consome a linha; vale por pouco tempo.
 */
export const connectorLogins = pgTable("connector_logins", {
  state: text().primaryKey(),
  memberId: uuid()
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  purpose: text().notNull(),
  connectorId: uuid().references(() => connectors.id, { onDelete: "cascade" }),
  /** Só no `create`: o Conector que o retorno adiciona. */
  name: text(),
  url: text().notNull(),
  credentialMode: text(),
  redirectUri: text().notNull(),
  secretCiphertext: text().notNull(),
  secretIv: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * O catálogo de cada Conector, como o `tools/list` dele o devolveu da última vez (relido quando o
 * Admin abre o Conector). `tool` é o id no Shearim; `name`, o do servidor. Só `readOnly` é leitura.
 */
export const connectorTools = pgTable(
  "connector_tools",
  {
    tool: text().primaryKey(),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    name: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    inputSchema: jsonb().$type<Record<string, unknown>>().notNull(),
    readOnly: boolean().notNull(),
  },
  (t) => [index().on(t.connectorId, t.position)],
);

/**
 * As Ferramentas concedidas a cada Agente, pelo Admin. `tool` é o id da Ferramenta no catálogo;
 * as de um Conector levam a coluna do Conector, com a remoção em cascata: remover o Conector tira
 * as concessões dele de todos os Agentes.
 */
export const agentTools = pgTable(
  "agent_tools",
  {
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tool: text().notNull(),
    connectorId: uuid().references(() => connectors.id, { onDelete: "cascade" }),
    grantedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.tool] })],
);

/**
 * Cada uso de Ferramenta numa execução, para o Andamento: o passo em andamento e a falha com
 * motivo. `attempt` é a tentativa da execução em que ele aconteceu (o Andamento mostra só os da
 * tentativa atual).
 */
export const executionToolCalls = pgTable(
  "execution_tool_calls",
  {
    id: uuid().primaryKey(),
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    executionId: uuid()
      .notNull()
      .references(() => executions.id),
    attempt: integer().notNull(),
    tool: text().notNull(),
    title: text().notNull(),
    label: text().notNull(),
    /** `running`, `done` ou `failed`. */
    state: text().notNull(),
    reason: text(),
    /** Numa de Conector com a credencial de cada Membro: "usou o CRM de Ana" (todos veem, ao terminar bem). */
    used: text(),
    /** Indisponível por falta da credencial do autor: o Conector do atalho "Ligar <Conector>" (só o autor vê). */
    connectConnectorId: uuid(),
    connectName: text(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.executionId, t.attempt)],
);

export const approvalState = pgEnum("approval_state", ["pending", "approved", "rejected", "expired", "cancelled"]);

/**
 * Os Pedidos de aprovação (ADR 0011): a escrita que um Agente pediu numa execução, guardada com a
 * ação exata (a Ferramenta, os argumentos e o hash deles) e o resumo que o autor da mensagem de
 * origem aprova ou recusa. Na aprovação, o Shearim executa a ação guardada; o resultado (ou a
 * falha) e a recusa vão à execução de continuação.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid().primaryKey(),
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    /** A execução que pediu a escrita (e terminou em "esperando aprovação"). */
    executionId: uuid()
      .notNull()
      .references((): AnyPgColumn => executions.id),
    /** A conversa da mensagem de origem, onde o cartão aparece. */
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    originMessageId: uuid()
      .notNull()
      .references(() => messages.id),
    authorMemberId: uuid()
      .notNull()
      .references(() => members.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    tool: text().notNull(),
    /** O nome da Ferramenta em pt-BR, como era quando o Pedido foi criado. */
    toolTitle: text().notNull(),
    /** Os argumentos já resolvidos (a ação exata que será executada). */
    action: jsonb().$type<Record<string, unknown>>().notNull(),
    actionHash: text().notNull(),
    /** O que vai ser feito, em pt-BR, como o cartão mostra. */
    summary: text().notNull(),
    state: approvalState().notNull(),
    /** Na recusa: o motivo opcional do autor. */
    rejectReason: text(),
    /** Na aprovação: o resultado da ação, ou o motivo da falha dela (`failure`). */
    result: text(),
    failure: text(),
    /**
     * A ação aprovada pode ter sido feita lá fora sem o Shearim saber (estourou o prazo, o servidor
     * reiniciou no meio): `failure` diz por quê e onde conferir.
     */
    uncertain: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.channelId, t.seq), index().on(t.executionId)],
);

/**
 * O GitHub App da Instalação e a instalação dele na conta do time (ADR 0010): uma linha só, uma
 * instalação por Workspace. Os segredos do App (a chave privada, o segredo do webhook e o do
 * cliente) ficam num JSON cifrado com a chave mestra, como a Chave do Workspace.
 */
export const githubApp = pgTable(
  "github_app",
  {
    id: integer().primaryKey().default(1),
    /** O `state` do fluxo em andamento (manifest ou instalação), conferido no retorno e apagado nele. */
    pendingState: text(),
    /** O endereço da Instalação de onde o fluxo começou (os retornos do manifest). */
    origin: text(),
    appId: bigint({ mode: "number" }),
    slug: text(),
    name: text(),
    owner: text(),
    htmlUrl: text(),
    secretsCiphertext: text(),
    secretsIv: text(),
    createdAt: timestamp({ withTimezone: true }),
    installationId: bigint({ mode: "number" }),
    installationAccount: text(),
    installedAt: timestamp({ withTimezone: true }),
    /** A instalação que o GitHub deixou de reconhecer: o motivo e quando o Shearim viu. */
    failureReason: text(),
    failedAt: timestamp({ withTimezone: true }),
  },
  (t) => [check("github_app_uma_linha", sql`${t.id} = 1`)],
);

/**
 * Os repositórios do GitHub a que o Admin restringiu um Agente (Spec #44), como `dono/nome`. Sem
 * linha, o Agente alcança tudo o que a instalação alcança; com linhas, só estes.
 */
export const agentGithubRepositories = pgTable(
  "agent_github_repositories",
  {
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    repository: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.repository] })],
);

export const memoryScope = pgEnum("memory_scope", ["workspace", "conversation", "agent"]);
export const memoryAuthor = pgEnum("memory_author", ["extraction", "member", "admin"]);
export const memoryState = pgEnum("memory_state", ["active", "archived"]);

/**
 * A Memória (spec #60): o que fica de uma conversa para os Agentes usarem em respostas futuras.
 * Cada item guarda a conversa e a mensagem de origem (vazias só no item que um Admin escreve
 * direto na Memória do Workspace); o alcance não é guardado, é calculado na hora de ler (ADR 0012).
 *
 * - Escopo: `conversation` (os fatos e as decisões de um Canal ou DM, com as Threads), `agent`
 *   (o jeito de trabalhar de um Agente: `agent_id`, que sai junto com o Agente) e `workspace`.
 * - Quem criou: a extração (`execution_id`, ADR 0013), um Membro ou um Admin (`created_by_member_id`).
 * - Nada é apagado: uma correção cria a versão nova e arquiva a anterior, que aponta para ela
 *   (`replaced_by_id`); desfazer arquiva.
 */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid().primaryKey(),
    /** Ordem de gravação: desempata itens com a mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    scope: memoryScope().notNull(),
    /** A conversa de origem (o Canal ou a DM; a Thread fica na mensagem). */
    conversationId: uuid().references(() => channels.id),
    /** A mensagem de origem: a mensagem de pessoa da troca que gerou o item. */
    originMessageId: uuid().references(() => messages.id),
    /** Só no escopo `agent`: de quem é a lição. Apagar o Agente leva a Memória dele junto. */
    agentId: uuid().references(() => agents.id, { onDelete: "cascade" }),
    text: text().notNull(),
    createdBy: memoryAuthor().notNull(),
    /** Quem escreveu, quando foi gente (`member` ou `admin`). */
    createdByMemberId: uuid().references(() => members.id),
    /**
     * Quando foi a extração: a execução que guardou (o Andamento da mensagem de origem mostra o
     * "guardou na Memória"). Sem bloquear a limpeza das execuções de um Agente apagado.
     */
    executionId: uuid().references(() => executions.id, { onDelete: "set null" }),
    state: memoryState().notNull(),
    /** No item arquivado por uma correção: a versão que o substituiu. */
    replacedById: uuid().references((): AnyPgColumn => memoryItems.id),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.conversationId, t.state, t.seq),
    index().on(t.agentId, t.state, t.seq),
    check("memory_items_agente_so_no_escopo_agente", sql`(${t.scope} = 'agent') = (${t.agentId} is not null)`),
    check(
      "memory_items_conversa_com_origem",
      sql`${t.scope} = 'workspace' or (${t.conversationId} is not null and ${t.originMessageId} is not null)`,
    ),
  ],
);
