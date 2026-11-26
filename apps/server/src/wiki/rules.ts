import { WIKI_INDEX_SLUG, WIKI_LOG_SLUG } from "@regents/contracts";

/**
 * As regras da Wiki (o schema do padrão LLM Wiki, ADR 0014 e 0015): texto fixo do Shearim, como
 * as instruções da Articuladora. Toda Wiki tem a mesma forma, e a consulta dos Agentes é previsível.
 * Mudam só com uma versão nova do Shearim.
 */

/**
 * A marca que abre o `system` de toda chamada da Sincronização. Os dublês do modelo a reconhecem
 * (como reconhecem a extração da Memória pelo schema), para o teste roteirizar as escritas.
 */
export const SYNC_MARKER = "[Regents] Sincronização da Wiki";

/** A Habilidade do Shearim que a tela da Articuladora mostra, só para leitura. */
export const SYNC_SKILL = {
  id: "regents:sincronizar-a-wiki",
  name: "Sincronizar a Wiki",
  description:
    'Quando o Admin aperta "Sincronizar" numa Wiki: leva as Fontes pendentes para as páginas, com links entre elas e o índice. É do Regents e não se edita.',
} as const;

/** As Ferramentas internas da Sincronização: só dela, nunca de uma resposta em conversa. */
export const READ_PAGE = "ler_pagina";
export const WRITE_PAGE = "escrever_pagina";
export const REMOVE_PAGE = "remover_pagina";
/** Só da revisão (#87): aponta uma contradição entre páginas, que entra no relatório. */
export const POINT_CONTRADICTION = "apontar_contradicao";

/** O `system` de cada chamada da Sincronização: a marca, a Wiki e as regras. */
export function syncSystem(wiki: { name: string; description: string }) {
  return [
    `${SYNC_MARKER} "${wiki.name}"`,
    "",
    `Você é a Articuladora do Regents e está sincronizando a Wiki "${wiki.name}": ${wiki.description}`,
    "A Wiki segue o padrão LLM Wiki: as Fontes são o texto bruto e não mudam; as páginas são suas, em markdown, organizadas por tema; o índice diz o que cada página cobre. Os Agentes do Workspace consultam a Wiki pelo índice e abrem as páginas de que precisam.",
    "Você trabalha num rascunho: nada do que você escreve aparece antes de a Sincronização terminar. Escreva só pelas Ferramentas.",
    "",
    "## Regras da Wiki",
    "- Uma página por tema, e não uma página por Fonte. Antes de criar uma página, veja no índice se o tema já tem uma: se tem, leia-a (ler_pagina) e reescreva-a com o que a Fonte traz.",
    "- O slug é o endereço da página: minúsculas, sem acento, palavras separadas por hífen (ex.: ganchos-para-reels). Não mude o slug de uma página que já existe.",
    "- Ligue as páginas com [[slug]] ou [[slug|texto]]. Só ligue a páginas que existem ou que você vai criar.",
    "- Diga em cada página de quais Fontes ela veio (o campo fontes, com o nome do arquivo). Uma página reescrita mantém as Fontes que já tinha.",
    "- Escreva o que a Fonte ensina, destilado: sem repetir a transcrição e sem inventar o que ela não diz.",
    `- Mantenha a página ${WIKI_INDEX_SLUG}: uma linha por página, no formato "- [[slug]]: o que ela cobre". Toda página nova entra no índice.`,
    `- A página ${WIKI_LOG_SLUG} é do Regents: não a escreva.`,
    "- Escreva em português do Brasil.",
    '- Quando terminar a Fonte, responda só "Pronto.".',
  ].join("\n");
}

/**
 * A mensagem de cada chamada: o índice do rascunho e a Fonte, ou uma parte dela (#87: uma Fonte
 * grande vai em partes, uma chamada por parte, e cada parte vê o índice que a anterior deixou).
 */
export function syncPrompt(input: {
  index: string | null;
  source: { fileName: string };
  text: string;
  current: number;
  total: number;
  part?: { current: number; total: number };
}) {
  const part = input.part ? `, parte ${input.part.current} de ${input.part.total}` : "";
  return [
    "## Índice do rascunho",
    input.index?.trim() || "(a Wiki ainda não tem páginas)",
    "",
    `## Fonte nova: ${input.source.fileName} (Fonte ${input.current} de ${input.total}${part})`,
    ...(input.part
      ? [
          `Esta é a parte ${input.part.current} de ${input.part.total} da Fonte: as partes anteriores já estão no rascunho, e as seguintes vêm depois.`,
        ]
      : []),
    input.text,
    "",
    "Leve esta Fonte para as páginas da Wiki, seguindo as regras.",
  ].join("\n");
}

/**
 * A mensagem da chamada de uma Fonte removida (#88): o índice do rascunho, o nome da Fonte e as
 * páginas que ela tocava. O Shearim já tirou do rascunho as páginas que vinham só dela e tirou a
 * Fonte das outras; a Articuladora reescreve estas sem o que vinha dela e arruma o índice e os links.
 */
export function removalPrompt(input: {
  index: string | null;
  source: { fileName: string };
  removed: readonly string[];
  rewrite: readonly string[];
  current: number;
  total: number;
}) {
  const list = (slugs: readonly string[]) => (slugs.length ? slugs.join(", ") : "nenhuma");
  return [
    "## Índice do rascunho",
    input.index?.trim() || "(a Wiki ainda não tem páginas)",
    "",
    `## Fonte removida: ${input.source.fileName} (Fonte ${input.current} de ${input.total})`,
    `O Admin removeu a Fonte ${input.source.fileName}. O que vinha só dela sai da Wiki.`,
    `- O Regents já tirou do rascunho as páginas que vinham só dela: ${list(input.removed)}.`,
    `- Estas páginas também vêm de outras Fontes: ${list(input.rewrite)}. Leia cada uma (ler_pagina) e reescreva-a (escrever_pagina) sem o que só a Fonte removida sustentava.`,
    `- Tire do índice e dos links ([[slug]]) as páginas que saíram. Não cite mais ${input.source.fileName} em nenhuma página.`,
    "",
    "Tire esta Fonte da Wiki, seguindo as regras.",
  ].join("\n");
}

/**
 * A mensagem da chamada de revisão (o lint, #87), depois de todas as Fontes: o índice do rascunho,
 * as páginas e os links quebrados de agora. A Articuladora abre as páginas de que precisa, corrige
 * links e o índice e aponta as contradições (`apontar_contradicao`). O que sobrar quebrado, a
 * conferência em código põe no relatório.
 */
export function reviewPrompt(input: {
  index: string | null;
  pages: readonly { slug: string; title: string }[];
  brokenLinks: readonly { from: { slug: string }; slug: string }[];
}) {
  const pages = input.pages.map((p) => `- ${p.slug}: ${p.title}`);
  const broken = input.brokenLinks.map((b) => `- em ${b.from.slug}: [[${b.slug}]]`);
  return [
    "## Índice do rascunho",
    input.index?.trim() || "(a Wiki ainda não tem índice)",
    "",
    "## Páginas do rascunho",
    ...(pages.length ? pages : ["(nenhuma)"]),
    "",
    "## Links quebrados",
    ...(broken.length ? broken : ["(nenhum)"]),
    "",
    "## Revisão da Wiki",
    "Todas as Fontes já estão no rascunho. Revise a Wiki inteira, seguindo as regras:",
    "- Abra as páginas de que precisar (ler_pagina).",
    "- Corrija os links quebrados e ligue as páginas que tratam do mesmo assunto (escrever_pagina). Uma página reescrita mantém as Fontes que já tinha.",
    `- Toda página entra no índice (${WIKI_INDEX_SLUG}).`,
    `- Quando duas páginas (ou uma página consigo mesma) disserem coisas que não podem valer juntas, aponte a contradição (${POINT_CONTRADICTION}), com as páginas e o que se contradiz. Não escolha um lado: o Admin corrige a Fonte.`,
    "",
    'Quando terminar a revisão, responda só "Pronto.".',
  ].join("\n");
}
