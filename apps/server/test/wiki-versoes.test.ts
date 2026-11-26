import { describe, expect, test } from "bun:test";
import type {
  ChannelDto,
  MessageDto,
  WikiDto,
  WikiPageDto,
  WikiPageViewDto,
  WikiSourceDto,
  WikiVersionDto,
} from "@regents/contracts";
import { toolResults } from "./fakes/messages-api";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type TestApp, testApp } from "./harness";

// As versões da Wiki e voltar à anterior (#89; spec #74, histórias 43 a 45): cada Sincronização
// concluída gera uma versão, e o Admin volta a uma anterior sem destilar de novo. Voltar só troca a
// versão atual: as leituras, a navegação e as pendências seguem a versão que passa a valer.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 60_000;

async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.addMember(bruno, { by: juliana });
}

async function criarWiki(t: TestApp): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", {
    name: "Curso",
    description: "O curso de redes sociais, aula por aula.",
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function subir(t: TestApp, wiki: WikiDto, ...files: File[]): Promise<WikiSourceDto[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return res.json();
}

const AULA_1 = () => new File(["Aula 1. O gancho vem nos 3 primeiros segundos."], "aula-01.txt");
const AULA_2 = () => new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");
const AULA_3 = () => new File(["Aula 3. Legendas curtas."], "aula-03.txt");

const pagina = (slug: string, corpo: string, fontes: string[]) => ({
  name: "escrever_pagina",
  input: { slug, titulo: slug, corpo, fontes },
});

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const versoesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiVersionDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json();

const fontesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiSourceDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

const sincronizar = (t: TestApp, wiki: WikiDto) => t.as(juliana).post(`/api/wikis/${wiki.id}/sync`);

const voltar = (t: TestApp, wiki: WikiDto, versao: number, who = juliana) =>
  t.as(who).post(`/api/wikis/${wiki.id}/versions/${versao}/restore`);

const terminada = (t: TestApp, wiki: WikiDto, versao: number) =>
  eventually(`a versão ${versao}`, async () => {
    const sync = (await naAdministracao(t, wiki)).lastSync;
    return sync && !["queued", "running"].includes(sync.state) && (sync.version === versao || sync.state !== "done")
      ? sync
      : undefined;
  });

/**
 * A versão 1 (só a aula 1: a página `ganchos`) e a versão 2 (a aula 2 entra: `ganchos` muda e
 * `carrossel` nasce).
 */
async function duasVersoes(t: TestApp) {
  await workspace(t);
  const wiki = await criarWiki(t);
  const [aula1] = await subir(t, wiki, AULA_1());
  t.anthropic.sync(
    {
      toolUse: [
        pagina("ganchos", "Os 3 primeiros segundos.", ["aula-01.txt"]),
        pagina("index", "- [[ganchos]]: o começo.", ["aula-01.txt"]),
      ],
    },
    { text: "Pronto." },
  );
  expect((await sincronizar(t, wiki)).status).toBe(202);
  expect(await terminada(t, wiki, 1)).toMatchObject({ state: "done", version: 1 });

  const [aula2] = await subir(t, wiki, AULA_2());
  t.anthropic.sync(
    {
      toolUse: [
        pagina("ganchos", "Os 3 primeiros segundos, e o carrossel também.", ["aula-01.txt", "aula-02.txt"]),
        pagina("carrossel", "Uma ideia por cartão.", ["aula-02.txt"]),
        pagina("index", "- [[ganchos]]: o começo.\n- [[carrossel]]: um por cartão.", ["aula-01.txt", "aula-02.txt"]),
      ],
    },
    { text: "Pronto." },
  );
  expect((await sincronizar(t, wiki)).status).toBe(202);
  expect(await terminada(t, wiki, 2)).toMatchObject({ state: "done", version: 2 });
  return { wiki, aula1: aula1!, aula2: aula2! };
}

describe("a lista de versões", () => {
  test(
    "mostra cada Sincronização concluída, da mais nova para a mais velha, com o número, a data, quem iniciou e o relatório",
    async () => {
      const t = await testApp();
      const { wiki } = await duasVersoes(t);

      const versoes = await versoesDe(t, wiki);
      expect(versoes).toMatchObject([
        {
          number: 2,
          startedBy: { name: "Juliana" },
          report: { created: [{ slug: "carrossel" }], updated: [{ slug: "ganchos" }], removed: [] },
          current: true,
        },
        { number: 1, startedBy: { name: "Juliana" }, report: { created: [{ slug: "ganchos" }] }, current: false },
      ]);
      expect(versoes.every((v) => !Number.isNaN(Date.parse(v.publishedAt)))).toBe(true);
      // A lista é da administração.
      expect((await t.as(bruno).get(`/api/wikis/${wiki.id}/versions`)).status).toBe(403);
    },
    LONGO,
  );
});

describe("voltar a uma versão anterior", () => {
  test(
    "na versão 2, o Admin volta à 1: a lista, a navegação e o aviso de versão antiga passam a seguir a 1",
    async () => {
      const t = await testApp();
      const { wiki } = await duasVersoes(t);
      const doBruno = await t.socket(bruno);

      const res = await voltar(t, wiki, 1);
      expect(res.status).toBe(200);
      const versoes: WikiVersionDto[] = await res.json();
      expect(versoes.map((v) => [v.number, v.current])).toEqual([
        [2, false],
        [1, true],
      ]);
      expect(await versoesDe(t, wiki)).toEqual(versoes);

      // Quem vê a Wiki sabe na hora.
      const { wiki: atualizada } = await doBruno.next("wiki.updated");
      expect(atualizada).toMatchObject({ id: wiki.id, currentVersion: { number: 1 } });
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: { number: 1 } });

      // A navegação mostra a 1: a página dela, e a que só a 2 tinha não existe mais.
      const ganchos = await t.as(bruno).get(`/api/wikis/${wiki.id}/pages/ganchos`);
      expect(ganchos.status).toBe(200);
      const lida: WikiPageViewDto = await ganchos.json();
      expect(lida).toMatchObject({ version: 1, page: { body: "Os 3 primeiros segundos." } });
      expect((await t.as(bruno).get(`/api/wikis/${wiki.id}/pages/carrossel`)).status).toBe(404);

      // A versão 2 continua guardada: a citação dela abre, com o aviso de que não é a atual.
      const antiga = await t.as(bruno).get(`/api/wikis/${wiki.id}/versions/2/pages/carrossel`);
      expect(antiga.status).toBe(200);
      expect(await antiga.json()).toMatchObject({
        version: 2,
        inCurrentVersion: false,
        wiki: { currentVersion: { number: 1 } },
      });
      await doBruno.close();
    },
    LONGO,
  );

  test(
    "as leituras dos Agentes passam a ler a versão 1",
    async () => {
      const t = await testApp();
      const { wiki } = await duasVersoes(t);
      const criado = await t.as(juliana).post("/api/channels", { name: "marketing", kind: "public" });
      const marketing: ChannelDto = await criado.json();
      await t.as(bruno).post(`/api/channels/${marketing.id}/join`);
      expect((await t.as(juliana).put(`/api/wikis/${wiki.id}/channels/${marketing.id}`)).status).toBe(200);
      expect((await voltar(t, wiki, 1)).status).toBe(200);

      const respostas = () => t.anthropic.requests.filter((r) => !r.body.output_config);
      const antes = respostas().length;
      t.anthropic.reply(
        { toolUse: [{ id: "toolu_1", name: "ler_a_wiki", input: { wiki: "Curso", pagina: "ganchos" } }] },
        { text: "Pronto." },
      );
      const enviada = await t.as(bruno).post(`/api/conversations/${marketing.id}/messages`, {
        body: "@sophya como abro um vídeo?",
      });
      const origem: MessageDto = await enviada.json();
      await eventually("a resposta sair", async () => {
        const lista: MessageDto[] = await (await t.as(bruno).get(`/api/conversations/${marketing.id}/messages`)).json();
        return lista.find((m) => m.originMessageId === origem.id);
      });

      const [lido] = toolResults(respostas()[antes + 1]!.body);
      expect(lido!.content).toContain("versão 1");
      expect(lido!.content).toContain("Os 3 primeiros segundos.");
      expect(lido!.content).not.toContain("carrossel também");
    },
    LONGO,
  );

  test(
    'as Fontes que só a versão 2 refletia voltam a "nova", e a removida que a 1 reflete volta a "a remover"',
    async () => {
      const t = await testApp();
      await workspace(t);
      const wiki = await criarWiki(t);
      const [aula1, aula2] = await subir(t, wiki, AULA_1(), AULA_2());
      t.anthropic.sync(
        { toolUse: [pagina("ganchos", "Os 3 primeiros segundos.", ["aula-01.txt"])] },
        { text: "Pronto." },
        { toolUse: [pagina("carrossel", "Uma ideia por cartão.", ["aula-02.txt"])] },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, 1)).toMatchObject({ state: "done" });
      // A versão 2: a aula 2 sai e a aula 3 entra.
      expect((await t.as(juliana).delete(`/api/wikis/${wiki.id}/sources/${aula2!.id}`)).status).toBe(200);
      await subir(t, wiki, AULA_3());
      t.anthropic.sync({ toolUse: [pagina("legendas", "Curtas.", ["aula-03.txt"])] }, { text: "Pronto." });
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, 2)).toMatchObject({ state: "done" });
      expect((await fontesDe(t, wiki)).map((f) => [f.fileName, f.pending])).toEqual([
        ["aula-01.txt", null],
        ["aula-03.txt", null],
      ]);

      expect((await voltar(t, wiki, 1)).status).toBe(200);

      expect((await fontesDe(t, wiki)).map((f) => [f.fileName, f.state, f.pending])).toEqual([
        ["aula-01.txt", "active", null],
        ["aula-02.txt", "removed", "removal"],
        ["aula-03.txt", "active", "new"],
      ]);
      expect(await naAdministracao(t, wiki)).toMatchObject({ pending: 2, currentVersion: { number: 1 } });
      void aula1;
    },
    LONGO,
  );

  test(
    "a troca fica registrada no log da versão que passa a valer, depois do que ele já dizia",
    async () => {
      const t = await testApp();
      const { wiki } = await duasVersoes(t);
      const logAntes = (await paginasDe(t, wiki, 1)).find((p) => p.slug === "log")!.body;

      expect((await voltar(t, wiki, 1)).status).toBe(200);

      const lido: WikiPageViewDto = await (await t.as(bruno).get(`/api/wikis/${wiki.id}/pages/log`)).json();
      expect(lido.version).toBe(1);
      expect(lido.page.body.startsWith(logAntes)).toBe(true);
      expect(lido.page.body).toMatch(/## Volta à versão 1 · \d{4}-\d\d-\d\d \d\d:\d\d UTC · Juliana/);
      expect(lido.page.body).toContain("- A versão 2 deixou de valer: a Wiki voltou à versão 1.");
      expect((await paginasDe(t, wiki, 1)).find((p) => p.slug === "log")!.body).toBe(lido.page.body);
      // O log da versão 2 não muda: ela não passou a valer.
      expect((await paginasDe(t, wiki, 2)).find((p) => p.slug === "log")!.body).not.toContain("Volta à versão");
    },
    LONGO,
  );

  test(
    "a Sincronização seguinte parte da versão atual (a 1) e gera a versão 3, com o log que inclui a volta",
    async () => {
      const t = await testApp();
      const { wiki } = await duasVersoes(t);
      expect((await voltar(t, wiki, 1)).status).toBe(200);

      t.anthropic.sync(
        {
          toolUse: [
            { name: "ler_pagina", input: { slug: "ganchos" } },
            pagina("carrossel", "Um cartão, uma ideia.", ["aula-02.txt"]),
          ],
        },
        { text: "Pronto." },
      );
      expect((await sincronizar(t, wiki)).status).toBe(202);
      const sync = await terminada(t, wiki, 3);
      expect(sync).toMatchObject({ state: "done", version: 3 });
      // O relatório compara com a 1: carrossel nasce de novo, ganchos fica como na 1.
      expect(sync!.report).toMatchObject({ created: [{ slug: "carrossel" }], updated: [], removed: [] });
      // A Fonte (antes da revisão, a última).
      const [, fechamento] = t.anthropic.syncs.slice(-3, -1);
      expect(toolResults(fechamento!.body)[0]!.content).toContain("Os 3 primeiros segundos.");

      const paginas = await paginasDe(t, wiki, 3);
      expect(paginas.find((p) => p.slug === "ganchos")!.body).toBe("Os 3 primeiros segundos.");
      const log = paginas.find((p) => p.slug === "log")!.body;
      const ordem = ["## Versão 1", "## Volta à versão 1", "## Versão 3"].map((s) => log.indexOf(s));
      expect(ordem.every((p) => p >= 0)).toBe(true);
      expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
      expect((await versoesDe(t, wiki)).map((v) => [v.number, v.current])).toEqual([
        [3, true],
        [2, false],
        [1, false],
      ]);
    },
    LONGO,
  );
});

describe("quem volta e quando", () => {
  test(
    "só o Admin volta, nunca durante uma Sincronização em curso, e só a uma versão que existe e não é a atual",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      await workspace(t);
      const wiki = await criarWiki(t);
      const fim = { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
      const umaVersao = async (file: File, versao: number) => {
        await subir(t, wiki, file);
        await sincronizar(t, wiki);
        await (await cerebro.nextSync()).emit(fim);
        await (await cerebro.nextSync()).emit(fim); // a revisão
        expect(await terminada(t, wiki, versao)).toMatchObject({ state: "done" });
      };
      await umaVersao(AULA_1(), 1);
      await umaVersao(AULA_2(), 2);

      expect((await voltar(t, wiki, 1, bruno)).status).toBe(403);
      const naoExiste = await voltar(t, wiki, 7);
      expect(naoExiste.status).toBe(404);
      const atual = await voltar(t, wiki, 2);
      expect(atual.status).toBe(409);
      expect(await atual.json()).toMatchObject({ error: "already_current", message: "A versão 2 já é a atual." });

      await subir(t, wiki, AULA_3());
      await sincronizar(t, wiki);
      const chamada = await cerebro.nextSync();
      const emCurso = await voltar(t, wiki, 1);
      expect(emCurso.status).toBe(409);
      expect(await emCurso.json()).toMatchObject({
        error: "sync_running",
        message: "Há uma Sincronização em curso nesta Wiki. Volte à versão quando ela terminar.",
      });
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: { number: 2 } });

      await chamada.emit(fim);
      await (await cerebro.nextSync()).emit(fim); // a revisão
      expect(await terminada(t, wiki, 3)).toMatchObject({ state: "done" });
      expect((await voltar(t, wiki, 1)).status).toBe(200);
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: { number: 1 } });
    },
    LONGO,
  );
});
