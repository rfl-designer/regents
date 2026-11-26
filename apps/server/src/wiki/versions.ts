import {
  WIKI_INDEX_SLUG,
  WIKI_LOG_SLUG,
  type WikiLinkDto,
  type WikiPageDto,
  type WikiSyncReportDto,
  type WikiVersionDto,
  wikiLinkSlugs,
} from "@shearim/contracts";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { type Db, schema, type Tx } from "../db/client";
import type { DraftPage } from "./draft";
import { lockIdleWiki } from "./sources";

const {
  wikis,
  wikiVersions,
  wikiVersionSources,
  wikiPages,
  wikiPageSources,
  wikiSources,
  wikiSyncs,
  wikiRestores,
  members,
} = schema;

/**
 * As versões da Wiki (ADR 0015): cada Sincronização concluída publica uma, com as páginas
 * (imutáveis: a nova copia o que não mudou) e o conjunto de Fontes que ela reflete. A versão atual
 * é a que `wikis.current_version_id` aponta; voltar a uma anterior (#89) só troca esse ponteiro.
 */

/** A hora de uma entrada do `log`, em UTC: "2026-11-26 04:20 UTC". */
export function logTime(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * O `log` da versão como se lê (#89): o corpo guardado nela e, depois, cada volta a ela, na ordem.
 * A página guardada não muda (as páginas são imutáveis por versão), e o que ela já dizia continua
 * no começo: uma citação do `log` segue verificável. A Sincronização seguinte copia o `log` assim,
 * e a versão nova guarda a volta no corpo dela.
 */
async function withRestores(db: Db | Tx, versionId: string, body: string): Promise<string> {
  const restores = await db
    .select({ at: wikiRestores.at, from: wikiVersions.number, by: members.displayName })
    .from(wikiRestores)
    .innerJoin(wikiVersions, eq(wikiVersions.id, wikiRestores.fromVersionId))
    .innerJoin(members, eq(members.id, wikiRestores.byMemberId))
    .where(eq(wikiRestores.toVersionId, versionId))
    .orderBy(asc(wikiRestores.seq));
  if (!restores.length) return body;
  const to = await versionNumberOf(db, versionId);
  const entries = restores.map((r) =>
    [
      `## Volta à versão ${to} · ${logTime(r.at)} · ${r.by}`,
      `- A versão ${r.from} deixou de valer: a Wiki voltou à versão ${to}.`,
    ].join("\n"),
  );
  return [body.trimEnd(), ...entries].join("\n\n");
}

/** A página `slug` da versão, como se lê (o `log` com as voltas), ou nada. */
export async function pageOfVersion(db: Db | Tx, versionId: string, slug: string) {
  const [row] = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, body: wikiPages.body })
    .from(wikiPages)
    .where(and(eq(wikiPages.versionId, versionId), eq(wikiPages.slug, slug)));
  if (!row || slug !== WIKI_LOG_SLUG) return row;
  return { ...row, body: await withRestores(db, versionId, row.body) };
}

/** O id da versão atual da Wiki, ou nulo (nunca sincronizada). */
export async function currentVersionId(db: Db | Tx, wikiId: string): Promise<string | null> {
  const [row] = await db.select({ id: wikis.currentVersionId }).from(wikis).where(eq(wikis.id, wikiId));
  return row?.id ?? null;
}

/** Os ids das Fontes que a versão reflete. */
export async function sourcesOfVersion(db: Db | Tx, versionId: string | null): Promise<Set<string>> {
  if (!versionId) return new Set();
  const rows = await db
    .select({ id: wikiVersionSources.sourceId })
    .from(wikiVersionSources)
    .where(eq(wikiVersionSources.versionId, versionId));
  return new Set(rows.map((r) => r.id));
}

/** As páginas da versão, por slug, com os ids das Fontes de cada uma. */
export async function pagesOfVersion(db: Db | Tx, versionId: string | null): Promise<Map<string, DraftPage>> {
  const pages = new Map<string, DraftPage>();
  if (!versionId) return pages;
  const rows = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, body: wikiPages.body })
    .from(wikiPages)
    .where(eq(wikiPages.versionId, versionId))
    .orderBy(asc(wikiPages.slug));
  const links = rows.length
    ? await db
        .select({ pageId: wikiPageSources.pageId, sourceId: wikiPageSources.sourceId, seq: wikiSources.seq })
        .from(wikiPageSources)
        .innerJoin(wikiSources, eq(wikiSources.id, wikiPageSources.sourceId))
        .where(
          inArray(
            wikiPageSources.pageId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(wikiSources.seq))
    : [];
  for (const r of rows) {
    const sources = links.filter((l) => l.pageId === r.id).map((l) => l.sourceId);
    const body = r.slug === WIKI_LOG_SLUG ? await withRestores(db, versionId, r.body) : r.body;
    pages.set(r.slug, { title: r.title, body, sources });
  }
  return pages;
}

/** O número e a data da versão atual (o `currentVersion` da Wiki), ou nulo. */
export async function currentVersionSummary(db: Db, wikiId: string) {
  const [row] = await db
    .select({ number: wikiVersions.number, publishedAt: wikiVersions.publishedAt })
    .from(wikis)
    .innerJoin(wikiVersions, eq(wikiVersions.id, wikis.currentVersionId))
    .where(eq(wikis.id, wikiId));
  return row ? { number: row.number, publishedAt: row.publishedAt.toISOString() } : null;
}

/** As versões da Wiki, da mais nova para a mais velha. */
export async function listVersions(db: Db, wikiId: string): Promise<WikiVersionDto[]> {
  const current = await currentVersionId(db, wikiId);
  const rows = await db
    .select({
      id: wikiVersions.id,
      number: wikiVersions.number,
      publishedAt: wikiVersions.publishedAt,
      report: wikiVersions.report,
      starterId: members.id,
      starterName: members.displayName,
    })
    .from(wikiVersions)
    .innerJoin(wikiSyncs, eq(wikiSyncs.id, wikiVersions.syncId))
    .innerJoin(members, eq(members.id, wikiSyncs.startedByMemberId))
    .where(eq(wikiVersions.wikiId, wikiId))
    .orderBy(desc(wikiVersions.number));
  return rows.map((r) => ({
    number: r.number,
    publishedAt: r.publishedAt.toISOString(),
    startedBy: { id: r.starterId, name: r.starterName },
    report: r.report,
    current: r.id === current,
  }));
}

/** O id da versão `number` da Wiki, ou nada. */
export async function versionNumbered(db: Db | Tx, wikiId: string, number: number): Promise<string | undefined> {
  if (!Number.isInteger(number) || number < 1) return undefined;
  const [row] = await db
    .select({ id: wikiVersions.id })
    .from(wikiVersions)
    .where(and(eq(wikiVersions.wikiId, wikiId), eq(wikiVersions.number, number)));
  return row?.id;
}

/** O número da versão. */
export async function versionNumberOf(db: Db | Tx, versionId: string): Promise<number> {
  const [row] = await db
    .select({ number: wikiVersions.number })
    .from(wikiVersions)
    .where(eq(wikiVersions.id, versionId));
  return row!.number;
}

/** As páginas de uma versão, por slug, com as Fontes de cada uma (na ordem em que subiram). */
export async function pageDtos(db: Db, versionId: string): Promise<WikiPageDto[]> {
  const pages = await pagesOfVersion(db, versionId);
  const ids = [...new Set([...pages.values()].flatMap((p) => p.sources))];
  const names = ids.length
    ? await db
        .select({ id: wikiSources.id, fileName: wikiSources.fileName })
        .from(wikiSources)
        .where(inArray(wikiSources.id, ids))
    : [];
  return [...pages].map(([slug, p]) => ({
    slug,
    title: p.title,
    body: p.body,
    sources: p.sources.map((id) => ({ id, fileName: names.find((n) => n.id === id)?.fileName ?? "" })),
  }));
}

/**
 * Uma página de uma versão, para ler (#82): a página com as Fontes dela (na ordem em que subiram) e
 * os links do corpo, cada um com o título da página ligada naquela versão, ou `null` (quebrado).
 * Nada quando a versão não tem a página.
 */
export async function readPage(
  db: Db,
  versionId: string,
  slug: string,
): Promise<{ page: WikiPageDto; links: WikiLinkDto[] } | undefined> {
  const row = await pageOfVersion(db, versionId, slug);
  if (!row) return undefined;
  const sources = await db
    .select({ id: wikiSources.id, fileName: wikiSources.fileName })
    .from(wikiPageSources)
    .innerJoin(wikiSources, eq(wikiSources.id, wikiPageSources.sourceId))
    .where(eq(wikiPageSources.pageId, row.id))
    .orderBy(asc(wikiSources.seq));
  const slugs = wikiLinkSlugs(row.body);
  const linked = slugs.length
    ? await db
        .select({ slug: wikiPages.slug, title: wikiPages.title })
        .from(wikiPages)
        .where(and(eq(wikiPages.versionId, versionId), inArray(wikiPages.slug, slugs)))
    : [];
  return {
    page: { slug: row.slug, title: row.title, body: row.body, sources },
    links: slugs.map((s) => ({ slug: s, title: linked.find((l) => l.slug === s)?.title ?? null })),
  };
}

/** O índice que o Shearim escreve quando a Articuladora não deixou um: uma linha por página. */
function fallbackIndex(pages: ReadonlyMap<string, DraftPage>): DraftPage {
  const lines = [...pages]
    .filter(([slug]) => slug !== WIKI_LOG_SLUG && slug !== WIKI_INDEX_SLUG)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, p]) => `- [[${slug}]]: ${p.title}`);
  const sources = [...new Set([...pages.values()].flatMap((p) => p.sources))];
  return { title: "Índice", body: lines.join("\n") || "A Wiki ainda não tem páginas.", sources };
}

/**
 * A publicação (ADR 0015): numa transação só, grava a versão nova (as páginas do rascunho, o `log`
 * com a entrada desta Sincronização, as Fontes que ela reflete e o relatório) e a torna a atual.
 * Devolve o número da versão.
 */
export async function publishVersion(
  tx: Tx,
  input: {
    wikiId: string;
    syncId: string;
    pages: ReadonlyMap<string, DraftPage>;
    sources: readonly string[];
    report: WikiSyncReportDto;
    logEntry: (number: number) => string;
    now: Date;
  },
): Promise<number> {
  const [last] = await tx
    .select({ n: max(wikiVersions.number) })
    .from(wikiVersions)
    .where(eq(wikiVersions.wikiId, input.wikiId));
  const number = (last?.n ?? 0) + 1;
  const versionId = crypto.randomUUID();
  await tx.insert(wikiVersions).values({
    id: versionId,
    wikiId: input.wikiId,
    number,
    syncId: input.syncId,
    report: input.report,
    publishedAt: input.now,
  });
  if (input.sources.length) {
    await tx.insert(wikiVersionSources).values(input.sources.map((sourceId) => ({ versionId, sourceId })));
  }
  const pages = new Map(input.pages);
  if (!pages.has(WIKI_INDEX_SLUG)) pages.set(WIKI_INDEX_SLUG, fallbackIndex(pages));
  const log = pages.get(WIKI_LOG_SLUG);
  const entry = input.logEntry(number);
  pages.set(WIKI_LOG_SLUG, { title: "Log", body: log ? `${log.body.trimEnd()}\n\n${entry}` : entry, sources: [] });
  for (const [slug, page] of pages) {
    const pageId = crypto.randomUUID();
    await tx.insert(wikiPages).values({ id: pageId, versionId, slug, title: page.title, body: page.body });
    if (page.sources.length) {
      await tx.insert(wikiPageSources).values(page.sources.map((sourceId) => ({ pageId, sourceId })));
    }
  }
  await tx.update(wikis).set({ currentVersionId: versionId }).where(eq(wikis.id, input.wikiId));
  return number;
}

/** Por que voltar a uma versão foi recusado (#89). */
export type RestoreRefusal = "not_found" | "already_current" | "sync_running";

/**
 * Voltar a uma versão (#89, ADR 0015): só troca a versão atual, sem destilar de novo. As leituras,
 * a navegação e as pendências seguem a versão que passa a valer, e o `log` dela registra a troca
 * (`wiki_restores`, lido por `withRestores`). Pela trava da Wiki, e nunca com uma Sincronização em
 * curso: ela trabalha sobre a versão atual.
 */
export async function restoreVersion(
  db: Db,
  input: { wikiId: string; number: number; by: string; now: Date },
): Promise<"restored" | RestoreRefusal> {
  return db.transaction(async (tx) => {
    if (!(await lockIdleWiki(tx, input.wikiId))) return "sync_running";
    const target = await versionNumbered(tx, input.wikiId, input.number);
    if (!target) return "not_found";
    const current = await currentVersionId(tx, input.wikiId);
    if (!current || target === current) return "already_current";
    await tx.insert(wikiRestores).values({
      id: crypto.randomUUID(),
      wikiId: input.wikiId,
      fromVersionId: current,
      toVersionId: target,
      byMemberId: input.by,
      at: input.now,
    });
    await tx.update(wikis).set({ currentVersionId: target }).where(eq(wikis.id, input.wikiId));
    return "restored";
  });
}
