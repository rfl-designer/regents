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

/**
 * Uma Wiki na tela do Agente (#84): `GET /api/agents/:id/wikis` e a resposta de
 * `PUT`/`DELETE /api/agents/:id/wikis/:wikiId` (só Admin). Lista todas as Wikis do Workspace, por
 * nome, com a marca de ligada. O Agente ligado consulta a Wiki em qualquer conversa, a DM
 * inclusive, dentro do alcance dela (`scope`).
 */
export interface AgentWikiDto {
  id: string;
  name: string;
  description: string;
  scope: WikiScope;
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
 * `DELETE /api/wikis/:id/sources/:sourceId` remove uma (só Admin, sem Sincronização em curso) e
 * devolve a lista nova. A lista tem as ativas e as removidas "a remover"; a removida que a versão
 * atual já não reflete não aparece. `sizeBytes` é o tamanho do texto em UTF-8.
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
  | {
      kind: "source";
      current: number;
      total: number;
      fileName: string;
      /** A parte em curso de uma Fonte grande, dividida em partes (#87); ausente numa Fonte que vai inteira. */
      part?: { current: number; total: number };
    }
  | { kind: "review" }
  | { kind: "publishing" };

/** Uma página citada no relatório. */
export interface WikiPageRefDto {
  slug: string;
  title: string;
}

/** Uma contradição que a revisão da Sincronização apontou (#87): as páginas e o que se contradiz. */
export interface WikiContradictionDto {
  pages: WikiPageRefDto[];
  text: string;
}

/**
 * A conferência em código do fim da Sincronização (#87), sobre as páginas da versão nova, sem o
 * índice e o `log`. Ela não impede a publicação: só entra no relatório.
 * - `brokenLinks`: cada link `[[slug]]` para uma página que não existe (`from`, a página que liga).
 * - `withoutSources`: as páginas sem nenhuma Fonte.
 * - `outsideIndex`: as páginas que o índice não liga.
 * - `orphans`: as páginas que nenhuma outra página liga (o índice e o `log` não contam).
 */
export interface WikiCheckDto {
  brokenLinks: { from: WikiPageRefDto; slug: string }[];
  withoutSources: WikiPageRefDto[];
  outsideIndex: WikiPageRefDto[];
  orphans: WikiPageRefDto[];
}

/**
 * O relatório de uma Sincronização concluída: o que mudou da versão atual para a nova, as
 * contradições que a revisão apontou e a conferência em código.
 */
export interface WikiSyncReportDto {
  created: WikiPageRefDto[];
  updated: WikiPageRefDto[];
  removed: WikiPageRefDto[];
  contradictions: WikiContradictionDto[];
  check: WikiCheckDto;
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
  /**
   * Quem paga a chamada em curso (ou a última): `account` (a Conta de quem iniciou) ou `key` (a
   * Chave do Workspace, "pela Chave do Workspace"), decidido a cada chamada. Nulo antes da primeira.
   */
  payer: "account" | "key" | null;
  /**
   * A tentativa da chamada em curso: 2 quando a chamada falhou uma vez e espera ou faz a nova
   * tentativa automática (com o motivo da falha em `reason`). Uma segunda falha encerra a
   * Sincronização em `failed`.
   */
  attempt: number;
  startedBy: { id: string; name: string };
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Uma versão da Wiki: `GET /api/wikis/:id/versions` (só Admin), da mais nova para a mais velha. A
 * mesma lista é a resposta de `POST /api/wikis/:id/versions/:n/restore` ("voltar a esta versão",
 * #89), que só troca a versão atual: `404` sem a versão, `409 already_current` quando ela já é a
 * atual e `409 sync_running` com uma Sincronização em curso.
 */
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
 * Uma página para o Membro ler: `GET /api/wikis/:id/pages/:slug` (a versão atual) e
 * `GET /api/wikis/:id/versions/:n/pages/:slug` (a versão `n`, que a citação abre), para quem a Wiki
 * alcança; `404` com a mensagem fora disso. `version` é o número da versão lida (#85: a citação
 * abre uma versão antiga, e `wiki.currentVersion` diz se há uma mais nova). `links` são os links
 * do corpo, na ordem, sem repetir, cada um com o título da página ou `null` se ela não existe na
 * versão lida.
 */
export interface WikiPageViewDto {
  wiki: WikiDto;
  version: number;
  /** A página existe na versão atual (na leitura de uma versão antiga, o aviso leva a ela ou ao índice). */
  inCurrentVersion: boolean;
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

/**
 * A leitura da Wiki no PWA (#82): `/wiki/<id>/<slug>` (a versão atual; sem slug, o índice) e
 * `/wiki/<id>/versoes/<n>/<slug>` (a versão `n`, que a citação abre, #85).
 */
export const WIKI_READ_PREFIX = "/wiki/";

export function wikiPagePath(wikiId: string, slug: string = WIKI_INDEX_SLUG, version?: number): string {
  const at = version === undefined ? "" : `versoes/${version}/`;
  return `${WIKI_READ_PREFIX}${wikiId}/${at}${encodeURIComponent(slug)}`;
}

/** A página que o endereço pede (`version` só na de uma versão), ou `null`. */
export function wikiPageOfPath(pathname: string): { wikiId: string; slug: string; version?: number } | null {
  if (!pathname.startsWith(WIKI_READ_PREFIX)) return null;
  const parts = pathname.slice(WIKI_READ_PREFIX.length).split("/");
  const [wikiId] = parts;
  if (!wikiId) return null;
  if (parts[1] === "versoes" && parts.length >= 4) {
    const version = Number(parts[2]);
    if (!Number.isInteger(version) || version < 1) return null;
    return { wikiId, slug: parts[3] ? decodeURIComponent(parts[3]) : WIKI_INDEX_SLUG, version };
  }
  return { wikiId, slug: parts[1] ? decodeURIComponent(parts[1]) : WIKI_INDEX_SLUG };
}

// ---------- Citação (#85) ----------

/**
 * Uma citação da Wiki numa resposta de Agente, como quem vê a mensagem a recebe: uma por marcador
 * `[[wiki:<nome>/<slug>]]` do corpo, na ordem, sem repetir (`marker` é o marcador exato).
 * - `linked`: a execução leu a página, e quem vê lê a Wiki: o link abre a página na versão lida.
 * - `unlinked`: a execução leu a página, mas quem vê não lê a Wiki: a citação, sem link.
 * - `not_consulted`: a execução não leu a página (ou a Wiki está fora do alcance): "não
 *   consultada", sem link e sem o nome da Wiki.
 */
export type WikiCitationDto =
  | {
      marker: string;
      state: "linked";
      wikiId: string;
      wikiName: string;
      slug: string;
      version: number;
      title: string;
    }
  | { marker: string; state: "unlinked"; wikiName: string; slug: string }
  | { marker: string; state: "not_consulted" };

/** Um pedaço do corpo de uma resposta: texto puro, ou um marcador de citação `[[wiki:<nome>/<slug>]]`. */
export type WikiCitationPart = { text: string } | { marker: string; wiki: string; slug: string };

const WIKI_CITATION = /\[\[wiki:([^[\]/]+)\/([^[\]]+)\]\]/g;

/** O corpo em pedaços: o texto e os marcadores de citação, na ordem. */
export function wikiCitationParts(body: string): WikiCitationPart[] {
  const parts: WikiCitationPart[] = [];
  let last = 0;
  for (const m of body.matchAll(WIKI_CITATION)) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index) });
    parts.push({ marker: m[0], wiki: m[1]!.trim(), slug: m[2]!.trim() });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** Os marcadores de citação do corpo, na ordem, sem repetir. */
export function wikiCitationMarkers(body: string): { marker: string; wiki: string; slug: string }[] {
  const seen = new Map<string, { marker: string; wiki: string; slug: string }>();
  for (const p of wikiCitationParts(body)) if ("marker" in p && !seen.has(p.marker)) seen.set(p.marker, p);
  return [...seen.values()];
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
  if (step.kind === "source") {
    const part = step.part ? `, parte ${step.part.current} de ${step.part.total}` : "";
    return `em curso: Fonte ${step.current} de ${step.total}${part}`;
  }
  return step.kind === "review" ? "revisando a Wiki" : "publicando";
}

/** Quem paga, para gente ler: "pela Chave do Workspace" quando a Chave paga; pela Conta, nada. */
export function wikiSyncPayerText(sync: Pick<WikiSyncDto, "payer">): string | null {
  return sync.payer === "key" ? "pela Chave do Workspace" : null;
}
