import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

export const channelKind = pgEnum("channel_kind", ["public", "private"]);

export const channels = pgTable("channels", {
  id: uuid().primaryKey(),
  name: text().notNull().unique(),
  kind: channelKind().notNull(),
  /** Instruções do Canal: entram no contexto de todo Agente que fala ali. Só o Admin edita. */
  instructions: text().notNull().default(""),
  /** N: quantas mensagens recentes os Agentes do Canal recebem (aceita 0). Só o Admin edita. */
  recentMessages: integer().notNull().default(30),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * Pessoas que participam de um Canal (entraram num público ou foram adicionadas a um privado).
 * Num Canal privado, é quem vê o Canal e recebe os eventos dele; num público, todo Membro vê.
 * Agentes num Canal (#20) entram em tabela própria, ao lado desta: o participante, no
 * contrato, já é `{ kind: "member" | ... }`.
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

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey(),
    /** Ordem de gravação; desempata mensagens com a mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id),
    authorMemberId: uuid()
      .notNull()
      .references(() => members.id),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.channelId, t.seq)],
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
