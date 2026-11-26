import { sql } from "drizzle-orm";
import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { members } from "../db/schema";

// As tabelas da Wiki (spec #74, ADR 0014 e 0015). Reexportadas por `db/schema.ts`, para o
// drizzle-kit e o `schema` do cliente as verem.

export const wikiScope = pgEnum("wiki_scope", ["public", "restricted"]);

/**
 * Uma Wiki: um conjunto nomeado de páginas que a Sincronização mantém a partir das Fontes. O nome
 * é único sem diferenciar maiúsculas. Antes da primeira Sincronização, não há versão: a Wiki
 * está "nunca sincronizada".
 */
export const wikis = pgTable(
  "wikis",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    /** Entra no catálogo do Agente e no contexto da Articuladora: diz o que a Wiki cobre. */
    description: text().notNull(),
    /** Pública (todo Membro) ou restrita a uma lista de Membros. */
    scope: wikiScope().notNull().default("public"),
    createdByMemberId: uuid()
      .notNull()
      .references(() => members.id),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("wikis_name_lower_unique").on(sql`lower(${t.name})`)],
);

export const wikiSourceFormat = pgEnum("wiki_source_format", ["txt", "md"]);
export const wikiSourceState = pgEnum("wiki_source_state", ["active", "removed"]);

/**
 * Uma Fonte: o texto bruto que o Admin subiu numa Wiki. O texto não muda depois de subir (não há
 * rota de edição). Remover só troca o estado: a Fonte removida fica guardada enquanto alguma
 * versão a reflete. A pendência ("nova", "a remover") é derivada da versão atual, e não guardada.
 */
export const wikiSources = pgTable(
  "wiki_sources",
  {
    id: uuid().primaryKey(),
    /** Ordem de subida: desempata Fontes subidas na mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    wikiId: uuid()
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    fileName: text().notNull(),
    format: wikiSourceFormat().notNull(),
    text: text().notNull(),
    /** O tamanho do texto em UTF-8, em bytes. */
    sizeBytes: integer().notNull(),
    uploadedByMemberId: uuid()
      .notNull()
      .references(() => members.id),
    uploadedAt: timestamp({ withTimezone: true }).notNull(),
    state: wikiSourceState().notNull().default("active"),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.wikiId, t.seq),
    // Duas Fontes ativas com o mesmo nome de arquivo na mesma Wiki confundiriam a origem das páginas.
    uniqueIndex("wiki_sources_active_file_name_unique")
      .on(t.wikiId, sql`lower(${t.fileName})`)
      .where(sql`${t.state} = 'active'`),
  ],
);
