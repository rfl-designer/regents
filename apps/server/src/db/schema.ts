import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
