import { describe, expect, test } from "bun:test";
import type { WikiDto, WikiSourceDto } from "@regents/contracts";
import { configFrom } from "../src/config";
import { wikiFromEnv } from "../src/wiki/sources";
import { type Person, type TestApp, testApp } from "./harness";

// A Wiki e as Fontes na administração (#78): o Admin cria a Wiki, sobe as Fontes e vê as pendentes.
// Ainda não há Sincronização: a Wiki aparece como "nunca sincronizada".

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };

async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
}

async function criarWiki(t: TestApp, name = "Curso de Redes Sociais"): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", { name, description: "O curso transcrito, aula por aula." });
  expect(res.status).toBe(201);
  return res.json();
}

const wikisNaAdministracao = async (t: TestApp): Promise<WikiDto[]> =>
  (await t.as(juliana).get("/api/wiki-settings")).json();

/** Sobe as Fontes como o PWA sobe: multipart, um campo `files` por arquivo. */
function subir(t: TestApp, who: Person, wiki: WikiDto, ...files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return t.as(who).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
}

const fontesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiSourceDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();

const AULA_1 = new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");
const AULA_2 = new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");

describe("o Admin cria uma Wiki", () => {
  test('"Curso de Redes Sociais" aparece na lista de Wikis da administração, pública e nunca sincronizada', async () => {
    const t = await testApp();
    await workspace(t);
    const criada = await criarWiki(t);

    expect(criada).toMatchObject({
      name: "Curso de Redes Sociais",
      description: "O curso transcrito, aula por aula.",
      scope: "public",
      currentVersion: null,
      pending: 0,
    });
    expect(await wikisNaAdministracao(t)).toEqual([criada]);
  });
});

describe("o nome da Wiki é único", () => {
  test("um segundo nome igual, sem diferenciar maiúsculas, é recusado com o motivo", async () => {
    const t = await testApp();
    await workspace(t);
    const primeira = await criarWiki(t);

    const res = await t.as(juliana).post("/api/wikis", { name: "curso de REDES sociais", description: "Outra." });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("name_taken");
    expect(body.message).toContain("Curso de Redes Sociais");
    expect(await wikisNaAdministracao(t)).toEqual([primeira]);
  });
});

describe("o Admin sobe as Fontes", () => {
  test('aula-01.md e aula-02.txt aparecem como pendentes ("nova"), e a Wiki segue nunca sincronizada', async () => {
    const t = await testApp();
    await workspace(t);
    const wiki = await criarWiki(t);

    const res = await subir(t, juliana, wiki, AULA_1, AULA_2);
    expect(res.status).toBe(201);
    const subidas: WikiSourceDto[] = await res.json();

    const esperadas = [
      { fileName: "aula-01.md", format: "md", sizeBytes: 49, state: "active", pending: "new" },
      { fileName: "aula-02.txt", format: "txt", sizeBytes: 41, state: "active", pending: "new" },
    ].map((f) => ({ ...f, wikiId: wiki.id, uploadedBy: { id: expect.any(String), name: "Juliana" } }));
    expect(subidas).toMatchObject(esperadas);
    expect(await fontesDe(t, wiki)).toEqual(subidas);
    expect(await wikisNaAdministracao(t)).toMatchObject([{ id: wiki.id, currentVersion: null, pending: 2 }]);
  });
});

describe("a Fonte fora do formato ou do tamanho é recusada na hora", () => {
  test("um .pdf é recusado com o motivo, e a lista não muda", async () => {
    const t = await testApp();
    await workspace(t);
    const wiki = await criarWiki(t);
    await subir(t, juliana, wiki, AULA_1);
    const antes = await fontesDe(t, wiki);

    // Junto de uma Fonte boa: o pedido é todo ou nada.
    const res = await subir(t, juliana, wiki, AULA_2, new File(["%PDF-1.7"], "apostila.pdf"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_source");
    expect(body.message).toContain("apostila.pdf");
    expect(body.message).toContain(".txt");
    expect(body.message).toContain(".md");
    expect(await fontesDe(t, wiki)).toEqual(antes);
  });

  test("um arquivo acima do tamanho máximo da Instalação é recusado com o motivo, e a lista não muda", async () => {
    const t = await testApp({ wiki: { sourceMaxBytes: 1000 } });
    await workspace(t);
    const wiki = await criarWiki(t);
    await subir(t, juliana, wiki, AULA_1);
    const antes = await fontesDe(t, wiki);

    // 1001 bytes: um a mais que o máximo. No limite exato, passa.
    const res = await subir(t, juliana, wiki, new File(["a".repeat(1001)], "aula-03.md"));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("source_too_large");
    expect(body.message).toContain("aula-03.md");
    expect(body.message).toContain("1 KB");
    expect(await fontesDe(t, wiki)).toEqual(antes);

    expect((await subir(t, juliana, wiki, new File(["a".repeat(1000)], "aula-03.md"))).status).toBe(201);
  });

  test("o tamanho máximo é ajustável na Instalação (SHEARIM_WIKI_SOURCE_MAX_MB)", () => {
    expect(wikiFromEnv(configFrom({}))).toEqual({});
    expect(wikiFromEnv(configFrom({ SHEARIM_WIKI_SOURCE_MAX_MB: "2" }))).toEqual({ sourceMaxBytes: 2_000_000 });
    expect(wikiFromEnv(configFrom({ SHEARIM_WIKI_SOURCE_MAX_MB: "0.5" }))).toEqual({ sourceMaxBytes: 500_000 });
    for (const errado of ["0", "-3", "muito"]) {
      expect(() => wikiFromEnv(configFrom({ SHEARIM_WIKI_SOURCE_MAX_MB: errado }))).toThrow(
        `SHEARIM_WIKI_SOURCE_MAX_MB=${errado} não é um número maior que zero.`,
      );
    }
  });
});

describe("só o Admin mantém a Wiki", () => {
  test("um Membro que não é Admin recebe 403 ao criar uma Wiki ou subir uma Fonte", async () => {
    const t = await testApp();
    await workspace(t);
    const wiki = await criarWiki(t);

    const criar = await t.as(bruno).post("/api/wikis", { name: "Marketing", description: "O que o marketing sabe." });
    expect(criar.status).toBe(403);
    expect((await criar.json()).error).toBe("not_admin");
    const fonte = await subir(t, bruno, wiki, AULA_1);
    expect(fonte.status).toBe(403);
    expect((await fonte.json()).error).toBe("not_admin");

    expect(await wikisNaAdministracao(t)).toMatchObject([{ name: "Curso de Redes Sociais", pending: 0 }]);
    expect(await fontesDe(t, wiki)).toEqual([]);
  });
});

describe("a Fonte não muda depois de subir", () => {
  test("não há rota para mudar o texto de uma Fonte, e subir outra com o mesmo nome é recusado", async () => {
    const t = await testApp();
    await workspace(t);
    const wiki = await criarWiki(t);
    const [aula] = (await (await subir(t, juliana, wiki, AULA_1)).json()) as WikiSourceDto[];
    const antes = await fontesDe(t, wiki);

    const caminho = `/api/wikis/${wiki.id}/sources/${aula!.id}`;
    for (const mudar of [t.as(juliana).put, t.as(juliana).patch, t.as(juliana).post]) {
      expect((await mudar(caminho, { text: "# Aula 1, corrigida" })).status).toBe(404);
    }
    const outraVez = await subir(t, juliana, wiki, new File(["# Aula 1, corrigida\n"], "AULA-01.md"));
    expect(outraVez.status).toBe(409);
    const body = await outraVez.json();
    expect(body.error).toBe("source_exists");
    expect(body.message).toContain("aula-01.md");
    expect(await fontesDe(t, wiki)).toEqual(antes);
  });
});
