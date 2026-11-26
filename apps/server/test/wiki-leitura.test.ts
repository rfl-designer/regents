import { describe, expect, test } from "bun:test";
import type { WikiDto, WikiPageViewDto } from "@shearim/contracts";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type TestApp, testApp } from "./harness";

// Os Membros navegam pela Wiki (#82; spec #74): a seção "Wikis" da barra lateral, a leitura das
// páginas a partir do índice, os links `[[slug]]`, as Fontes de cada página e a Sincronização em
// tempo real. Ninguém edita: a Wiki só muda pela Sincronização.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" }; // Membro
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 30_000;

async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.addMember(bruno, { by: juliana });
}

async function criarWiki(t: TestApp, name: string): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", { name, description: `A Wiki ${name}.` });
  expect(res.status).toBe(201);
  return res.json();
}

async function subir(t: TestApp, wiki: WikiDto, ...files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  expect(res.status).toBe(201);
}

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

/** Espera a Sincronização da Wiki terminar bem. */
const concluida = (t: TestApp, wiki: WikiDto) =>
  eventually("a Sincronização terminar", async () => {
    const sync = (await naAdministracao(t, wiki)).lastSync;
    return sync?.state === "done" ? sync : undefined;
  });

type Pagina = { slug: string; titulo: string; corpo: string; fontes: string[] };

/** Sincroniza a Wiki com uma Fonte; a Articuladora escreve estas páginas. */
async function publicar(t: TestApp, wiki: WikiDto, fonte: File, paginas: Pagina[]) {
  await subir(t, wiki, fonte);
  t.anthropic.sync({ toolUse: paginas.map((input) => ({ name: "escrever_pagina", input })) }, { text: "Pronto." });
  expect((await t.as(juliana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await concluida(t, wiki);
}

const AULA_1 = () => new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");

const CURSO: Pagina[] = [
  { slug: "ganchos", titulo: "Ganchos", corpo: "O gancho vem nos 3 primeiros segundos.", fontes: ["aula-01.md"] },
  {
    slug: "index",
    titulo: "Índice",
    corpo: "- [[ganchos]]: o começo do vídeo.\n- [[legendas|Legendas]]: ainda sem página.",
    fontes: ["aula-01.md"],
  },
];

describe('a seção "Wikis" da barra lateral', () => {
  test(
    "o Membro vê as Wikis públicas que têm versão publicada; a que nunca foi sincronizada não aparece",
    async () => {
      const t = await testApp();
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      await criarWiki(t, "Reembolso");
      await publicar(t, curso, AULA_1(), CURSO);

      const res = await t.as(bruno).get("/api/wikis");
      expect(res.status).toBe(200);
      const lista: WikiDto[] = await res.json();
      expect(lista.map((w) => w.name)).toEqual(["Curso de Redes Sociais"]);
      expect(lista[0]).toMatchObject({ id: curso.id, currentVersion: { number: 1 } });
    },
    LONGO,
  );
});

const lerPagina = (t: TestApp, wiki: WikiDto, slug: string) => t.as(bruno).get(`/api/wikis/${wiki.id}/pages/${slug}`);

describe("o Membro lê a Wiki", () => {
  test(
    "abrir a Wiki mostra o índice; os links levam às páginas, e o link para uma página que não existe vem quebrado",
    async () => {
      const t = await testApp();
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      await publicar(t, curso, AULA_1(), CURSO);

      const res = await lerPagina(t, curso, "index");
      expect(res.status).toBe(200);
      const indice: WikiPageViewDto = await res.json();
      expect(indice).toMatchObject({
        wiki: { id: curso.id, name: "Curso de Redes Sociais" },
        version: 1,
        page: { slug: "index", title: "Índice" },
      });
      expect(indice.page.body).toContain("[[ganchos]]");
      expect(indice.links).toEqual([
        { slug: "ganchos", title: "Ganchos" },
        { slug: "legendas", title: null },
      ]);

      const ganchos: WikiPageViewDto = await (await lerPagina(t, curso, "ganchos")).json();
      expect(ganchos.page).toMatchObject({ title: "Ganchos", body: "O gancho vem nos 3 primeiros segundos." });
      expect(ganchos.links).toEqual([]);
    },
    LONGO,
  );

  test(
    "cada página mostra as Fontes de onde veio",
    async () => {
      const t = await testApp();
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      await publicar(t, curso, AULA_1(), CURSO);
      await publicar(t, curso, new File(["Aula 2. Ganchos visuais também contam."], "aula-02.txt"), [
        {
          slug: "ganchos",
          titulo: "Ganchos",
          corpo: "O gancho vem nos 3 primeiros segundos, e pode ser visual.",
          fontes: ["aula-01.md", "aula-02.txt"],
        },
      ]);

      const ganchos: WikiPageViewDto = await (await lerPagina(t, curso, "ganchos")).json();
      expect(ganchos.version).toBe(2);
      expect(ganchos.page.sources.map((s) => s.fileName)).toEqual(["aula-01.md", "aula-02.txt"]);
    },
    LONGO,
  );

  test(
    "uma página que não existe devolve 404 com a mensagem; uma Wiki sem versão também",
    async () => {
      const t = await testApp();
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      const reembolso = await criarWiki(t, "Reembolso");
      await publicar(t, curso, AULA_1(), CURSO);

      const sem = await lerPagina(t, curso, "legendas");
      expect(sem.status).toBe(404);
      expect(await sem.json()).toEqual({
        error: "not_found",
        message: "Essa página não existe na Wiki Curso de Redes Sociais.",
      });

      const nunca = await lerPagina(t, reembolso, "index");
      expect(nunca.status).toBe(404);
      expect((await nunca.json()).message).toBe("Essa Wiki não existe.");
      const outra = await t.as(bruno).get(`/api/wikis/${crypto.randomUUID()}/pages/index`);
      expect(outra.status).toBe(404);
      expect((await outra.json()).message).toBe("Essa Wiki não existe.");
    },
    LONGO,
  );

  test(
    "não há rota de edição de página, nem para o Admin",
    async () => {
      const t = await testApp();
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      await publicar(t, curso, AULA_1(), CURSO);
      const nova = { slug: "ganchos", title: "Ganchos", body: "Editado à mão." };

      for (const caminho of [
        `/api/wikis/${curso.id}/pages/ganchos`,
        `/api/wikis/${curso.id}/versions/1/pages/ganchos`,
      ]) {
        for (const method of ["PUT", "PATCH", "POST", "DELETE"]) {
          const res = await t.as(juliana).request(caminho, {
            method,
            headers: { "content-type": "application/json" },
            body: method === "DELETE" ? undefined : JSON.stringify(nova),
          });
          expect(res.status).toBe(404);
        }
      }
      expect((await t.as(juliana).post(`/api/wikis/${curso.id}/versions/1/pages`, nova)).status).toBe(404);

      const ganchos: WikiPageViewDto = await (await lerPagina(t, curso, "ganchos")).json();
      expect(ganchos.page.body).toBe("O gancho vem nos 3 primeiros segundos.");
    },
    LONGO,
  );
});

describe("a Sincronização, para quem lê a Wiki", () => {
  test(
    "o Membro vê a data da última Sincronização e, durante uma, que ela está em curso, em tempo real; a versão nova chega no fim",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      await workspace(t);
      const curso = await criarWiki(t, "Curso de Redes Sociais");
      const fim = { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };

      // A barra lateral do Bruno está aberta: a Wiki aparece quando a versão 1 sai.
      const doBruno = await t.socket(bruno);
      await subir(t, curso, AULA_1());
      await t.as(juliana).post(`/api/wikis/${curso.id}/sync`);
      const primeira = await cerebro.nextSync();
      for (const input of CURSO) await primeira.request.tools!.call("escrever_pagina", input, primeira.signal);
      await primeira.emit(fim);
      await (await cerebro.nextSync()).emit(fim); // a revisão
      const { wiki: publicada } = await doBruno.next("wiki.updated");
      expect(publicada).toMatchObject({ id: curso.id, currentVersion: { number: 1 } });
      const lista: WikiDto[] = await (await t.as(bruno).get("/api/wikis")).json();
      expect(lista.map((w) => w.id)).toEqual([curso.id]);

      const lida: WikiPageViewDto = await (await lerPagina(t, curso, "index")).json();
      expect(lida.wiki.lastSync).toMatchObject({ state: "done", version: 1 });
      expect(lida.wiki.lastSync!.finishedAt).toEqual(expect.any(String));

      // Uma Sincronização nova: o Bruno, lendo a versão 1, vê que ela está em curso.
      await subir(t, curso, new File(["Aula 2."], "aula-02.txt"));
      await t.as(juliana).post(`/api/wikis/${curso.id}/sync`);
      const segunda = await cerebro.nextSync();
      const emCurso = await eventually("a Sincronização em curso chegar ao Bruno", async () => {
        const sync = doBruno.received().findLast((e) => e.type === "wiki_sync.updated")?.sync;
        return sync?.state === "running" ? sync : undefined;
      });
      expect(emCurso).toMatchObject({ wikiId: curso.id, step: { kind: "source", fileName: "aula-02.txt" } });
      const durante: WikiPageViewDto = await (await lerPagina(t, curso, "index")).json();
      expect(durante).toMatchObject({ version: 1, wiki: { lastSync: { state: "running" } } });

      await segunda.emit(fim);
      await (await cerebro.nextSync()).emit(fim); // a revisão
      const novo = await eventually("a versão 2 chegar ao Bruno", async () => {
        const wiki = doBruno.received().findLast((e) => e.type === "wiki.updated")?.wiki;
        return wiki?.currentVersion?.number === 2 ? wiki : undefined;
      });
      expect(novo.lastSync).toMatchObject({ state: "done", version: 2 });
      const depois: WikiPageViewDto = await (await lerPagina(t, curso, "index")).json();
      expect(depois.version).toBe(2);
    },
    LONGO,
  );
});
