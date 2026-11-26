import type { WikiSyncReportDto, WikiSyncStepDto } from "@shearim/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { channels, members } from "../db/schema";

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
    /**
     * A versão que os Agentes e os Membros leem: a da última Sincronização concluída (ou a que o
     * Admin escolheu ao voltar). Nula = "nunca sincronizada". Voltar a uma versão só troca isto, e
     * as pendências se recalculam sozinhas.
     */
    currentVersionId: uuid().references((): AnyPgColumn => wikiVersions.id),
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

export const wikiSyncState = pgEnum("wiki_sync_state", ["queued", "running", "done", "failed", "canceled"]);

/**
 * Uma Sincronização (ADR 0015): o trabalho da Articuladora que leva as Fontes pendentes para as
 * páginas. Não é uma `execution`: não tem Canal nem mensagem de origem. Ela trabalha num rascunho
 * (fora do banco, que ninguém lê) e só grava a versão no fim, numa transação. Só uma por Wiki fica
 * em `queued` ou `running` de cada vez (o índice único parcial).
 */
export const wikiSyncs = pgTable(
  "wiki_syncs",
  {
    id: uuid().primaryKey(),
    /** Ordem de pedido: com o relógio parado, desempata as Sincronizações da mesma hora. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    wikiId: uuid()
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    /** O Admin que apertou "Sincronizar": a Conta dele paga (#80), e o push vai para ele. */
    startedByMemberId: uuid()
      .notNull()
      .references(() => members.id),
    state: wikiSyncState().notNull().default("queued"),
    /** O passo em curso ("Fonte 1 de 2", "revisando a Wiki", "publicando"); nulo fora de `running`. */
    step: jsonb().$type<WikiSyncStepDto>(),
    reason: text(),
    /** Na concluída: o que mudou da versão anterior para a nova. */
    report: jsonb().$type<WikiSyncReportDto>(),
    /**
     * Quem paga a chamada em curso (ou a última): `account` (a Conta de quem iniciou) ou `key` (a
     * Chave do Workspace), decidido a cada chamada (#80). Nulo antes da primeira.
     */
    payer: text().$type<"account" | "key">(),
    /** A tentativa da chamada em curso (a nova tentativa automática é do #86). */
    attempt: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.wikiId, t.seq),
    uniqueIndex("wiki_syncs_one_open_per_wiki").on(t.wikiId).where(sql`${t.state} in ('queued', 'running')`),
  ],
);

/**
 * Uma versão da Wiki: o que uma Sincronização concluída publicou. Guarda as páginas (imutáveis: a
 * versão nova copia o que não mudou) e o conjunto de Fontes que ela reflete, de onde se derivam as
 * pendências.
 */
export const wikiVersions = pgTable(
  "wiki_versions",
  {
    id: uuid().primaryKey(),
    wikiId: uuid()
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    /** 1, 2, 3... por Wiki. */
    number: integer().notNull(),
    syncId: uuid()
      .notNull()
      .references(() => wikiSyncs.id, { onDelete: "cascade" }),
    report: jsonb().$type<WikiSyncReportDto>().notNull(),
    publishedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex().on(t.wikiId, t.number)],
);

/** As Fontes que uma versão reflete. Uma Fonte removida fica guardada enquanto alguma versão a reflete. */
export const wikiVersionSources = pgTable(
  "wiki_version_sources",
  {
    versionId: uuid()
      .notNull()
      .references(() => wikiVersions.id, { onDelete: "cascade" }),
    sourceId: uuid()
      .notNull()
      .references(() => wikiSources.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.sourceId] }), index().on(t.sourceId)],
);

/**
 * Uma página de uma versão. O slug é o endereço estável dentro da Wiki; o corpo é markdown com
 * links `[[slug]]`. Toda versão tem `index` e `log`.
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid().primaryKey(),
    versionId: uuid()
      .notNull()
      .references(() => wikiVersions.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
  },
  (t) => [uniqueIndex().on(t.versionId, t.slug)],
);

/** As Fontes de onde uma página veio. */
export const wikiPageSources = pgTable(
  "wiki_page_sources",
  {
    pageId: uuid()
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    sourceId: uuid()
      .notNull()
      .references(() => wikiSources.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.sourceId] })],
);

/**
 * A ligação de uma Wiki a um Canal (#81): todo Agente que responde no Canal (a Articuladora
 * inclusive) a consulta ali, dentro do alcance dela. Some com a Wiki.
 */
export const wikiChannels = pgTable(
  "wiki_channels",
  {
    wikiId: uuid()
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    linkedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.wikiId, t.channelId] }), index().on(t.channelId)],
);

/**
 * A lista de Membros de uma Wiki restrita (#83): ela só é lida numa resposta em que o autor e todos
 * os que veem a conversa estão aqui, e só eles a veem na barra lateral. Numa Wiki pública a lista
 * fica guardada, sem efeito. Quem sai do Workspace não conta (a lista ignora `members.left_at`).
 */
export const wikiMembers = pgTable(
  "wiki_members",
  {
    wikiId: uuid()
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    memberId: uuid()
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    addedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.wikiId, t.memberId] }), index().on(t.memberId)],
);
