import { WIKI_INDEX_SLUG, WIKI_LOG_SLUG, type WikiPageRefDto, type WikiSyncReportDto } from "@shearim/contracts";
import type { ExecutionTools, ToolResult, ToolSpec } from "../tools/port";
import { READ_PAGE, REMOVE_PAGE, WRITE_PAGE } from "./rules";

/** Uma página no rascunho: o título, o corpo e os ids das Fontes de onde ela veio. */
export interface DraftPage {
  title: string;
  body: string;
  sources: string[];
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

  constructor(
    readonly base: ReadonlyMap<string, DraftPage>,
    readonly sources: readonly DraftSource[],
  ) {
    this.pages = new Map([...base].map(([slug, p]) => [slug, { ...p, sources: [...p.sources] }]));
  }

  /** Uma cópia do estado de agora, para voltar a ele (a nova tentativa de uma chamada, #86). */
  snapshot(): Map<string, DraftPage> {
    return new Map([...this.pages].map(([slug, p]) => [slug, { ...p, sources: [...p.sources] }]));
  }

  restore(snapshot: ReadonlyMap<string, DraftPage>) {
    this.pages.clear();
    for (const [slug, p] of snapshot) this.pages.set(slug, { ...p, sources: [...p.sources] });
  }

  fileNameOf(sourceId: string) {
    return this.sources.find((s) => s.id === sourceId)?.fileName ?? "uma Fonte removida";
  }

  /** O que mudou da versão de base para o rascunho, sem as páginas especiais. */
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
    return { created: created.sort(bySlug), updated: updated.sort(bySlug), removed: removed.sort(bySlug) };
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
 * nenhuma execução e nunca são oferecidas a uma resposta em conversa. `current` é a Fonte da
 * chamada: uma página escrita sem `fontes` vem dela (mais as que já tinha).
 */
export function draftTools(draft: Draft, current: DraftSource): ExecutionTools {
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
    if (input.fontes === undefined) {
      sources = [...new Set([...(draft.pages.get(slug)?.sources ?? []), current.id])];
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
