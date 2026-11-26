import type { WikiDto, WikiSourcePending, WikiSourceState } from "@shearim/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";

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
 * Os ids das Fontes que a versão atual da Wiki reflete. Sem Sincronização ainda, não há versão:
 * nenhuma. (A versão e o conjunto de Fontes dela vêm com a Sincronização.)
 */
export async function reflectedSources(_db: Db, _wikiId: string): Promise<ReadonlySet<string>> {
  return new Set();
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

async function toWikiDto(db: Db, wiki: typeof wikis.$inferSelect): Promise<WikiDto> {
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
    currentVersion: null,
    pending: sources.filter((s) => pendingOf(s, reflected) !== null).length,
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
