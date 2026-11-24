import { bigint, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
