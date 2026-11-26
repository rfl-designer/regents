import { describe, expect, test } from "bun:test";
import { type ServerEvent, type WikiDto, type WikiPageDto, wikiSyncStepText } from "@shearim/contracts";
import { configFrom } from "../src/config";
import { wikiFromEnv } from "../src/wiki/sources";
import { type FakeReply, lastUserText, type RecordedRequest, toolResults } from "./fakes/messages-api";
import { eventually, type TestApp, testApp } from "./harness";

// A Fonte grande em partes, a revisão e a conferência (#87; spec #74, "Sincronização", passos 2, 3
// e 4; histórias 29 a 33): uma Fonte acima do tamanho de parte da Instalação vai em partes, uma
// chamada por parte; depois das Fontes, a Articuladora revisa a Wiki (o lint) e aponta as
// contradições; no fim, uma conferência em código põe no relatório o que está quebrado.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 30_000;

async function wikiCom(t: TestApp, ...files: File[]): Promise<WikiDto> {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const res = await t.as(juliana).post("/api/wikis", {
    name: "Curso de Redes Sociais",
    description: "O curso transcrito, aula por aula.",
  });
  expect(res.status).toBe(201);
  const wiki: WikiDto = await res.json();
  const form = new FormData();
  for (const file of files) form.append("files", file);
  expect((await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(
    201,
  );
  return wiki;
}

const sincronizar = (t: TestApp, wiki: WikiDto) => t.as(juliana).post(`/api/wikis/${wiki.id}/sync`);

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

const terminada = (t: TestApp, wiki: WikiDto) =>
  eventually("a Sincronização terminar", async () => {
    const sync = (await naAdministracao(t, wiki)).lastSync;
    return sync && !["queued", "running"].includes(sync.state) ? sync : undefined;
  });

/** O estado de cada `wiki_sync.updated` que a aba viu, como a tela o mostra, sem repetir o seguido. */
function estadosVistos(eventos: ServerEvent[]) {
  const textos = eventos.flatMap((e) => {
    if (e.type !== "wiki_sync.updated") return [];
    const { sync } = e;
    if (sync.state === "running" && sync.step) return [wikiSyncStepText(sync.step)];
    return [sync.state === "done" ? "concluída" : sync.state];
  });
  return textos.filter((s, i) => s !== textos[i - 1]);
}

/** A parte da Fonte que a chamada levou: o texto entre o título da Fonte e o pedido do fim. */
function parteDe(r: RecordedRequest) {
  const user = lastUserText(r.body);
  const titulo = user.match(/## Fonte nova: (.+)\n/)?.[1];
  const texto = user.split(/## Fonte nova: .+\n/)[1]?.split("\n\nLeve esta")[0] ?? "";
  return { titulo, texto: texto.replace(/^Esta é a parte .+\n/, "") };
}

/** As chamadas que abrem uma Fonte (ou parte): as primeiras de cada vai-e-vem. */
const aberturas = (t: TestApp) => t.anthropic.syncs.filter((r) => lastUserText(r.body).includes("## Fonte nova"));

const P1 = "# Aula 1\n\nO gancho vem nos 3 primeiros segundos do vídeo.";
const P2 = "Depois do gancho vem a promessa do vídeo.\n# Aula 2\nUma ideia por cartão.";
const P3 = "# Aula 3\n\nPoste no horário do público.";
const CURSO = () => new File([`${P1}\n\n${P2}\n\n${P3}\n`], "curso.md");
const EXTRA = () => new File(["Aula extra. Legendas curtas."], "extra.txt");

describe("uma Fonte grande vai em partes", () => {
  test("o tamanho de parte é da Instalação (SHEARIM_WIKI_PART_MAX_CHARS)", () => {
    expect(wikiFromEnv(configFrom({ SHEARIM_WIKI_PART_MAX_CHARS: "20000" }))).toEqual({ partMaxChars: 20_000 });
    expect(() => wikiFromEnv(configFrom({ SHEARIM_WIKI_PART_MAX_CHARS: "dez" }))).toThrow(
      "SHEARIM_WIKI_PART_MAX_CHARS=dez não é um número inteiro maior que zero.",
    );
  });

  test(
    'uma chamada por parte, cortada na quebra de parágrafo ou de título, e o estado "Fonte 1 de 2, parte 2 de 3"',
    async () => {
      const t = await testApp({ wiki: { partMaxChars: 80 } });
      const wiki = await wikiCom(t, CURSO(), EXTRA());
      const aba = await t.socket(juliana);
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki)).toMatchObject({ state: "done" });

      expect(aberturas(t).map(parteDe)).toEqual([
        { titulo: "curso.md (Fonte 1 de 2, parte 1 de 3)", texto: P1 },
        { titulo: "curso.md (Fonte 1 de 2, parte 2 de 3)", texto: P2 },
        { titulo: "curso.md (Fonte 1 de 2, parte 3 de 3)", texto: P3 },
        { titulo: "extra.txt (Fonte 2 de 2)", texto: "Aula extra. Legendas curtas." },
      ]);
      const estados = await eventually("o anúncio da conclusão", async () => {
        const vistos = estadosVistos(aba.received());
        return vistos.at(-1) === "concluída" ? vistos : undefined;
      });
      expect(estados.slice(1, 5)).toEqual([
        "em curso: Fonte 1 de 2, parte 1 de 3",
        "em curso: Fonte 1 de 2, parte 2 de 3",
        "em curso: Fonte 1 de 2, parte 3 de 3",
        "em curso: Fonte 2 de 2",
      ]);
    },
    LONGO,
  );

  test(
    "sem quebra antes do limite, o corte cai no último espaço; as páginas de cada parte vêm da Fonte",
    async () => {
      const t = await testApp({ wiki: { partMaxChars: 30 } });
      const wiki = await wikiCom(t, new File(["Um parágrafo só, comprido demais para uma parte."], "longo.txt"));
      const pagina = (slug: string): FakeReply => ({
        toolUse: [{ name: "escrever_pagina", input: { slug, titulo: slug, corpo: `Sobre ${slug}.` } }],
      });
      t.anthropic.sync(pagina("primeira"), { text: "Pronto." }, pagina("segunda"), { text: "Pronto." });
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki)).toMatchObject({ state: "done" });

      expect(aberturas(t).map((r) => parteDe(r).texto)).toEqual([
        "Um parágrafo só, comprido",
        "demais para uma parte.",
      ]);
      const paginas = await paginasDe(t, wiki, 1);
      const fontes = (slug: string) => paginas.find((p) => p.slug === slug)?.sources.map((s) => s.fileName);
      expect(fontes("primeira")).toEqual(["longo.txt"]);
      expect(fontes("segunda")).toEqual(["longo.txt"]);
    },
    LONGO,
  );
});

const AULA_1 = () => new File(["O gancho vem nos 3 primeiros segundos."], "aula-01.txt");
const AULA_2 = () => new File(["O gancho pode durar até 5 segundos."], "aula-02.txt");

type ToolUse = NonNullable<FakeReply["toolUse"]>;
const escrever = (slug: string, corpo: string, fontes: string[]): ToolUse => [
  { name: "escrever_pagina", input: { slug, titulo: slug, corpo, fontes } },
];

/** As duas aulas: uma página cada, e o índice com as duas; depois, a revisão. */
function roteiroDasAulas(t: TestApp, ...revisao: FakeReply[]) {
  t.anthropic.sync(
    {
      toolUse: [
        ...escrever("ganchos", "Os 3 primeiros segundos. Veja [[duracao]].", ["aula-01.txt"]),
        ...escrever("index", "- [[ganchos]]: o começo do vídeo.", ["aula-01.txt"]),
      ],
    },
    { text: "Pronto." },
    {
      toolUse: [
        ...escrever("duracao-do-gancho", "Até 5 segundos. Veja [[ganchos]].", ["aula-02.txt"]),
        ...escrever("index", "- [[ganchos]]: o começo.\n- [[duracao-do-gancho]]: quanto dura.", ["aula-02.txt"]),
      ],
    },
    { text: "Pronto." },
    ...revisao,
  );
}

/** A chamada de revisão: a que abre com o pedido de revisar a Wiki. */
const revisoes = (t: TestApp) => t.anthropic.syncs.filter((r) => lastUserText(r.body).includes("## Revisão da Wiki"));

describe("a revisão da Wiki (o lint)", () => {
  test(
    'depois das Fontes, a Articuladora revisa a Wiki com o estado "revisando a Wiki", e as contradições que ela aponta entram no relatório',
    async () => {
      const t = await testApp();
      const wiki = await wikiCom(t, AULA_1(), AULA_2());
      const aba = await t.socket(juliana);
      roteiroDasAulas(
        t,
        {
          toolUse: [
            ...escrever("ganchos", "Os 3 primeiros segundos. Veja [[duracao-do-gancho]].", ["aula-01.txt"]),
            {
              name: "apontar_contradicao",
              input: {
                paginas: ["ganchos", "duracao-do-gancho"],
                descricao: "Uma diz 3 segundos para o gancho; a outra, até 5.",
              },
            },
          ],
        },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki);
      expect(sync).toMatchObject({ state: "done", version: 1 });

      // A revisão é uma chamada só, depois das Fontes: o índice do rascunho, as páginas, os links
      // quebrados de agora e as Ferramentas do rascunho, mais a de apontar uma contradição.
      const [revisao, ...outras] = revisoes(t);
      expect(outras).toEqual([]);
      expect(t.anthropic.syncs.indexOf(revisao!)).toBe(4);
      const pedido = lastUserText(revisao!.body);
      expect(pedido).toContain("- [[duracao-do-gancho]]: quanto dura.");
      expect(pedido).toContain("ganchos");
      expect(pedido).toContain("[[duracao]]");
      expect(((revisao!.body.tools ?? []) as { name: string }[]).map((f) => f.name)).toEqual([
        "ler_pagina",
        "escrever_pagina",
        "remover_pagina",
        "apontar_contradicao",
      ]);

      const contradicoes = [
        {
          pages: [
            { slug: "ganchos", title: "ganchos" },
            { slug: "duracao-do-gancho", title: "duracao-do-gancho" },
          ],
          text: "Uma diz 3 segundos para o gancho; a outra, até 5.",
        },
      ];
      expect(sync.report!.contradictions).toEqual(contradicoes);
      const [versao] = await (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json();
      expect(versao.report.contradictions).toEqual(contradicoes);
      // A revisão corrigiu o link, e a página manteve a Fonte.
      const ganchos = (await paginasDe(t, wiki, 1)).find((p) => p.slug === "ganchos")!;
      expect(ganchos.body).toBe("Os 3 primeiros segundos. Veja [[duracao-do-gancho]].");
      expect(ganchos.sources.map((s) => s.fileName)).toEqual(["aula-01.txt"]);

      const estados = await eventually("o anúncio da conclusão", async () => {
        const vistos = estadosVistos(aba.received());
        return vistos.at(-1) === "concluída" ? vistos : undefined;
      });
      expect(estados).toEqual([
        "queued",
        "em curso: Fonte 1 de 2",
        "em curso: Fonte 2 de 2",
        "revisando a Wiki",
        "publicando",
        "concluída",
      ]);
    },
    LONGO,
  );

  test(
    "uma contradição sem descrição ou com página que não existe volta à Articuladora como erro, e não entra no relatório",
    async () => {
      const t = await testApp();
      const wiki = await wikiCom(t, AULA_1(), AULA_2());
      roteiroDasAulas(
        t,
        {
          toolUse: [
            { name: "apontar_contradicao", input: { paginas: ["ganchos"], descricao: " " } },
            { name: "apontar_contradicao", input: { paginas: ["carrossel"], descricao: "Não existe." } },
          ],
        },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki);

      const resultados = toolResults(t.anthropic.syncs[5]!.body);
      expect(resultados.map((r) => r.is_error)).toEqual([true, true]);
      expect(resultados[0]!.content).toContain("descreva a contradição");
      expect(resultados[1]!.content).toContain("a página carrossel não existe no rascunho");
      expect(sync.report!.contradictions).toEqual([]);
    },
    LONGO,
  );
});

describe("a conferência em código", () => {
  test(
    "põe no relatório os links quebrados, as fora do índice e as sem link de entrada, e não impede a publicação",
    async () => {
      const t = await testApp();
      const wiki = await wikiCom(t, AULA_1(), AULA_2());
      // A revisão não corrige o link quebrado e escreve um resumo fora do índice.
      roteiroDasAulas(
        t,
        {
          toolUse: [
            {
              name: "escrever_pagina",
              input: { slug: "resumo", titulo: "Resumo", corpo: "Ganchos curtos.", fontes: ["aula-01.txt"] },
            },
          ],
        },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki);

      expect(sync).toMatchObject({ state: "done", version: 1 });
      const conferencia = {
        brokenLinks: [{ from: { slug: "ganchos", title: "ganchos" }, slug: "duracao" }],
        withoutSources: [],
        outsideIndex: [{ slug: "resumo", title: "Resumo" }],
        orphans: [
          { slug: "duracao-do-gancho", title: "duracao-do-gancho" },
          { slug: "resumo", title: "Resumo" },
        ],
      };
      expect(sync.report!.check).toEqual(conferencia);
      const [versao] = await (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json();
      expect(versao.report.check).toEqual(conferencia);
      // A versão sai com o que está quebrado: a conferência só avisa.
      const paginas = await paginasDe(t, wiki, 1);
      expect(paginas.map((p) => p.slug)).toEqual(["duracao-do-gancho", "ganchos", "index", "log", "resumo"]);
    },
    LONGO,
  );

  test(
    "uma página nova escrita na revisão sem fontes volta à Articuladora como erro, com o motivo; uma que já existe, reescrita sem fontes, mantém as dela",
    async () => {
      const t = await testApp();
      const wiki = await wikiCom(t, AULA_1(), AULA_2());
      roteiroDasAulas(
        t,
        {
          toolUse: [
            { name: "escrever_pagina", input: { slug: "resumo", titulo: "Resumo", corpo: "Ganchos curtos." } },
            {
              name: "escrever_pagina",
              input: { slug: "ganchos", titulo: "Ganchos", corpo: "Os 3 primeiros segundos." },
            },
          ],
        },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki);

      const resultados = toolResults(t.anthropic.syncs[5]!.body);
      expect(resultados.map((r) => r.is_error ?? false)).toEqual([true, false]);
      expect(resultados[0]!.content).toContain("a página resumo é nova: diga de quais Fontes ela veio");
      expect(sync).toMatchObject({ state: "done", version: 1 });
      expect(sync.report!.check.withoutSources).toEqual([]);
      const paginas = await paginasDe(t, wiki, 1);
      expect(paginas.map((p) => p.slug)).not.toContain("resumo");
      expect(paginas.find((p) => p.slug === "ganchos")!.sources.map((f) => f.fileName)).toEqual(["aula-01.txt"]);
    },
    LONGO,
  );

  test(
    "uma Wiki sem nada quebrado tem a conferência vazia",
    async () => {
      const t = await testApp();
      const wiki = await wikiCom(t, AULA_1(), AULA_2());
      roteiroDasAulas(
        t,
        { toolUse: escrever("ganchos", "Os 3 primeiros segundos. Veja [[duracao-do-gancho]].", ["aula-01.txt"]) },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);

      expect((await terminada(t, wiki)).report!.check).toEqual({
        brokenLinks: [],
        withoutSources: [],
        outsideIndex: [],
        orphans: [],
      });
    },
    LONGO,
  );
});
