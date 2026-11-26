import { describe, expect, test } from "bun:test";
import type { WikiDto, WikiPageDto, WikiSourceDto, WikiSyncDto } from "@shearim/contracts";
import { lastUserText, toolResults } from "./fakes/messages-api";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type TestApp, testApp } from "./harness";

// Remover uma Fonte (#88; spec #74, histórias 23 e 24): o Admin remove uma Fonte, ela fica "a
// remover" até a próxima Sincronização, e a Sincronização tira da Wiki o que vinha só dela.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 30_000;

async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.addMember(bruno, { by: juliana });
}

async function criarWiki(t: TestApp): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", {
    name: "Curso de Redes Sociais",
    description: "O curso transcrito, aula por aula.",
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

const AULA_1 = () => new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");
const AULA_2 = () => new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");
const AULA_3 = () => new File(["Aula 3. Legendas curtas."], "aula-03.txt");

const remover = (t: TestApp, wiki: WikiDto, fonte: WikiSourceDto, who = juliana) =>
  t.as(who).delete(`/api/wikis/${wiki.id}/sources/${fonte.id}`);

const fontesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiSourceDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

const resumo = (paginas: WikiPageDto[]) =>
  paginas.filter((p) => p.slug !== "log").map((p) => ({ slug: p.slug, fontes: p.sources.map((s) => s.fileName) }));

const sincronizar = (t: TestApp, wiki: WikiDto) => t.as(juliana).post(`/api/wikis/${wiki.id}/sync`);

const terminada = (t: TestApp, wiki: WikiDto, versao: number) =>
  eventually(`a versão ${versao}`, async () => {
    const sync = (await naAdministracao(t, wiki)).lastSync;
    return sync && !["queued", "running"].includes(sync.state) && (sync.version === versao || sync.state !== "done")
      ? sync
      : undefined;
  });

const pagina = (slug: string, corpo: string, fontes: string[]) => ({
  name: "escrever_pagina",
  input: { slug, titulo: slug, corpo, fontes },
});

/**
 * A versão 1 com as duas aulas: `ganchos` vem só da aula 1, `carrossel` só da aula 2, e `formatos`
 * das duas.
 */
async function versao1(t: TestApp) {
  await workspace(t);
  const wiki = await criarWiki(t);
  const [aula1, aula2] = await subir(t, wiki, AULA_1(), AULA_2());
  t.anthropic.sync(
    {
      toolUse: [
        pagina("ganchos", "Os 3 primeiros segundos.", ["aula-01.md"]),
        pagina("formatos", "Reels com [[ganchos]].", ["aula-01.md"]),
        pagina("index", "- [[ganchos]]: o começo.\n- [[formatos]]: os formatos.", ["aula-01.md"]),
      ],
    },
    { text: "Pronto." },
    {
      toolUse: [
        pagina("carrossel", "Uma ideia por cartão.", ["aula-02.txt"]),
        pagina("formatos", "Reels com [[ganchos]] e [[carrossel]].", ["aula-01.md", "aula-02.txt"]),
        pagina("index", "- [[ganchos]]: o começo.\n- [[formatos]]: os formatos.\n- [[carrossel]]: um por cartão.", [
          "aula-01.md",
          "aula-02.txt",
        ]),
      ],
    },
    { text: "Pronto." },
  );
  expect((await sincronizar(t, wiki)).status).toBe(202);
  expect(await terminada(t, wiki, 1)).toMatchObject({ state: "done", version: 1 });
  return { wiki, aula1: aula1!, aula2: aula2! };
}

describe("o Admin remove uma Fonte já sincronizada", () => {
  test(
    'ela aparece "a remover", e a Wiki atual não muda até a próxima Sincronização',
    async () => {
      const t = await testApp();
      const { wiki, aula1 } = await versao1(t);
      const antes = await paginasDe(t, wiki, 1);
      const daJuliana = await t.socket(juliana);

      const res = await remover(t, wiki, aula1);
      expect(res.status).toBe(200);
      const lista: WikiSourceDto[] = await res.json();
      expect(lista.map((f) => [f.fileName, f.state, f.pending])).toEqual([
        ["aula-01.md", "removed", "removal"],
        ["aula-02.txt", "active", null],
      ]);
      expect(await fontesDe(t, wiki)).toEqual(lista);

      // A pendência chega em tempo real; a versão atual segue a 1, com as mesmas páginas.
      const { wiki: atualizada } = await daJuliana.next("wiki.updated");
      expect(atualizada).toMatchObject({ id: wiki.id, pending: 1, currentVersion: { number: 1 } });
      expect(await naAdministracao(t, wiki)).toMatchObject({ pending: 1, currentVersion: { number: 1 } });
      expect(await paginasDe(t, wiki, 1)).toEqual(antes);
      const lida = await t.as(bruno).get(`/api/wikis/${wiki.id}/pages/ganchos`);
      expect(lida.status).toBe(200);
    },
    LONGO,
  );
});

describe("a Sincronização tira da Wiki o que vinha só da Fonte removida", () => {
  test(
    "a página que citava só ela sai, a que citava ela e outra é reescrita sem ela, e o relatório diz quais",
    async () => {
      const t = await testApp();
      const { wiki, aula1 } = await versao1(t);
      await remover(t, wiki, aula1);
      t.anthropic.sync(
        {
          toolUse: [
            { name: "ler_pagina", input: { slug: "formatos" } },
            pagina("formatos", "Reels e [[carrossel]].", ["aula-02.txt"]),
            pagina("index", "- [[formatos]]: os formatos.\n- [[carrossel]]: um por cartão.", ["aula-02.txt"]),
          ],
        },
        { text: "Pronto." },
      );

      const res = await sincronizar(t, wiki);
      expect(res.status).toBe(202);
      const sync = (await terminada(t, wiki, 2)) as WikiSyncDto;
      expect(sync).toMatchObject({ state: "done", version: 2 });
      expect(sync.report).toMatchObject({
        created: [],
        updated: [{ slug: "formatos" }],
        removed: [{ slug: "ganchos" }],
      });

      // Uma chamada para a Fonte removida: o índice, o nome dela e as páginas que ela tocava (antes
      // da revisão, a última).
      const [chamada, fechamento] = t.anthropic.syncs.slice(-3, -1);
      const pedido = lastUserText(chamada!.body);
      expect(pedido).toContain("- [[ganchos]]: o começo.");
      expect(pedido).toContain("Fonte removida: aula-01.md (Fonte 1 de 1)");
      expect(pedido).toMatch(/vinham só dela: ganchos\b/);
      expect(pedido).toMatch(/também vêm de outras Fontes: formatos\b/);
      expect(pedido).not.toContain("O gancho vem nos 3 primeiros segundos.");
      // A página lida já não diz que vem da Fonte removida.
      const [lida] = toolResults(fechamento!.body);
      expect(lida!.content).toContain("Fontes: aula-02.txt");
      expect(lida!.content).not.toContain("aula-01.md");

      expect(resumo(await paginasDe(t, wiki, 2))).toEqual([
        { slug: "carrossel", fontes: ["aula-02.txt"] },
        { slug: "formatos", fontes: ["aula-02.txt"] },
        { slug: "index", fontes: ["aula-02.txt"] },
      ]);
      const log = (await paginasDe(t, wiki, 2)).find((p) => p.slug === "log")!.body;
      expect(log).toContain("Fontes removidas: aula-01.md");
      expect(log).toContain("Páginas removidas: ganchos");

      // A Fonte removida já não está pendente: sai da lista.
      expect(await naAdministracao(t, wiki)).toMatchObject({ pending: 0, currentVersion: { number: 2 } });
      expect((await fontesDe(t, wiki)).map((f) => f.fileName)).toEqual(["aula-02.txt"]);
    },
    LONGO,
  );

  test(
    "mesmo que a Articuladora não reescreva nada, nenhuma página da versão nova cita a Fonte removida",
    async () => {
      const t = await testApp();
      const { wiki, aula1 } = await versao1(t);
      await remover(t, wiki, aula1);
      t.anthropic.sync({ text: "Pronto." });

      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, 2)).toMatchObject({ state: "done", version: 2 });
      expect(resumo(await paginasDe(t, wiki, 2))).toEqual([
        { slug: "carrossel", fontes: ["aula-02.txt"] },
        { slug: "formatos", fontes: ["aula-02.txt"] },
        { slug: "index", fontes: ["aula-02.txt"] },
      ]);
    },
    LONGO,
  );

  test(
    "a Fonte removida vem antes das novas, e a escrita da remoção não aceita mais o nome dela",
    async () => {
      const t = await testApp();
      const { wiki, aula1 } = await versao1(t);
      await remover(t, wiki, aula1);
      await subir(t, wiki, AULA_3());
      t.anthropic.sync(
        { toolUse: [pagina("formatos", "Reels.", ["aula-01.md"])] },
        { text: "Pronto." },
        { toolUse: [pagina("legendas", "Legendas curtas.", ["aula-03.txt"])] },
        { text: "Pronto." },
      );

      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, 2)).toMatchObject({
        state: "done",
        report: { created: [{ slug: "legendas" }], removed: [{ slug: "ganchos" }] },
      });
      const [remocao, recusa, nova] = t.anthropic.syncs.slice(-5);
      expect(lastUserText(remocao!.body)).toContain("Fonte removida: aula-01.md (Fonte 1 de 2)");
      expect(toolResults(recusa!.body)[0]).toMatchObject({ is_error: true });
      expect(toolResults(recusa!.body)[0]!.content).toContain("a Fonte aula-01.md não está nesta Wiki");
      expect(lastUserText(nova!.body)).toContain("Fonte nova: aula-03.txt (Fonte 2 de 2)");
      expect(resumo(await paginasDe(t, wiki, 2)).map((p) => p.slug)).toEqual([
        "carrossel",
        "formatos",
        "index",
        "legendas",
      ]);
    },
    LONGO,
  );
});

describe("a Fonte que nenhuma versão reflete sai direto", () => {
  test(
    "removida antes de qualquer Sincronização, ela sai sem pendência, e o nome fica livre",
    async () => {
      const t = await testApp();
      await workspace(t);
      const wiki = await criarWiki(t);
      const [aula1, aula2] = await subir(t, wiki, AULA_1(), AULA_2());
      expect((await naAdministracao(t, wiki)).pending).toBe(2);

      const res = await remover(t, wiki, aula1!);
      expect(res.status).toBe(200);
      const lista: WikiSourceDto[] = await res.json();
      expect(lista.map((f) => [f.fileName, f.pending])).toEqual([["aula-02.txt", "new"]]);
      expect(await naAdministracao(t, wiki)).toMatchObject({ pending: 1, currentVersion: null });

      await remover(t, wiki, aula2!);
      expect(await fontesDe(t, wiki)).toEqual([]);
      const nada = await sincronizar(t, wiki);
      expect(nada.status).toBe(409);
      expect(await nada.json()).toMatchObject({ error: "nothing_to_sync" });

      const [de_novo] = await subir(t, wiki, AULA_1());
      expect(de_novo).toMatchObject({ fileName: "aula-01.md", state: "active", pending: "new" });
    },
    LONGO,
  );

  test(
    "subida depois da versão 1 e removida antes da 2, ela também sai direto",
    async () => {
      const t = await testApp();
      const { wiki } = await versao1(t);
      const [aula3] = await subir(t, wiki, AULA_3());
      expect((await naAdministracao(t, wiki)).pending).toBe(1);

      await remover(t, wiki, aula3!);
      expect((await fontesDe(t, wiki)).map((f) => f.fileName)).toEqual(["aula-01.md", "aula-02.txt"]);
      expect((await naAdministracao(t, wiki)).pending).toBe(0);
      expect((await sincronizar(t, wiki)).status).toBe(409);
    },
    LONGO,
  );
});

describe("a Fonte removida continua guardada enquanto uma versão guardada a reflete", () => {
  test(
    "depois da versão 2, as páginas da versão 1 ainda dizem que vieram dela",
    async () => {
      const t = await testApp();
      const { wiki, aula1 } = await versao1(t);
      await remover(t, wiki, aula1);
      t.anthropic.sync({ text: "Pronto." });
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, 2)).toMatchObject({ state: "done" });

      expect(resumo(await paginasDe(t, wiki, 1))).toEqual([
        { slug: "carrossel", fontes: ["aula-02.txt"] },
        { slug: "formatos", fontes: ["aula-01.md", "aula-02.txt"] },
        { slug: "ganchos", fontes: ["aula-01.md"] },
        { slug: "index", fontes: ["aula-01.md", "aula-02.txt"] },
      ]);
      // Ela não volta a ser removida: já não está ativa.
      expect((await remover(t, wiki, aula1)).status).toBe(404);
    },
    LONGO,
  );
});

describe("quem remove e quando", () => {
  test(
    "só o Admin remove, e não com uma Sincronização em curso",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      await workspace(t);
      const wiki = await criarWiki(t);
      const [aula1, aula2] = await subir(t, wiki, AULA_1(), AULA_2());

      expect((await remover(t, wiki, aula1!, bruno)).status).toBe(403);
      expect((await t.as(juliana).delete(`/api/wikis/${wiki.id}/sources/${crypto.randomUUID()}`)).status).toBe(404);

      await sincronizar(t, wiki);
      const chamada = await cerebro.nextSync();
      const res = await remover(t, wiki, aula2!);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "sync_running",
        message: "Há uma Sincronização em curso nesta Wiki. Remova a Fonte quando ela terminar.",
      });

      await chamada.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      const segunda = await cerebro.nextSync();
      await segunda.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      const revisao = await cerebro.nextSync();
      await revisao.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      expect(await terminada(t, wiki, 1)).toMatchObject({ state: "done" });
      expect((await remover(t, wiki, aula2!)).status).toBe(200);
    },
    LONGO,
  );
});
