import { describe, expect, test } from "bun:test";
import {
  type AgentDto,
  type AgentSkillDto,
  type ChannelDto,
  type ServerEvent,
  type WikiDto,
  type WikiPageDto,
  type WikiSourceDto,
  type WikiSyncDto,
  type WikiVersionDto,
  wikiSyncStepText,
} from "@shearim/contracts";
import { configFrom } from "../src/config";
import { wikiFromEnv } from "../src/wiki/sources";
import { lastUserText, type RecordedRequest, toolResults } from "./fakes/messages-api";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type Person, type TestApp, testApp } from "./harness";

// A Sincronização pela Chave, no caminho feliz (#79; spec #74, ADR 0015): o Admin aperta
// "Sincronizar", a Articuladora leva as Fontes pendentes para as páginas, uma Fonte por vez, num
// rascunho, e o Shearim publica a versão 1 com o índice, o `log` e o relatório.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 30_000;

async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.addMember(bruno, { by: juliana });
}

async function criarWiki(t: TestApp, name = "Curso de Redes Sociais"): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", { name, description: "O curso transcrito, aula por aula." });
  expect(res.status).toBe(201);
  return res.json();
}

function subir(t: TestApp, wiki: WikiDto, ...files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
}

const AULA_1 = new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");
const AULA_2 = new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");

/** Uma Wiki com as duas aulas pendentes. */
async function wikiComDuasAulas(t: TestApp) {
  await workspace(t);
  const wiki = await criarWiki(t);
  expect((await subir(t, wiki, AULA_1, AULA_2)).status).toBe(201);
  return wiki;
}

const sincronizar = (t: TestApp, wiki: WikiDto, who: Person = juliana) => t.as(who).post(`/api/wikis/${wiki.id}/sync`);

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const versoesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiVersionDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json();

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

/** Espera a Sincronização da Wiki terminar (bem ou não) e devolve como ela ficou. */
const terminada = (t: TestApp, wiki: WikiDto) =>
  eventually("a Sincronização terminar", async () => {
    const sync = (await naAdministracao(t, wiki)).lastSync;
    return sync && !["queued", "running"].includes(sync.state) ? sync : undefined;
  });

/** As duas aulas, como a Articuladora as levaria: uma página por aula, ligadas, e o índice. */
function roteiroDasDuasAulas(t: TestApp) {
  t.anthropic.sync(
    {
      toolUse: [
        {
          name: "escrever_pagina",
          input: {
            slug: "ganchos",
            titulo: "Ganchos",
            corpo: "O gancho vem nos 3 primeiros segundos.",
            fontes: ["aula-01.md"],
          },
        },
        {
          name: "escrever_pagina",
          input: {
            slug: "index",
            titulo: "Índice",
            corpo: "- [[ganchos]]: o começo do vídeo.",
            fontes: ["aula-01.md"],
          },
        },
      ],
    },
    { text: "Pronto." },
    {
      toolUse: [
        {
          name: "escrever_pagina",
          input: {
            slug: "carrossel",
            titulo: "Carrossel",
            corpo: "Uma ideia por cartão. Abra com um [[ganchos|gancho]].",
            fontes: ["aula-02.txt"],
          },
        },
        {
          name: "escrever_pagina",
          input: {
            slug: "index",
            titulo: "Índice",
            corpo: "- [[ganchos]]: o começo do vídeo.\n- [[carrossel]]: uma ideia por cartão.",
            fontes: ["aula-01.md", "aula-02.txt"],
          },
        },
      ],
    },
    { text: "Pronto." },
  );
}

describe("o Admin sincroniza a Wiki pela Chave", () => {
  test(
    "a versão 1 tem as páginas que a Articuladora escreveu, cada uma com as Fontes dela, o índice e o log",
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      roteiroDasDuasAulas(t);

      const res = await sincronizar(t, wiki);
      expect(res.status).toBe(202);
      const pedida: WikiSyncDto = await res.json();
      expect(pedida).toMatchObject({ wikiId: wiki.id, startedBy: { name: "Juliana" } });

      const sync = await terminada(t, wiki);
      expect(sync).toMatchObject({ id: pedida.id, state: "done", reason: null, version: 1 });

      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: { number: 1 }, pending: 0 });
      const [versao, ...outras] = await versoesDe(t, wiki);
      expect(outras).toEqual([]);
      expect(versao).toMatchObject({ number: 1, startedBy: { name: "Juliana" }, current: true });

      const paginas = await paginasDe(t, wiki, 1);
      const resumo = paginas.map((p) => ({ slug: p.slug, title: p.title, fontes: p.sources.map((s) => s.fileName) }));
      expect(resumo).toEqual([
        { slug: "carrossel", title: "Carrossel", fontes: ["aula-02.txt"] },
        { slug: "ganchos", title: "Ganchos", fontes: ["aula-01.md"] },
        { slug: "index", title: "Índice", fontes: ["aula-01.md", "aula-02.txt"] },
        { slug: "log", title: "Log", fontes: [] },
      ]);
      expect(paginas.find((p) => p.slug === "carrossel")!.body).toBe(
        "Uma ideia por cartão. Abra com um [[ganchos|gancho]].",
      );
      const log = paginas.find((p) => p.slug === "log")!.body;
      expect(log).toContain("Versão 1");
      expect(log).toContain("Juliana");
      expect(log).toContain("aula-01.md");
      expect(log).toContain("aula-02.txt");
    },
    LONGO,
  );
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

describe("o estado da Sincronização em tempo real", () => {
  test(
    'o Admin e quem vê a Wiki acompanham "Fonte 1 de 2", "Fonte 2 de 2", "revisando a Wiki", "publicando" e "concluída"',
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      const daJuliana = await t.socket(juliana);
      const doBruno = await t.socket(bruno);
      roteiroDasDuasAulas(t);

      await sincronizar(t, wiki);
      await terminada(t, wiki);

      const esperado = [
        "queued",
        "em curso: Fonte 1 de 2",
        "em curso: Fonte 2 de 2",
        "revisando a Wiki",
        "publicando",
        "concluída",
      ];
      for (const aba of [daJuliana, doBruno]) {
        const visto = await eventually("o anúncio da conclusão", async () => {
          const estados = estadosVistos(aba.received());
          return estados.at(-1) === "concluída" ? estados : undefined;
        });
        expect(visto).toEqual(esperado);
      }
      // A Wiki nova (versão 1, nada pendente) também chega, sem recarregar a tela.
      const { wiki: atualizada } = await daJuliana.next("wiki.updated");
      expect(atualizada).toMatchObject({ id: wiki.id, currentVersion: { number: 1 }, pending: 0 });
    },
    LONGO,
  );
});

describe("tudo ou nada: a Wiki só muda no fim", () => {
  test(
    'durante a Sincronização, a Wiki continua "nunca sincronizada"; a versão 1 aparece de uma vez, no fim',
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComDuasAulas(t);
      await sincronizar(t, wiki);

      const primeira = await cerebro.nextSync();
      const escrita = await primeira.request.tools!.call(
        "escrever_pagina",
        { slug: "ganchos", titulo: "Ganchos", corpo: "Os 3 primeiros segundos.", fontes: ["aula-01.md"] },
        primeira.signal,
      );
      expect(escrita.isError).toBe(false);
      await primeira.emit({ type: "text", text: "Pronto." });
      await primeira.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });

      // A segunda Fonte está em curso, e o rascunho já tem a página da primeira: ninguém a lê.
      const segunda = await cerebro.nextSync();
      const lida = await segunda.request.tools!.call("ler_pagina", { slug: "ganchos" }, segunda.signal);
      expect(lida.content).toContain("Os 3 primeiros segundos.");
      expect(await naAdministracao(t, wiki)).toMatchObject({
        currentVersion: null,
        pending: 2,
        lastSync: { state: "running", step: { kind: "source", current: 2, total: 2, fileName: "aula-02.txt" } },
      });
      expect(await versoesDe(t, wiki)).toEqual([]);
      expect((await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/1/pages`)).status).toBe(404);
      const fontes: WikiSourceDto[] = await (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();
      expect(fontes.map((f) => f.pending)).toEqual(["new", "new"]);

      await segunda.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      // A revisão (#87) também trabalha no rascunho: a Wiki segue sem versão até o fim dela.
      const revisao = await cerebro.nextSync();
      expect(await versoesDe(t, wiki)).toEqual([]);
      await revisao.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      expect(await terminada(t, wiki)).toMatchObject({ state: "done", version: 1 });
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: { number: 1 }, pending: 0 });
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["ganchos", "index", "log"]);
    },
    LONGO,
  );
});

describe("uma Sincronização por Wiki", () => {
  test(
    "um segundo pedido enquanto ela roda é recusado com o motivo, e a que roda segue",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComDuasAulas(t);
      const primeiro: WikiSyncDto = await (await sincronizar(t, wiki)).json();
      const chamada = await cerebro.nextSync();

      const res = await sincronizar(t, wiki);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("sync_running");
      expect(body.message).toContain("Já há uma Sincronização em curso nesta Wiki");
      expect(body.message).toContain("Juliana");

      await chamada.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      const segunda = await cerebro.nextSync();
      await segunda.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      const revisao = await cerebro.nextSync();
      await revisao.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      expect(await terminada(t, wiki)).toMatchObject({ id: primeiro.id, state: "done" });
      expect(cerebro.syncs).toHaveLength(3);
    },
    LONGO,
  );
});

describe('"Sincronizar a Wiki" é uma Habilidade do Shearim', () => {
  test("a tela da Articuladora a mostra ativa e só para leitura; a de outro Agente, não", async () => {
    const t = await testApp();
    await workspace(t);
    const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
    const sophya = agentes.find((a) => a.builtin)!;
    const faro: AgentDto = await (
      await t.as(juliana).post("/api/agents", {
        name: "Faro",
        photo: null,
        description: "O Faro.",
        instructions: "Você é o Faro.",
        model: "claude-sonnet-5-5",
      })
    ).json();

    const dela: AgentSkillDto[] = await (await t.as(juliana).get(`/api/agents/${sophya.id}/skills`)).json();
    const sincronizar = dela.find((h) => h.name === "Sincronizar a Wiki");
    expect(sincronizar).toMatchObject({ active: true, builtin: true });
    expect(sincronizar!.description).toContain("Sincronizar");
    // Só para leitura: nem desativar, nem ativar em outro Agente.
    expect((await t.as(juliana).delete(`/api/agents/${sophya.id}/skills/${sincronizar!.id}`)).status).toBe(404);
    expect((await t.as(juliana).put(`/api/agents/${faro.id}/skills/${sincronizar!.id}`)).status).toBe(404);
    const depois: AgentSkillDto[] = await (await t.as(juliana).get(`/api/agents/${sophya.id}/skills`)).json();
    expect(depois.find((h) => h.name === "Sincronizar a Wiki")).toMatchObject({ active: true });

    const doFaro: AgentSkillDto[] = await (await t.as(juliana).get(`/api/agents/${faro.id}/skills`)).json();
    expect(doFaro.map((h) => h.name)).not.toContain("Sincronizar a Wiki");
    // Ela não é uma Habilidade do Workspace: não aparece na lista de Habilidades.
    const doWorkspace: { name: string }[] = await (await t.as(juliana).get("/api/skills")).json();
    expect(doWorkspace.map((h) => h.name)).not.toContain("Sincronizar a Wiki");
  });
});

describe("o teto de turnos da Sincronização", () => {
  test("é ajustável na Instalação (SHEARIM_WIKI_SYNC_MAX_TURNS)", () => {
    expect(wikiFromEnv(configFrom({}))).toEqual({});
    expect(wikiFromEnv(configFrom({ SHEARIM_WIKI_SYNC_MAX_TURNS: "60" }))).toEqual({ syncMaxToolTurns: 60 });
    expect(() => wikiFromEnv(configFrom({ SHEARIM_WIKI_SYNC_MAX_TURNS: "0" }))).toThrow(
      "SHEARIM_WIKI_SYNC_MAX_TURNS=0 não é um número inteiro maior que zero.",
    );
  });

  test(
    "no teto, a última chamada da Fonte vai sem Ferramentas, e a Sincronização segue",
    async () => {
      const t = await testApp({ wiki: { syncMaxToolTurns: 1 } });
      await workspace(t);
      const wiki = await criarWiki(t);
      await subir(t, wiki, AULA_1);
      const ganchos = { slug: "ganchos", titulo: "Ganchos", corpo: "x", fontes: ["aula-01.md"] };
      t.anthropic.sync({ toolUse: [{ name: "escrever_pagina", input: ganchos }] }, { text: "Pronto." });
      await sincronizar(t, wiki);

      expect(await terminada(t, wiki)).toMatchObject({ state: "done" });
      expect(t.anthropic.syncs[1]!.body.tool_choice).toEqual({ type: "none" });
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["ganchos", "index", "log"]);
    },
    LONGO,
  );
});

const textoDe = (r: RecordedRequest) => {
  const { system } = r.body;
  return {
    system: typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n"),
    user: lastUserText(r.body),
    ferramentas: ((r.body.tools ?? []) as { name: string }[]).map((f) => f.name),
  };
};
const FERRAMENTAS_DA_SINCRONIZACAO = ["ler_pagina", "escrever_pagina", "remover_pagina"];

describe("o que cada chamada da Sincronização recebe", () => {
  test(
    "as regras da Wiki, o índice do rascunho e a Fonte, uma Fonte por chamada, e as Ferramentas internas do rascunho",
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      roteiroDasDuasAulas(t);
      await sincronizar(t, wiki);
      await terminada(t, wiki);

      // Duas chamadas por Fonte: a que escreve e a que fecha, depois dos resultados das Ferramentas;
      // e a revisão (#87), no fim.
      expect(t.anthropic.syncs).toHaveLength(5);
      // Nenhuma delas entra na fila das respostas.
      expect(t.anthropic.requests).toHaveLength(0);
      const [primeira, , segunda] = t.anthropic.syncs.map(textoDe);

      for (const chamada of [primeira!, segunda!]) {
        expect(chamada.system).toContain("## Regras da Wiki");
        expect(chamada.system).toContain("Curso de Redes Sociais");
        expect(chamada.ferramentas).toEqual(FERRAMENTAS_DA_SINCRONIZACAO);
      }
      expect(primeira!.user).toContain("(a Wiki ainda não tem páginas)");
      expect(primeira!.user).toContain("Fonte nova: aula-01.md (Fonte 1 de 2)");
      expect(primeira!.user).toContain("O gancho vem nos 3 primeiros segundos.");
      expect(primeira!.user).not.toContain("aula-02.txt");
      // A segunda chamada vê o índice que a primeira deixou no rascunho.
      expect(segunda!.user).toContain("- [[ganchos]]: o começo do vídeo.");
      expect(segunda!.user).toContain("Fonte nova: aula-02.txt (Fonte 2 de 2)");
      expect(segunda!.user).toContain("Carrossel: uma ideia por cartão.");

      const resultados = toolResults(t.anthropic.syncs[1]!.body);
      expect(resultados.map((r) => r.is_error ?? false)).toEqual([false, false]);
    },
    LONGO,
  );

  test(
    "uma escrita fora das regras volta à Articuladora como erro, e a página não entra na versão",
    async () => {
      const t = await testApp();
      await workspace(t);
      const wiki = await criarWiki(t);
      await subir(t, wiki, AULA_1);
      const pagina = (slug: string, fontes: string[]) => ({ slug, titulo: "Ganchos", corpo: "x", fontes });
      t.anthropic.sync(
        {
          toolUse: [
            { name: "escrever_pagina", input: pagina("Ganchos Bons", ["aula-01.md"]) },
            { name: "escrever_pagina", input: pagina("log", ["aula-01.md"]) },
            { name: "escrever_pagina", input: pagina("ganchos", ["apostila.pdf"]) },
            { name: "ler_pagina", input: { slug: "carrossel" } },
          ],
        },
        { text: "Pronto." },
      );
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki)).toMatchObject({ state: "done" });

      const resultados = toolResults(t.anthropic.syncs[1]!.body);
      expect(resultados.map((r) => r.is_error)).toEqual([true, true, true, true]);
      expect(resultados[0]!.content).toContain("slug");
      expect(resultados[1]!.content).toContain("log é do Shearim");
      expect(resultados[2]!.content).toContain("apostila.pdf não está nesta Wiki");
      expect(resultados[3]!.content).toContain("não existe no rascunho");
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["index", "log"]);
    },
    LONGO,
  );
});

describe("as Ferramentas internas da Sincronização nunca vão a uma resposta em conversa", () => {
  test(
    "a Articuladora e um Agente respondem numa conversa sem ler, escrever nem remover página",
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      roteiroDasDuasAulas(t);
      await sincronizar(t, wiki);
      await terminada(t, wiki);

      const faro: AgentDto = await (
        await t.as(juliana).post("/api/agents", {
          name: "Faro",
          photo: null,
          description: "O Faro.",
          instructions: "Você é o Faro.",
          model: "claude-sonnet-5-5",
        })
      ).json();
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
      const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
      await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
      for (const mencao of ["@faro", "@sophya"]) {
        const res = await t.as(juliana).post(`/api/conversations/${geral!.id}/messages`, { body: `${mencao} oi` });
        expect(res.status).toBe(201);
      }
      const respostas = await eventually("as duas respostas", async () => {
        const feitas = t.anthropic.requests.filter((r) => !r.body.output_config);
        return feitas.length >= 2 ? feitas : undefined;
      });
      for (const r of respostas) {
        for (const nome of FERRAMENTAS_DA_SINCRONIZACAO) expect(textoDe(r).ferramentas).not.toContain(nome);
      }
      expect(respostas.some((r) => textoDe(r).ferramentas.includes("listar_agentes"))).toBe(true);
    },
    LONGO,
  );
});

describe("o relatório da Sincronização", () => {
  test(
    "lista as páginas criadas, sem o índice e o log",
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      roteiroDasDuasAulas(t);
      await sincronizar(t, wiki);

      const esperado = {
        created: [
          { slug: "carrossel", title: "Carrossel" },
          { slug: "ganchos", title: "Ganchos" },
        ],
        updated: [],
        removed: [],
        contradictions: [],
        // O carrossel liga os ganchos; nenhuma página liga o carrossel (o índice não conta).
        check: {
          brokenLinks: [],
          withoutSources: [],
          outsideIndex: [],
          orphans: [{ slug: "carrossel", title: "Carrossel" }],
        },
      };
      expect((await terminada(t, wiki)).report).toEqual(esperado);
      expect((await versoesDe(t, wiki))[0]!.report).toEqual(esperado);
    },
    LONGO,
  );
});

describe("nada a sincronizar", () => {
  test(
    'depois de concluída, nenhuma Fonte fica pendente, e um novo pedido é recusado com "nada a sincronizar"',
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      roteiroDasDuasAulas(t);
      await sincronizar(t, wiki);
      await terminada(t, wiki);

      const fontes: WikiSourceDto[] = await (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();
      expect(fontes.map((f) => f.pending)).toEqual([null, null]);

      const res = await sincronizar(t, wiki);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("nothing_to_sync");
      expect(body.message.toLowerCase()).toContain("nada a sincronizar");
      expect(t.anthropic.syncs).toHaveLength(5);
      expect(await versoesDe(t, wiki)).toHaveLength(1);
    },
    LONGO,
  );

  test("uma Wiki sem Fonte também é recusada, e nenhuma Sincronização começa", async () => {
    const t = await testApp();
    await workspace(t);
    const wiki = await criarWiki(t);

    const res = await sincronizar(t, wiki);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_sync");
    expect(await naAdministracao(t, wiki)).toMatchObject({ lastSync: null, currentVersion: null });
  });
});

describe("só o Admin sincroniza", () => {
  test("um Membro recebe 403, e nenhuma Sincronização começa", async () => {
    const t = await testApp();
    const wiki = await wikiComDuasAulas(t);

    const res = await sincronizar(t, wiki, bruno);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_admin");
    expect(await naAdministracao(t, wiki)).toMatchObject({ lastSync: null, pending: 2 });
    expect(t.anthropic.syncs).toHaveLength(0);
  });
});

describe("o modelo e o orçamento são os da Articuladora", () => {
  test(
    "a Sincronização usa o modelo que o Admin escolheu para a Articuladora, e o gasto conta no orçamento dela",
    async () => {
      const t = await testApp();
      const wiki = await wikiComDuasAulas(t);
      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      const sophya = agentes.find((a) => a.builtin)!;
      expect((await t.as(juliana).patch(`/api/agents/${sophya.id}`, { model: "claude-opus-5-5" })).status).toBe(200);
      // Opus: US$ 4 por milhão de tokens de entrada. Cada chamada (as duas Fontes e a revisão) gasta US$ 1.
      const UM_DOLAR = { input_tokens: 250_000, output_tokens: 0 };
      const pronto = { text: "Pronto.", usage: UM_DOLAR };
      t.anthropic.sync(pronto, pronto, pronto);
      await sincronizar(t, wiki);
      expect(await terminada(t, wiki)).toMatchObject({ state: "done" });

      expect(t.anthropic.syncs.map((r) => r.body.model)).toEqual(Array(3).fill("claude-opus-5-5"));
      expect(t.anthropic.syncs.map((r) => r.apiKey)).toEqual([CHAVE, CHAVE, CHAVE]);
      const depois: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      expect(depois.find((a) => a.id === sophya.id)).toMatchObject({ keySpendUsd: 3 });
    },
    LONGO,
  );
});
