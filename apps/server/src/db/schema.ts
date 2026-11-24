import { sql } from "drizzle-orm";
import { bigint, boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

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
