import { sql } from "drizzle-orm";
import {
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
 * Cada linha tem um dono só. `agent_id` ganha a referência a `agents` quando os Agentes
 * chegarem (#20). Quem mexe aqui é `mention-handles.ts`.
 */
export const mentionHandles = pgTable(
  "mention_handles",
  {
    /** Minúsculo, sem acento, só `[a-z0-9_]`, sem o `@`. */
    handle: text().primaryKey(),
    memberId: uuid()
      .unique()
      .references(() => members.id),
    agentId: uuid().unique(),
  },
  (t) => [check("mention_handles_one_owner", sql`num_nonnulls(${t.memberId}, ${t.agentId}) = 1`)],
);

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

/**
 * As Menções a pessoas de cada mensagem (`@nome` que resolveu para um Membro que vê a
 * conversa), na ordem em que aparecem no texto. A Menção é da pessoa, não do texto: se
 * ela troca o identificador depois, a Menção continua dela. As Menções a Agentes (#20)
 * entram ao lado desta.
 */
export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: uuid()
      .notNull()
      .references(() => messages.id),
    memberId: uuid()
      .notNull()
      .references(() => members.id),
    /** Posição da primeira aparição no texto (0, 1, …). */
    ordinal: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.memberId] }), index().on(t.memberId)],
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
