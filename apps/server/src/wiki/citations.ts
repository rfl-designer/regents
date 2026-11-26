import { veiledWikiMarker, type WikiCitationDto, wikiCitationMarkers } from "@regents/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Db, schema, type Tx } from "../db/client";
import type { ToolRun } from "../tools/port";
import type { WikiInReach } from "./reach";
import { readableBy } from "./wikis";

const { wikiReads, messageWikiCitations, wikis, wikiVersions, wikiPages } = schema;

/** Guarda a leitura de uma página por "ler a Wiki", na tentativa da execução (#85). */
export async function recordWikiRead(db: Db, run: ToolRun, wiki: WikiInReach, slug: string) {
  await db.insert(wikiReads).values({
    id: crypto.randomUUID(),
    executionId: run.executionId,
    attempt: run.attempt,
    wikiId: wiki.id,
    versionId: wiki.versionId,
    slug,
  });
}

/**
 * Ao gravar a resposta (spec #74, "Citação"): confere cada marcador `[[wiki:<nome>/<slug>]]` do
 * corpo contra as páginas que a tentativa leu e guarda as citações válidas (a Wiki, o slug e a
 * versão lida). A mesma página lida duas vezes vale pela última leitura.
 */
export async function recordWikiCitations(
  tx: Tx,
  reply: { messageId: string; executionId: string; attempt: number; body: string },
) {
  const markers = wikiCitationMarkers(reply.body);
  if (markers.length === 0) return;
  const reads = await tx
    .select({ wikiId: wikiReads.wikiId, name: wikis.name, versionId: wikiReads.versionId, slug: wikiReads.slug })
    .from(wikiReads)
    .innerJoin(wikis, eq(wikis.id, wikiReads.wikiId))
    .where(and(eq(wikiReads.executionId, reply.executionId), eq(wikiReads.attempt, reply.attempt)))
    .orderBy(asc(wikiReads.seq));
  const rows = markers.flatMap(({ marker, wiki, slug }) => {
    const read = reads.findLast((r) => r.name.toLowerCase() === wiki.toLowerCase() && r.slug === slug);
    return read ? [{ messageId: reply.messageId, marker, wikiId: read.wikiId, versionId: read.versionId, slug }] : [];
  });
  if (rows.length) await tx.insert(messageWikiCitations).values(rows).onConflictDoNothing();
}

/** Uma resposta com citações, como quem vê a recebe: o corpo (sem o nome das Wikis que ele não lê) e as citações. */
export type CitedReply = { body: string; citations: WikiCitationDto[] };

/**
 * As citações de cada resposta, como `viewerId` as vê (sem ele, a cópia de todos: só as Wikis
 * públicas abrem). Uma por marcador, na ordem: com link quando quem vê lê a Wiki; sem link e sem o
 * nome quando não lê ou quando a Wiki foi apagada (o marcador do corpo também perde o nome); "não
 * consultada" (sem o nome da Wiki) quando a execução não leu a página.
 */
export async function wikiCitationsOf(
  db: Db,
  replies: { id: string; body: string }[],
  viewerId: string | null,
): Promise<Map<string, CitedReply>> {
  const withMarkers = replies.filter((r) => wikiCitationMarkers(r.body).length > 0);
  const result = new Map<string, CitedReply>();
  if (withMarkers.length === 0) return result;
  const rows = await db
    .select({
      messageId: messageWikiCitations.messageId,
      marker: messageWikiCitations.marker,
      slug: messageWikiCitations.slug,
      wikiId: wikis.id,
      wikiName: wikis.name,
      scope: wikis.scope,
      version: wikiVersions.number,
      title: wikiPages.title,
    })
    .from(messageWikiCitations)
    // A Wiki apagada deixa a citação sem Wiki e sem versão (`set null`): ela fica sem link e sem nome.
    .leftJoin(wikis, eq(wikis.id, messageWikiCitations.wikiId))
    .leftJoin(wikiVersions, eq(wikiVersions.id, messageWikiCitations.versionId))
    .leftJoin(
      wikiPages,
      and(eq(wikiPages.versionId, messageWikiCitations.versionId), eq(wikiPages.slug, messageWikiCitations.slug)),
    )
    .where(
      inArray(
        messageWikiCitations.messageId,
        withMarkers.map((r) => r.id),
      ),
    );
  const readable = new Map<string, boolean>();
  const reads = async (wiki: { id: string; scope: "public" | "restricted" }) => {
    if (!readable.has(wiki.id)) {
      readable.set(wiki.id, wiki.scope === "public" || (viewerId !== null && (await readableBy(db, wiki, viewerId))));
    }
    return readable.get(wiki.id)!;
  };
  for (const reply of withMarkers) {
    const citations: WikiCitationDto[] = [];
    let body = reply.body;
    for (const { marker } of wikiCitationMarkers(reply.body)) {
      const row = rows.find((r) => r.messageId === reply.id && r.marker === marker);
      if (!row) citations.push({ marker, state: "not_consulted" });
      else if (
        row.wikiId &&
        row.wikiName &&
        row.scope &&
        row.version !== null &&
        row.title !== null &&
        (await reads({ id: row.wikiId, scope: row.scope }))
      ) {
        const { wikiId, wikiName, slug, version, title } = row;
        citations.push({ marker, state: "linked", wikiId, wikiName, slug, version, title });
      } else {
        const veiled = veiledWikiMarker(row.slug);
        body = body.replaceAll(marker, veiled);
        citations.push({ marker: veiled, state: "unlinked", slug: row.slug });
      }
    }
    result.set(reply.id, { body, citations });
  }
  return result;
}
