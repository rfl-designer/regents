import {
  WIKI_INDEX_SLUG,
  WIKI_LOG_SLUG,
  type WikiCheckDto,
  type WikiContradictionDto,
  type WikiPageRefDto,
  type WikiSyncReportDto,
  wikiLinkSlugs,
} from "@shearim/contracts";
import type { ExecutionTools, ToolResult, ToolSpec } from "../tools/port";
import { POINT_CONTRADICTION, READ_PAGE, REMOVE_PAGE, WRITE_PAGE } from "./rules";

/** Uma página no rascunho: o título, o corpo e os ids das Fontes de onde ela veio. */
export interface DraftPage {
  title: string;
  body: string;
  sources: string[];
}

/** Uma contradição que a revisão apontou, pelos slugs (o título entra no relatório, no fim). */
interface DraftContradiction {
  slugs: string[];
  text: string;
}

/** O estado do rascunho num ponto, para voltar a ele: as páginas e as contradições apontadas. */
export interface DraftSnapshot {
  pages: Map<string, DraftPage>;
  contradictions: DraftContradiction[];
}

/** Uma Fonte que o rascunho conhece (as que a versão nova vai refletir). */
export interface DraftSource {
  id: string;
  fileName: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;
const TITLE_MAX = 200;

/**
 * O rascunho da Sincronização (ADR 0015): uma cópia das páginas da versão atual, que ninguém lê.
 * Fica na memória do processo: a publicação grava a versão inteira numa transação só, e uma falha,
 * um cancelamento ou um reinício o descartam sem deixar nada pela metade.
 */
export class Draft {
  readonly pages: Map<string, DraftPage>;
  /** As contradições que a revisão (#87) apontou, na ordem. */
  contradictions: DraftContradiction[] = [];

  constructor(
    readonly base: ReadonlyMap<string, DraftPage>,
    readonly sources: readonly DraftSource[],
  ) {
    this.pages = new Map([...base].map(([slug, p]) => [slug, { ...p, sources: [...p.sources] }]));
  }

  /** Uma cópia do estado de agora, para voltar a ele (a nova tentativa de uma chamada, #86). */
  snapshot(): DraftSnapshot {
    return {
      pages: new Map([...this.pages].map(([slug, p]) => [slug, { ...p, sources: [...p.sources] }])),
      contradictions: this.contradictions.map((c) => ({ ...c, slugs: [...c.slugs] })),
    };
  }

  restore(snapshot: DraftSnapshot) {
    this.pages.clear();
    for (const [slug, p] of snapshot.pages) this.pages.set(slug, { ...p, sources: [...p.sources] });
    this.contradictions = snapshot.contradictions.map((c) => ({ ...c, slugs: [...c.slugs] }));
  }

  /**
   * Tira uma Fonte removida do rascunho (#88): a página que vinha só dela sai; a que vinha dela e de
   * outra perde a Fonte e fica para a Articuladora reescrever sem ela. O índice e o log nunca saem.
   * Depois disso, nenhuma página do rascunho cita a Fonte, e a escrita não aceita o nome dela
   * (ela não está em `sources`).
   */
  takeOut(sourceId: string): { removed: string[]; rewrite: string[] } {
    const removed: string[] = [];
    const rewrite: string[] = [];
    for (const [slug, page] of [...this.pages]) {
      if (!page.sources.includes(sourceId)) continue;
      const rest = page.sources.filter((id) => id !== sourceId);
      const special = slug === WIKI_INDEX_SLUG || slug === WIKI_LOG_SLUG;
      if (rest.length === 0 && !special) {
        this.pages.delete(slug);
        removed.push(slug);
        continue;
      }
      this.pages.set(slug, { ...page, sources: rest });
      if (!special) rewrite.push(slug);
    }
    return { removed: removed.sort(), rewrite: rewrite.sort() };
  }

  fileNameOf(sourceId: string) {
    return this.sources.find((s) => s.id === sourceId)?.fileName ?? "uma Fonte removida";
  }

  /**
   * O relatório: o que mudou da versão de base (a atual) para o rascunho, sem as páginas especiais,
   * as contradições que a revisão apontou e a conferência em código (`check`).
   */
  report(): WikiSyncReportDto {
    const ref = (slug: string, page: DraftPage): WikiPageRefDto => ({ slug, title: page.title });
    const special = (slug: string) => slug === WIKI_INDEX_SLUG || slug === WIKI_LOG_SLUG;
    const bySlug = (a: WikiPageRefDto, b: WikiPageRefDto) => a.slug.localeCompare(b.slug);
    const created: WikiPageRefDto[] = [];
    const updated: WikiPageRefDto[] = [];
    const removed: WikiPageRefDto[] = [];
    for (const [slug, page] of this.pages) {
      if (special(slug)) continue;
      const before = this.base.get(slug);
      if (!before) created.push(ref(slug, page));
      else if (!samePage(before, page)) updated.push(ref(slug, page));
    }
    for (const [slug, page] of this.base) if (!special(slug) && !this.pages.has(slug)) removed.push(ref(slug, page));
    return {
      created: created.sort(bySlug),
      updated: updated.sort(bySlug),
      removed: removed.sort(bySlug),
      contradictions: this.contradictions.map(
        (c): WikiContradictionDto => ({
          // Uma página que saiu depois de apontada fica com o slug no lugar do título.
          pages: c.slugs.map((slug) => ({ slug, title: this.pages.get(slug)?.title ?? slug })),
          text: c.text,
        }),
      ),
      check: this.check(),
    };
  }

  /** A conferência em código (#87): o que está quebrado no rascunho. Não impede a publicação. */
  check(): WikiCheckDto {
    const content = [...this.pages]
      .filter(([slug]) => slug !== WIKI_INDEX_SLUG && slug !== WIKI_LOG_SLUG)
      .sort(([a], [b]) => a.localeCompare(b));
    const ref = (slug: string, page: DraftPage): WikiPageRefDto => ({ slug, title: page.title });
    const index = this.pages.get(WIKI_INDEX_SLUG);
    const indexed = new Set(index ? wikiLinkSlugs(index.body) : []);
    // O índice também é conferido nos links (uma linha para uma página que saiu); o `log` não: é do
    // Shearim e guarda as versões antigas, que ligam páginas que já saíram.
    const brokenLinks: WikiCheckDto["brokenLinks"] = [];
    const linked = new Set<string>();
    for (const [slug, page] of [...(index ? [[WIKI_INDEX_SLUG, index] as const] : []), ...content]) {
      for (const target of wikiLinkSlugs(page.body)) {
        if (!this.pages.has(target)) brokenLinks.push({ from: ref(slug, page), slug: target });
        else if (slug !== WIKI_INDEX_SLUG && target !== slug) linked.add(target);
      }
    }
    return {
      brokenLinks,
      withoutSources: content.filter(([, p]) => p.sources.length === 0).map(([slug, p]) => ref(slug, p)),
      outsideIndex: content.filter(([slug]) => !indexed.has(slug)).map(([slug, p]) => ref(slug, p)),
      orphans: content.filter(([slug]) => !linked.has(slug)).map(([slug, p]) => ref(slug, p)),
    };
  }
}

function samePage(a: DraftPage, b: DraftPage) {
  return a.title === b.title && a.body === b.body && [...a.sources].sort().join() === [...b.sources].sort().join();
}

const SPECS: ToolSpec[] = [
  {
    name: READ_PAGE,
    title: "ler página do rascunho",
    description: "Lê uma página do rascunho da Wiki pelo slug: o título, as Fontes e o corpo em markdown.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "O slug da página (ex.: ganchos-para-reels)." } },
      required: ["slug"],
      additionalProperties: false,
    },
    origin: "workspace",
    access: "read",
  },
  {
    name: WRITE_PAGE,
    title: "escrever página do rascunho",
    description:
      "Cria uma página no rascunho da Wiki ou a substitui inteira: o slug, o título, o corpo em markdown (com links [[slug]]) e as Fontes de onde ela veio.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Minúsculas, sem acento, palavras separadas por hífen." },
        titulo: { type: "string" },
        corpo: { type: "string", description: "A página inteira em markdown, com links [[slug]]." },
        fontes: {
          type: "array",
          items: { type: "string" },
          description: "Os nomes de arquivo das Fontes de onde a página veio.",
        },
      },
      required: ["slug", "titulo", "corpo", "fontes"],
      additionalProperties: false,
    },
    origin: "workspace",
    access: "write",
  },
  {
    name: REMOVE_PAGE,
    title: "remover página do rascunho",
    description: "Remove uma página do rascunho da Wiki pelo slug. O índice e o log não se removem.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
    origin: "workspace",
    access: "write",
  },
];

/**
 * As Ferramentas internas de uma chamada da Sincronização, presas ao rascunho: ler, escrever e
 * remover página. Escritas à mão (fora da porta de Ferramentas): não vão para o Andamento de
 * nenhuma execução e nunca são oferecidas a uma resposta em conversa. `current` é a Fonte nova da
 * chamada: uma página escrita sem `fontes` vem dela (mais as que já tinha). Sem `current` (a
 * remoção de uma Fonte, a revisão), uma página escrita sem `fontes` mantém as que já tinha; uma
 * página nova assim fica sem Fonte, e a conferência (#87) a põe no relatório.
 */
export function draftTools(draft: Draft, current?: DraftSource): ExecutionTools {
  const ok = (content: string): ToolResult => ({ content, isError: false });
  const error = (content: string): ToolResult => ({ content, isError: true });
  const slugOf = (input: Record<string, unknown>) => (typeof input.slug === "string" ? input.slug.trim() : "");

  function write(input: Record<string, unknown>): ToolResult {
    const slug = slugOf(input);
    if (!SLUG.test(slug) || slug.length > SLUG_MAX) {
      return error(
        `o slug "${slug}" não vale: use minúsculas sem acento e palavras separadas por hífen, até ${SLUG_MAX} caracteres`,
      );
    }
    if (slug === WIKI_LOG_SLUG) return error("a página log é do Shearim: ela não se escreve");
    const title = typeof input.titulo === "string" ? input.titulo.trim() : "";
    if (!title || title.length > TITLE_MAX) return error(`dê um título à página, até ${TITLE_MAX} caracteres`);
    const body = typeof input.corpo === "string" ? input.corpo : "";
    if (!body.trim()) return error("o corpo da página está vazio");
    let sources: string[];
    const kept = draft.pages.get(slug)?.sources ?? [];
    if (input.fontes === undefined) {
      sources = [...new Set([...kept, ...(current ? [current.id] : [])])];
    } else {
      if (!Array.isArray(input.fontes) || input.fontes.length === 0) {
        return error("diga de quais Fontes a página veio (o nome do arquivo de cada uma)");
      }
      sources = [];
      for (const name of input.fontes) {
        const found =
          typeof name === "string" && draft.sources.find((s) => s.fileName.toLowerCase() === name.trim().toLowerCase());
        if (!found) return error(`a Fonte ${String(name)} não está nesta Wiki`);
        if (!sources.includes(found.id)) sources.push(found.id);
      }
    }
    const existed = draft.pages.has(slug);
    draft.pages.set(slug, { title, body, sources });
    return ok(existed ? `A página ${slug} foi reescrita no rascunho.` : `A página ${slug} foi criada no rascunho.`);
  }

  function read(input: Record<string, unknown>): ToolResult {
    const slug = slugOf(input);
    const page = draft.pages.get(slug);
    if (!page) return error(`a página ${slug} não existe no rascunho`);
    const sources = page.sources.map((id) => draft.fileNameOf(id)).join(", ") || "nenhuma";
    return ok(`# ${page.title}\n\nFontes: ${sources}\n\n${page.body}`);
  }

  function remove(input: Record<string, unknown>): ToolResult {
    const slug = slugOf(input);
    if (slug === WIKI_INDEX_SLUG || slug === WIKI_LOG_SLUG) return error(`a página ${slug} não se remove`);
    if (!draft.pages.delete(slug)) return error(`a página ${slug} não existe no rascunho`);
    return ok(`A página ${slug} foi removida do rascunho.`);
  }

  return {
    list: async () => SPECS,
    async call(name, input) {
      const fields =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      if (name === WRITE_PAGE) return write(fields);
      if (name === READ_PAGE) return read(fields);
      if (name === REMOVE_PAGE) return remove(fields);
      return error(`a Ferramenta ${name} não existe na Sincronização`);
    },
    // Nenhuma Ferramenta da Sincronização roda no cérebro (as da web não são oferecidas).
    track: async () => async () => {},
  };
}

const CONTRADICTION_SPEC: ToolSpec = {
  name: POINT_CONTRADICTION,
  title: "apontar contradição",
  description:
    "Aponta uma contradição entre páginas do rascunho (ou dentro de uma página): os slugs e o que se contradiz. Ela entra no relatório da Sincronização, para o Admin corrigir a Fonte.",
  inputSchema: {
    type: "object",
    properties: {
      paginas: { type: "array", items: { type: "string" }, description: "Os slugs das páginas que se contradizem." },
      descricao: { type: "string", description: "O que uma diz e o que a outra diz." },
    },
    required: ["paginas", "descricao"],
    additionalProperties: false,
  },
  origin: "workspace",
  access: "read",
};

/**
 * As Ferramentas da revisão (#87): as do rascunho, sem Fonte atual (uma página reescrita mantém as
 * Fontes que tinha), mais `apontar_contradicao`, que guarda a contradição no rascunho para o
 * relatório. A contradição tem uma descrição e só páginas que existem no rascunho.
 */
export function reviewTools(draft: Draft): ExecutionTools {
  const base = draftTools(draft);
  const error = (content: string): ToolResult => ({ content, isError: true });
  return {
    ...base,
    list: async () => [...(await base.list()), CONTRADICTION_SPEC],
    async call(name, input, signal) {
      if (name !== POINT_CONTRADICTION) return base.call(name, input, signal);
      const fields =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const text = typeof fields.descricao === "string" ? fields.descricao.trim() : "";
      if (!text) return error("descreva a contradição: o que uma página diz e o que a outra diz");
      const slugs = Array.isArray(fields.paginas)
        ? [...new Set(fields.paginas.map((s) => (typeof s === "string" ? s.trim() : "")))]
        : [];
      if (slugs.length === 0) return error("diga quais páginas se contradizem (os slugs)");
      const missing = slugs.find((slug) => !draft.pages.has(slug));
      if (missing !== undefined) return error(`a página ${missing} não existe no rascunho`);
      draft.contradictions.push({ slugs, text });
      return { content: "A contradição entrou no relatório.", isError: false };
    },
  };
}
