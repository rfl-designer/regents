import type { WikiDto, WikiSourcePending, WikiSourceState } from "@shearim/contracts";
import { asc, eq, isNotNull, sql } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";
import { activeAdminIds } from "../members";
import { inWikiList, wikiListIds } from "./reach";
import { lastSyncOf } from "./sync-state";
import { currentVersionId, currentVersionSummary, sourcesOfVersion } from "./versions";

const { wikis, wikiSources } = schema;

/**
 * A pendência de uma Fonte, derivada da versão atual (spec #74): ativa e fora da versão é "nova";
 * removida e refletida pela versão é "a remover". `reflected` são os ids das Fontes que a versão
 * atual reflete (vazio enquanto a Wiki nunca foi sincronizada).
 */
export function pendingOf(source: { id: string; state: WikiSourceState }, reflected: ReadonlySet<string>) {
  const inVersion = reflected.has(source.id);
  if (source.state === "active" && !inVersion) return "new" satisfies WikiSourcePending;
  if (source.state === "removed" && inVersion) return "removal" satisfies WikiSourcePending;
  return null;
}

/**
 * Os ids das Fontes que a versão atual da Wiki reflete. Sem Sincronização concluída, não há
 * versão: nenhuma. Voltar a uma versão (#89) troca a atual, e as pendências seguem sozinhas.
 */
export async function reflectedSources(db: Db, wikiId: string): Promise<ReadonlySet<string>> {
  return sourcesOfVersion(db, await currentVersionId(db, wikiId));
}

/** Uma Wiki pelo id. */
export async function findWiki(db: Db, id: string) {
  if (!isUuid(id)) return undefined;
  const [wiki] = await db.select().from(wikis).where(eq(wikis.id, id));
  return wiki;
}

/** A Wiki com este nome, sem diferenciar maiúsculas. */
export async function wikiNamed(db: Db, name: string) {
  const [wiki] = await db
    .select()
    .from(wikis)
    .where(eq(sql`lower(${wikis.name})`, name.toLowerCase()));
  return wiki;
}

export async function toWikiDto(db: Db, wiki: typeof wikis.$inferSelect): Promise<WikiDto> {
  const reflected = await reflectedSources(db, wiki.id);
  const sources = await db
    .select({ id: wikiSources.id, state: wikiSources.state })
    .from(wikiSources)
    .where(eq(wikiSources.wikiId, wiki.id));
  return {
    id: wiki.id,
    name: wiki.name,
    description: wiki.description,
    scope: wiki.scope,
    currentVersion: await currentVersionSummary(db, wiki.id),
    pending: sources.filter((s) => pendingOf(s, reflected) !== null).length,
    lastSync: await lastSyncOf(db, wiki.id),
    createdAt: wiki.createdAt.toISOString(),
  };
}

/** Todas as Wikis, por nome (a lista da administração: o Admin vê todas, mesmo as restritas). */
export async function listWikis(db: Db): Promise<WikiDto[]> {
  const all = await db
    .select()
    .from(wikis)
    .orderBy(asc(sql`lower(${wikis.name})`));
  return Promise.all(all.map((w) => toWikiDto(db, w)));
}

/**
 * Se o Membro lê a Wiki fora da administração (a barra lateral e a leitura das páginas): o ponto
 * único do alcance (ADR 0014). A pública, todo Membro; a restrita, só quem está na lista. O Admin
 * não lê uma restrita por ser Admin: só na administração.
 */
export async function readableBy(
  db: Db,
  wiki: Pick<typeof wikis.$inferSelect, "id" | "scope">,
  memberId: string,
): Promise<boolean> {
  return wiki.scope === "public" || inWikiList(db, wiki.id, memberId);
}

/** A Wiki que o Membro lê: no alcance dele e com versão publicada. Fora disso, nada. */
export async function readableWiki(db: Db, id: string, memberId: string) {
  const wiki = await findWiki(db, id);
  if (!wiki?.currentVersionId || !(await readableBy(db, wiki, memberId))) return undefined;
  return wiki;
}

/** As Wikis que o Membro lê (a seção "Wikis" da barra lateral), por nome. */
export async function listReadableWikis(db: Db, memberId: string): Promise<WikiDto[]> {
  const all = await db
    .select()
    .from(wikis)
    .where(isNotNull(wikis.currentVersionId))
    .orderBy(asc(sql`lower(${wikis.name})`));
  const readable = [];
  for (const w of all) if (await readableBy(db, w, memberId)) readable.push(w);
  return Promise.all(readable.map((w) => toWikiDto(db, w)));
}

/** Cria uma Wiki pública. `undefined` quando o nome já existe (sem diferenciar maiúsculas). */
export async function createWiki(
  db: Db,
  input: { name: string; description: string; by: string; now: Date },
): Promise<WikiDto | undefined> {
  const [wiki] = await db
    .insert(wikis)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      createdByMemberId: input.by,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return wiki && toWikiDto(db, wiki);
}

/**
 * Quem vê a Wiki, para os eventos em tempo real: a pública, todo Membro; a restrita, os Membros da
 * lista (a barra lateral e a leitura) e os Admins (que veem toda Wiki na administração). Quem está
 * fora não recebe nada dela, nem o nome.
 */
export async function wikiAudience(
  db: Db,
  wiki: Pick<typeof wikis.$inferSelect, "id" | "scope">,
): Promise<"everyone" | { members: string[] }> {
  if (wiki.scope === "public") return "everyone";
  return { members: [...new Set([...(await activeAdminIds(db)), ...(await wikiListIds(db, wiki.id))])] };
}
