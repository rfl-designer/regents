import { WIKI_INDEX_SLUG } from "@shearim/contracts";
import type { Db } from "../db/client";
import { type AutomaticTool, ToolFailure } from "../tools/port";
import { input } from "../tools/workspace-read";
import { recordWikiRead } from "./citations";
import { type Answer, wikiInReachNamed, wikisInReach } from "./reach";
import { pageOfVersion } from "./versions";

/** O nome da Ferramenta, que o catálogo no contexto cita. */
export const READ_WIKI_TITLE = "ler a Wiki";

/**
 * O catálogo das Wikis da resposta (spec #74, #81), a camada logo depois do catálogo de
 * Habilidades: o nome e a descrição de cada Wiki que alcança a resposta e as regras de consulta
 * (ler pela Ferramenta, citar a página, dizer quando a Wiki não tem a resposta e dizer a contradição
 * com a Memória). Vazio sem Wiki que alcance a resposta: a camada não entra.
 */
export async function wikiCatalog(db: Db, answer: Answer): Promise<string> {
  const reached = await wikisInReach(db, answer);
  if (reached.length === 0) return "";
  return [
    `O que o time sabe, organizado em páginas a partir das Fontes que o Admin subiu. Aqui vai só o nome e o que cada Wiki cobre: leia o índice e as páginas com a Ferramenta ${READ_WIKI_TITLE}, quando a pergunta for do assunto de uma delas.`,
    reached.map((w) => `- ${w.name}: ${w.description}`).join("\n"),
    [
      "Quando a resposta usar uma página da Wiki, cite a página com [[wiki:<nome da Wiki>/<slug>]], no ponto em que a usa.",
      "Quando a Wiki não tiver a resposta, diga isso, em vez de completar com o que você supõe.",
      "Quando a Wiki e a Memória se contradisserem, diga que há uma contradição e cite as duas.",
    ].join(" "),
  ].join("\n\n");
}

interface ReadInput {
  wiki: string;
  page: string;
}

const inputOf = (raw: unknown): ReadInput => {
  const args = input(raw);
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { wiki: text(args.wiki), page: text(args.pagina) };
};

/**
 * O que "ler a Wiki" lê: a Wiki do alcance, a versão atual dela e a página (o índice, sem página).
 * Tudo lido na hora. Fora do alcance, não há Wiki: a falha não diz se ela existe.
 */
async function resolve(db: Db, answer: Answer, input: ReadInput) {
  const wiki = input.wiki ? await wikiInReachNamed(db, answer, input.wiki) : undefined;
  if (!wiki) return { wiki };
  const slug = input.page || WIKI_INDEX_SLUG;
  // A página da versão (o `log` com as voltas a ela, #89), ou nada.
  return { wiki, slug, page: await pageOfVersion(db, wiki.versionId, slug) };
}

/**
 * Ler a Wiki (spec #74, #81), no modelo de "buscar na Memória": automática, de leitura, sem Pedido
 * de aprovação, presente quando ao menos uma Wiki com versão publicada alcança a resposta,
 * conferida na hora (o Admin pode desligar a Wiki no meio da resposta). A entrada é a Wiki (nome)
 * e, opcionalmente, a página (slug): sem página, o índice. Lê sempre a versão atual, e o resultado
 * diz a versão lida, que fica guardada para conferir as citações da resposta.
 */
export const READ_WIKI: AutomaticTool = {
  id: "ler_a_wiki",
  title: READ_WIKI_TITLE,
  label: "lendo a Wiki",
  description:
    "Lê uma das Wikis listadas em Wikis, pelo nome: sem página, devolve o índice (uma linha por página, com o que ela cobre); com a página (o slug, como aparece no índice em [[slug]]), devolve a página. Comece pelo índice.",
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: {
      wiki: { type: "string", description: "O nome da Wiki, como em Wikis." },
      pagina: { type: "string", description: "O slug da página. Sem ele, vem o índice." },
    },
    required: ["wiki"],
    additionalProperties: false,
  },
  async presentFor(db, run) {
    return (await wikisInReach(db, run)).length > 0;
  },
  async describe({ db, run }, raw) {
    const { wiki, slug, page } = await resolve(db, run, inputOf(raw));
    // Fora do alcance, o rótulo fixo: o Andamento é visto por todos da conversa.
    if (!wiki) return {};
    if (slug === WIKI_INDEX_SLUG) return { label: `lendo o índice da Wiki ${wiki.name}` };
    return { label: `lendo ${page?.title ?? slug} da Wiki ${wiki.name}` };
  },
  async run({ db, run }, raw) {
    const asked = inputOf(raw);
    if (!asked.wiki) throw new ToolFailure("diga o nome da Wiki");
    const { wiki, slug, page } = await resolve(db, run, asked);
    if (!wiki) throw new ToolFailure("não há uma Wiki com esse nome nesta conversa");
    if (!page) throw new ToolFailure(`essa página não existe na Wiki ${wiki.name}`);
    // A leitura confere as citações da resposta (#85): só a que deu certo, na versão lida.
    await recordWikiRead(db, run, wiki, slug);
    const what = slug === WIKI_INDEX_SLUG ? "o índice" : `a página ${page.title} ([[${slug}]])`;
    return `Wiki ${wiki.name}, versão ${wiki.versionNumber}: ${what}.\n\n${page.body}`;
  },
};
