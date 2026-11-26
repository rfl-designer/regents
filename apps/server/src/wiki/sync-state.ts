import type { WikiSyncDto } from "@shearim/contracts";
import { desc, eq, type SQL } from "drizzle-orm";
import { type Db, schema } from "../db/client";

const { wikiSyncs, wikiVersions, members } = schema;

/** As Sincronizações que atendem a `where`, da mais nova para a mais velha, como a tela as mostra. */
async function selectSyncs(db: Db, where: SQL, limit?: number): Promise<WikiSyncDto[]> {
  const query = db
    .select({
      sync: wikiSyncs,
      starterName: members.displayName,
      version: wikiVersions.number,
    })
    .from(wikiSyncs)
    .innerJoin(members, eq(members.id, wikiSyncs.startedByMemberId))
    .leftJoin(wikiVersions, eq(wikiVersions.syncId, wikiSyncs.id))
    .where(where)
    .orderBy(desc(wikiSyncs.seq));
  const rows = await (limit ? query.limit(limit) : query);
  return rows.map(({ sync: s, starterName, version }) => ({
    id: s.id,
    wikiId: s.wikiId,
    state: s.state,
    step: s.step,
    reason: s.reason,
    report: s.report,
    version: version ?? null,
    payer: s.payer,
    attempt: s.attempt,
    startedBy: { id: s.startedByMemberId, name: starterName },
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
  }));
}

/** Uma Sincronização pelo id (relida na hora: o anúncio sai com o estado de agora). */
export async function syncDto(db: Db, id: string): Promise<WikiSyncDto | undefined> {
  const [found] = await selectSyncs(db, eq(wikiSyncs.id, id), 1);
  return found;
}

/** A Sincronização mais recente da Wiki (em curso ou terminada), ou nula. */
export async function lastSyncOf(db: Db, wikiId: string): Promise<WikiSyncDto | null> {
  const [found] = await selectSyncs(db, eq(wikiSyncs.wikiId, wikiId), 1);
  return found ?? null;
}
