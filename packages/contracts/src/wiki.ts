/**
 * Contratos da Wiki (spec #74, ADR 0014 e 0015): a Wiki, as Fontes e as pendências. Reexportados
 * por `./index`.
 */

/** A Wiki na administração (#78) e, depois, no PWA. */
export const WIKIS_PATH = "/wikis";

/** Pública: todo Membro. Restrita: só uma lista de Membros (a lista vem num ticket próximo). */
export type WikiScope = "public" | "restricted";

/** A versão atual da Wiki: a que a última Sincronização concluída publicou. */
export interface WikiVersionSummaryDto {
  number: number;
  publishedAt: string;
}

/**
 * Uma Wiki: `GET /api/wiki-settings` (a lista da administração, que o Admin vê inteira, mesmo as
 * restritas) e a resposta de `POST /api/wikis`. `currentVersion` nulo = "nunca sincronizada".
 * `pending` é quantas Fontes a próxima Sincronização leva (novas e a remover).
 */
export interface WikiDto {
  id: string;
  name: string;
  description: string;
  scope: WikiScope;
  currentVersion: WikiVersionSummaryDto | null;
  pending: number;
  createdAt: string;
}

/** `POST /api/wikis` (só Admin). O nome é único sem diferenciar maiúsculas (`409 name_taken`). */
export interface CreateWikiInput {
  name: string;
  description: string;
}

export type WikiSourceFormat = "txt" | "md";
export type WikiSourceState = "active" | "removed";

/**
 * O que a próxima Sincronização faz com a Fonte, derivado (e não guardado): uma Fonte ativa que a
 * versão atual não reflete é "nova" (`new`); uma removida que a versão atual reflete é "a
 * remover" (`removal`). `null` = nada a fazer.
 */
export type WikiSourcePending = "new" | "removal" | null;

/**
 * Uma Fonte de uma Wiki, sem o texto (ele não muda depois de subir). `GET /api/wikis/:id/sources`
 * e a resposta de `POST /api/wikis/:id/sources` (multipart, um ou vários campos `files`; só Admin).
 * `sizeBytes` é o tamanho do texto em UTF-8.
 */
export interface WikiSourceDto {
  id: string;
  wikiId: string;
  fileName: string;
  format: WikiSourceFormat;
  sizeBytes: number;
  state: WikiSourceState;
  pending: WikiSourcePending;
  uploadedBy: { id: string; name: string };
  uploadedAt: string;
}

/** O tamanho de uma Fonte para gente ler: 1000 bytes = 1 KB, como o Finder mostra. */
export function formatBytes(bytes: number): string {
  const n = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${n(bytes / 1000)} KB`;
  return `${n(bytes / 1_000_000)} MB`;
}
