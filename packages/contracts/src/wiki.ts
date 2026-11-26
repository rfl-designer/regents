/**
 * Contratos da Wiki (spec #74, ADR 0014 e 0015): a Wiki, as Fontes e as pendências. Reexportados
 * por `./index`.
 */

/** A Wiki na administração (#78) e, depois, no PWA. */
export const WIKIS_PATH = "/wikis";

/** Pública: todo Membro. Restrita: só uma lista de Membros (`WikiReachDto`). */
export type WikiScope = "public" | "restricted";

/** A versão atual da Wiki: a que a última Sincronização concluída publicou. */
export interface WikiVersionSummaryDto {
  number: number;
  publishedAt: string;
}

/** Os slugs das páginas especiais de toda versão: o índice (da Articuladora) e o registro (do Shearim). */
export const WIKI_INDEX_SLUG = "index";
export const WIKI_LOG_SLUG = "log";

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
  /** A Sincronização mais recente (em curso ou terminada), ou nula se nunca houve uma. */
  lastSync: WikiSyncDto | null;
  createdAt: string;
}

/** `POST /api/wikis` (só Admin). O nome é único sem diferenciar maiúsculas (`409 name_taken`). */
export interface CreateWikiInput {
  name: string;
  description: string;
}

/**
 * Um Canal na tela de ligações da Wiki: `GET /api/wikis/:id/channels` e a resposta de
 * `PUT`/`DELETE /api/wikis/:id/channels/:channelId` (só Admin). Lista os Canais que o Admin vê
 * (os públicos e os privados de que ele participa), por nome, com a marca de ligado. Todo Agente
 * que responde num Canal ligado consulta a Wiki ali, dentro do alcance dela.
 */
export interface WikiChannelDto {
  id: string;
  name: string;
  kind: "public" | "private";
  linked: boolean;
}

/** Um Membro na tela do alcance da Wiki, com a marca de quem está na lista. */
export interface WikiReachMemberDto {
  id: string;
  name: string;
  inList: boolean;
}

/**
 * O alcance da Wiki (#83): `GET /api/wikis/:id/reach` e a resposta de `PUT` (só Admin). Lista os
 * Membros ativos, por nome, com a marca de quem está na lista. A restrita só é lida numa resposta
 * em que o autor e todos os que veem a conversa estão na lista; na pública, a lista não conta.
 * Fora de `WikiDto` de propósito: a lista é só da administração.
 */
export interface WikiReachDto {
  scope: WikiScope;
  members: WikiReachMemberDto[];
}

/** `PUT /api/wikis/:id/reach` (só Admin): troca o alcance e a lista inteira. */
export interface SetWikiReachInput {
  scope: WikiScope;
  memberIds: string[];
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

// ---------- Sincronização (ADR 0015) ----------

/**
 * Em que pé está a Sincronização: `queued` (pedida), `running` (em curso), `done` (publicou uma
 * versão), `failed` (com o motivo) ou `canceled`. Só uma por Wiki fica em `queued` ou `running`.
 */
export type WikiSyncState = "queued" | "running" | "done" | "failed" | "canceled";

/**
 * O passo da Sincronização em curso: `source` ("em curso: Fonte 1 de 2", com o nome do arquivo),
 * `review` ("revisando a Wiki") ou `publishing` ("publicando").
 */
export type WikiSyncStepDto =
  | { kind: "source"; current: number; total: number; fileName: string }
  | { kind: "review" }
  | { kind: "publishing" };

/** Uma página citada no relatório. */
export interface WikiPageRefDto {
  slug: string;
  title: string;
}

/** O relatório de uma Sincronização concluída: o que mudou da versão anterior para a nova. */
export interface WikiSyncReportDto {
  created: WikiPageRefDto[];
  updated: WikiPageRefDto[];
  removed: WikiPageRefDto[];
}

/**
 * Uma Sincronização: a resposta de `POST /api/wikis/:id/sync` (202) e o `lastSync` da Wiki, e vai
 * em tempo real (`wiki_sync.updated`) para quem vê a Wiki. `version` é o número da versão que ela
 * publicou (só em `done`).
 */
export interface WikiSyncDto {
  id: string;
  wikiId: string;
  state: WikiSyncState;
  step: WikiSyncStepDto | null;
  reason: string | null;
  report: WikiSyncReportDto | null;
  version: number | null;
  startedBy: { id: string; name: string };
  createdAt: string;
  finishedAt: string | null;
}

/** Uma versão da Wiki: `GET /api/wikis/:id/versions` (só Admin), da mais nova para a mais velha. */
export interface WikiVersionDto {
  number: number;
  publishedAt: string;
  startedBy: { id: string; name: string };
  report: WikiSyncReportDto;
  /** É a versão atual da Wiki. */
  current: boolean;
}

/**
 * Uma página de uma versão: `GET /api/wikis/:id/versions/:n/pages` (só Admin, por slug). O corpo é
 * markdown com links `[[slug]]` (ou `[[slug|texto]]`) para outras páginas. `sources` são as Fontes
 * de onde ela veio (vazio só no `log`, que é do Shearim).
 */
export interface WikiPageDto {
  slug: string;
  title: string;
  body: string;
  sources: { id: string; fileName: string }[];
}

/** Um link `[[slug]]` de uma página: o título da página ligada, ou `null` (link quebrado). */
export interface WikiLinkDto {
  slug: string;
  title: string | null;
}

/**
 * Uma página para o Membro ler: `GET /api/wikis/:id/pages/:slug` (a versão atual, para quem a Wiki
 * alcança; `404` com a mensagem fora disso). `version` é o número da versão lida (#85: a citação
 * abre uma versão antiga, e `wiki.currentVersion` diz se há uma mais nova). `links` são os links
 * do corpo, na ordem, sem repetir, cada um com o título da página ou `null` se ela não existe na
 * versão lida.
 */
export interface WikiPageViewDto {
  wiki: WikiDto;
  version: number;
  page: WikiPageDto;
  links: WikiLinkDto[];
}

/** Um pedaço do corpo de uma página: texto puro, ou um link `[[slug]]` / `[[slug|texto]]`. */
export type WikiBodyPart = { text: string } | { slug: string; label: string | null };

const WIKI_LINK = /\[\[([^[\]|]+?)(?:\|([^[\]]*))?\]\]/g;

/** O corpo da página em pedaços: o texto e os links `[[slug]]` (ou `[[slug|texto]]`), na ordem. */
export function wikiBodyParts(body: string): WikiBodyPart[] {
  const parts: WikiBodyPart[] = [];
  let last = 0;
  for (const m of body.matchAll(WIKI_LINK)) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index) });
    parts.push({ slug: m[1]!.trim(), label: m[2]?.trim() || null });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** Os slugs que o corpo liga, na ordem, sem repetir. */
export function wikiLinkSlugs(body: string): string[] {
  const slugs = wikiBodyParts(body).flatMap((p) => ("slug" in p ? [p.slug] : []));
  return [...new Set(slugs)];
}

/** A leitura da Wiki no PWA (#82): `/wiki/<id>/<slug>` (sem slug, o índice). */
export const WIKI_READ_PREFIX = "/wiki/";

export function wikiPagePath(wikiId: string, slug: string = WIKI_INDEX_SLUG): string {
  return `${WIKI_READ_PREFIX}${wikiId}/${encodeURIComponent(slug)}`;
}

/** A página que o endereço pede (`/wiki/<id>/<slug>`), ou `null`. */
export function wikiPageOfPath(pathname: string): { wikiId: string; slug: string } | null {
  if (!pathname.startsWith(WIKI_READ_PREFIX)) return null;
  const [wikiId, slug] = pathname.slice(WIKI_READ_PREFIX.length).split("/");
  if (!wikiId) return null;
  return { wikiId, slug: slug ? decodeURIComponent(slug) : WIKI_INDEX_SLUG };
}

/** O que muda na Wiki em tempo real, para quem a vê. */
export type WikiServerEvent =
  /** O estado ou o passo de uma Sincronização mudou (relido na hora: chega em ordem). */
  | { type: "wiki_sync.updated"; sync: WikiSyncDto }
  /** A Wiki mudou (uma versão nova, as pendências). */
  | { type: "wiki.updated"; wiki: WikiDto }
  /**
   * A Wiki saiu do alcance de quem recebe (o Admin a restringiu a uma lista sem ele): a barra
   * lateral se relê. Só o id, para não contar nada da Wiki a quem não a vê mais.
   */
  | { type: "wiki.left"; wikiId: string };

/** O passo para gente ler: "em curso: Fonte 1 de 2", "revisando a Wiki", "publicando". */
export function wikiSyncStepText(step: WikiSyncStepDto): string {
  if (step.kind === "source") return `em curso: Fonte ${step.current} de ${step.total}`;
  return step.kind === "review" ? "revisando a Wiki" : "publicando";
}
