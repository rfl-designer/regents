import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
