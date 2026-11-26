/**
 * A citação da Wiki na resposta (spec #74, ticket #85; histórias 46, 56 e 57). O Agente cita a
 * página com `[[wiki:<nome>/<slug>]]`. Ao gravar a resposta, o Shearim confere cada marcador
 * contra as páginas que a execução leu por "ler a Wiki" e guarda com a mensagem as citações
 * válidas (a Wiki, o slug e a versão lida). Quem vê a mensagem recebe, por marcador, o link para a
 * página na versão lida; um marcador sem leitura aparece "não consultada", sem link e sem o nome
 * da Wiki; quem não lê a Wiki vê a citação sem link e sem o nome dela. A citação de uma versão
 * antiga abre aquela versão, mesmo que a página não exista mais na atual. Pela Chave e pela Conta.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentDto,
  ChannelDto,
  MeDto,
  MessageDto,
  WikiCitationDto,
  WikiDto,
  WikiPageViewDto,
} from "@shearim/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const bia = { id: "1003", login: "bia@exemplo.com", name: "Bia" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const LER = "ler_a_wiki";
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };
const PRODUTO = { name: "Produto", description: "O roadmap e as decisões de produto." };
const FINANCEIRO = { name: "Financeiro", description: "O caixa, as metas e os salários." };

interface Workspace {
  eu: MeDto;
  bia: MeDto;
  social: AgentDto;
  marketing: ChannelDto;
  dev: ChannelDto;
  diretoria: ChannelDto;
}

/**
 * Juliana (Admin) grava a Chave e cria o Social; Bruno e Bia entram. O Social está em #marketing e
 * #dev (públicos, com Bruno) e em #diretoria (privado, só Juliana e Bia).
 */
async function workspace(t: TestApp): Promise<Workspace> {
  const eu: MeDto = await (await t.as(juliana).get("/api/me")).json();
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const res = await t.as(juliana).post("/api/agents", {
    name: "Social",
    photo: null,
    description: "O Social.",
    instructions: "Você é o Social.",
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  const social: AgentDto = await res.json();
  await t.addMember(bruno, { by: juliana });
  const daBia = await t.addMember(bia, { by: juliana });
  const canal = async (name: string, kind: "public" | "private"): Promise<ChannelDto> => {
    const criado = await t.as(juliana).post("/api/channels", { name, kind });
    expect(criado.status).toBe(201);
    const channel: ChannelDto = await criado.json();
    await t.as(juliana).post(`/api/channels/${channel.id}/agents`, { agentId: social.id });
    if (kind === "public") await t.as(bruno).post(`/api/channels/${channel.id}/join`);
    return channel;
  };
  const marketing = await canal("marketing", "public");
  const dev = await canal("dev", "public");
  const diretoria = await canal("diretoria", "private");
  expect((await t.as(juliana).post(`/api/channels/${diretoria.id}/participants`, { memberId: daBia.id })).status).toBe(
    200,
  );
  return { eu, bia: daBia, social, marketing, dev, diretoria };
}

async function criarWiki(t: TestApp, input: { name: string; description: string }): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", input);
  expect(res.status).toBe(201);
  return res.json();
}

interface Pagina {
  slug: string;
  titulo: string;
  corpo: string;
}

const GANCHOS: Pagina = { slug: "ganchos", titulo: "Ganchos", corpo: "O gancho vem nos 3 primeiros segundos." };
const METAS: Pagina = { slug: "metas", titulo: "Metas", corpo: "A meta do trimestre é 2 milhões." };

/**
 * Sobe a Fonte `fonte` e sincroniza: a Articuladora escreve as páginas e o índice, e remove as de
 * `remover`. Espera a versão `versao` ser publicada.
 */
async function sincronizar(
  t: TestApp,
  wiki: WikiDto,
  { fonte, paginas, remover = [], versao }: { fonte: string; paginas: Pagina[]; remover?: string[]; versao: number },
) {
  const form = new FormData();
  form.append("files", new File([`# ${fonte}\n\nUma aula.\n`], fonte));
  expect((await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(
    201,
  );
  const escrever = (p: Pagina) => ({
    name: "escrever_pagina",
    input: { slug: p.slug, titulo: p.titulo, corpo: p.corpo, fontes: [fonte] },
  });
  const indice: Pagina = {
    slug: "index",
    titulo: "Índice",
    corpo: paginas.map((p) => `- [[${p.slug}]]: ${p.titulo}.`).join("\n") || "Nada.",
  };
  t.anthropic.sync(
    {
      toolUse: [
        ...paginas.map(escrever),
        ...remover.map((slug) => ({ name: "remover_pagina", input: { slug } })),
        escrever(indice),
      ],
    },
    { text: "Pronto." },
  );
  expect((await t.as(juliana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await eventually("a Sincronização publicar", async () => {
    const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
    return lista.find((w) => w.id === wiki.id)?.currentVersion?.number === versao ? true : undefined;
  });
}

const ligar = async (t: TestApp, wiki: WikiDto, channel: ChannelDto) =>
  expect((await t.as(juliana).put(`/api/wikis/${wiki.id}/channels/${channel.id}`)).status).toBe(200);

/** A Wiki Curso (versão 1, com Ganchos), ligada a #marketing. */
async function cursoNoMarketing(t: TestApp) {
  const ws = await workspace(t);
  const curso = await criarWiki(t, CURSO);
  await sincronizar(t, curso, { fonte: "aula-01.md", paginas: [GANCHOS], versao: 1 });
  await ligar(t, curso, ws.marketing);
  return { ...ws, curso };
}

async function enviar(t: TestApp, conversationId: string, body: string, who: Person): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** A resposta a `origem`, como `who` a vê na lista da conversa. */
async function respostaA(t: TestApp, conversationId: string, origem: MessageDto, who: Person) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(who).get(`/api/conversations/${conversationId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    20_000,
  );
}

/**
 * Pela Chave, o Social lê cada entrada (um turno por leitura) e responde `texto`. Devolve a
 * resposta como `who` a vê na lista e a que chegou a ele em tempo real.
 */
async function responder(
  t: TestApp,
  conversationId: string,
  who: Person,
  leituras: Record<string, unknown>[],
  texto: string,
) {
  const aba = await t.socket(who);
  t.anthropic.reply(...leituras.map((input, i) => ({ toolUse: [{ id: `toolu_${i + 1}`, name: LER, input }] })), {
    text: texto,
  });
  const origem = await enviar(t, conversationId, "@social como abro um vídeo?", who);
  const resposta = await respostaA(t, conversationId, origem, who);
  const aoVivo = await eventually("a resposta chegar em tempo real", async () =>
    aba
      .received()
      .flatMap((e) => (e.type === "message.created" && e.message.id === resposta.id ? [e.message] : []))
      .at(0),
  );
  await aba.close();
  return { resposta, aoVivo };
}

const abrir = (t: TestApp, who: Person, wikiId: string, version: number, slug: string) =>
  t.as(who).get(`/api/wikis/${wikiId}/versions/${version}/pages/${slug}`);

describe("a citação na resposta", () => {
  test(
    "pela Chave, o Social lê Ganchos e responde com [[wiki:Curso/ganchos]]: a mensagem traz o link para a página na versão lida, na lista e em tempo real, e o link abre a página",
    async () => {
      const t = await testApp();
      const { marketing, curso } = await cursoNoMarketing(t);

      const { resposta, aoVivo } = await responder(
        t,
        marketing.id,
        bruno,
        [{ wiki: "Curso", pagina: "ganchos" }],
        "O gancho vem logo no começo [[wiki:Curso/ganchos]].",
      );

      const esperado: WikiCitationDto[] = [
        {
          marker: "[[wiki:Curso/ganchos]]",
          state: "linked",
          wikiId: curso.id,
          wikiName: "Curso",
          slug: "ganchos",
          version: 1,
          title: "Ganchos",
        },
      ];
      expect(resposta.wikiCitations).toEqual(esperado);
      expect(aoVivo.wikiCitations).toEqual(esperado);

      const pagina = await abrir(t, bruno, curso.id, 1, "ganchos");
      expect(pagina.status).toBe(200);
      const lida: WikiPageViewDto = await pagina.json();
      expect(lida).toMatchObject({ version: 1, inCurrentVersion: true, page: { slug: "ganchos", title: "Ganchos" } });
      expect(lida.wiki.currentVersion?.number).toBe(1);
    },
    LONGO,
  );

  test(
    'um marcador de página que a execução não leu, e um de uma Wiki fora do alcance, aparecem "não consultada", sem link e sem o nome da Wiki',
    async () => {
      const t = await testApp();
      const { marketing, dev } = await cursoNoMarketing(t);
      // O Produto existe e tem a página roadmap, mas está ligado só a #dev.
      const produto = await criarWiki(t, PRODUTO);
      await sincronizar(t, produto, {
        fonte: "roadmap.md",
        paginas: [{ slug: "roadmap", titulo: "Roadmap", corpo: "O app sai em março." }],
        versao: 1,
      });
      await ligar(t, produto, dev);

      // Leu só o índice do Curso: Ganchos não foi lida, e o Produto não está em #marketing.
      const { resposta, aoVivo } = await responder(
        t,
        marketing.id,
        bruno,
        [{ wiki: "Curso" }],
        "Comece pelo gancho [[wiki:Curso/ganchos]]. O app sai em março [[wiki:Produto/roadmap]]. Veja o índice [[wiki:Curso/index]].",
      );

      for (const vista of [resposta, aoVivo]) {
        expect(vista.wikiCitations).toMatchObject([
          { marker: "[[wiki:Curso/ganchos]]", state: "not_consulted" },
          { marker: "[[wiki:Produto/roadmap]]", state: "not_consulted" },
          { marker: "[[wiki:Curso/index]]", state: "linked", slug: "index", version: 1, title: "Índice" },
        ]);
        expect(vista.wikiCitations![0]).toEqual({ marker: "[[wiki:Curso/ganchos]]", state: "not_consulted" });
        expect(vista.wikiCitations![1]).toEqual({ marker: "[[wiki:Produto/roadmap]]", state: "not_consulted" });
      }
    },
    LONGO,
  );

  test(
    'a leitura de uma página não vale para outra resposta: o mesmo marcador numa resposta sem leitura é "não consultada"',
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);
      await responder(t, marketing.id, bruno, [{ wiki: "Curso", pagina: "ganchos" }], "Lido [[wiki:Curso/ganchos]].");

      const { resposta } = await responder(t, marketing.id, bruno, [], "De novo [[wiki:Curso/ganchos]].");

      expect(resposta.wikiCitations).toEqual([{ marker: "[[wiki:Curso/ganchos]]", state: "not_consulted" }]);
    },
    LONGO,
  );

  test(
    "uma mensagem sem marcador não traz citações, nem a de pessoa que escreve um marcador",
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);
      const { resposta } = await responder(t, marketing.id, bruno, [{ wiki: "Curso" }], "Sem citar.");
      expect(resposta.wikiCitations).toBeUndefined();

      const minha = await enviar(t, marketing.id, "olha [[wiki:Curso/ganchos]]", bruno);
      expect(minha.wikiCitations).toBeUndefined();
    },
    LONGO,
  );
});

describe("a citação de uma versão antiga", () => {
  test(
    "depois da versão 2, a citação continua na versão 1, e ela abre a versão 1 com a versão atual ao lado para o aviso",
    async () => {
      const t = await testApp();
      const { marketing, curso } = await cursoNoMarketing(t);
      const { resposta } = await responder(
        t,
        marketing.id,
        bruno,
        [{ wiki: "Curso", pagina: "ganchos" }],
        "Veja [[wiki:Curso/ganchos]].",
      );

      await sincronizar(t, curso, {
        fonte: "aula-02.md",
        paginas: [{ ...GANCHOS, corpo: "O gancho vem no primeiro segundo." }],
        versao: 2,
      });

      const depois = await respostaA(t, marketing.id, { id: resposta.originMessageId! } as MessageDto, bruno);
      expect(depois.wikiCitations).toMatchObject([{ state: "linked", wikiId: curso.id, slug: "ganchos", version: 1 }]);
      const lida: WikiPageViewDto = await (await abrir(t, bruno, curso.id, 1, "ganchos")).json();
      expect(lida).toMatchObject({ version: 1, inCurrentVersion: true, page: { body: GANCHOS.corpo } });
      expect(lida.wiki.currentVersion?.number).toBe(2);
      const atual: WikiPageViewDto = await (await t.as(bruno).get(`/api/wikis/${curso.id}/pages/ganchos`)).json();
      expect(atual).toMatchObject({ version: 2, page: { body: "O gancho vem no primeiro segundo." } });
    },
    LONGO,
  );

  test(
    "uma página que não existe mais na versão atual continua abrindo pela citação, na versão citada",
    async () => {
      const t = await testApp();
      const { marketing, curso } = await cursoNoMarketing(t);
      const { resposta } = await responder(
        t,
        marketing.id,
        bruno,
        [{ wiki: "Curso", pagina: "ganchos" }],
        "Veja [[wiki:Curso/ganchos]].",
      );
      await sincronizar(t, curso, {
        fonte: "aula-02.md",
        paginas: [{ slug: "reels", titulo: "Reels", corpo: "Reels de até 30 segundos." }],
        remover: ["ganchos"],
        versao: 2,
      });

      expect((await t.as(bruno).get(`/api/wikis/${curso.id}/pages/ganchos`)).status).toBe(404);
      const [citacao] = resposta.wikiCitations!;
      expect(citacao).toMatchObject({ state: "linked", version: 1 });
      const pela = await abrir(t, bruno, curso.id, 1, "ganchos");
      expect(pela.status).toBe(200);
      expect(await pela.json()).toMatchObject({ version: 1, inCurrentVersion: false, page: { title: "Ganchos" } });
    },
    LONGO,
  );

  test(
    'uma versão ou uma página que não existe dá 404 com o motivo; uma Wiki fora do alcance, o mesmo 404 de "não existe"',
    async () => {
      const t = await testApp();
      const { curso } = await cursoNoMarketing(t);

      const versao = await abrir(t, bruno, curso.id, 7, "ganchos");
      expect(versao.status).toBe(404);
      expect(await versao.json()).toEqual({ error: "not_found", message: "Essa página não existe na Wiki Curso." });
      const pagina = await abrir(t, bruno, curso.id, 1, "reels");
      expect(pagina.status).toBe(404);
      expect(await pagina.json()).toEqual({ error: "not_found", message: "Essa página não existe na Wiki Curso." });
      const outra = await abrir(t, bruno, crypto.randomUUID(), 1, "ganchos");
      expect(await outra.json()).toEqual({ error: "not_found", message: "Essa Wiki não existe." });
    },
    LONGO,
  );
});

describe("quem vê a mensagem mas não lê a Wiki", () => {
  test(
    "o Financeiro é restrito a Juliana e Bia: a resposta em #diretoria cita Metas com link; depois que Bia sai da lista, ela vê a citação sem link e sem o nome da Wiki, e a página não abre para ela",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await criarWiki(t, FINANCEIRO);
      const lista = (memberIds: string[]) =>
        t.as(juliana).put(`/api/wikis/${financeiro.id}/reach`, { scope: "restricted", memberIds });
      expect((await lista([ws.eu.id, ws.bia.id])).status).toBe(200);
      await sincronizar(t, financeiro, { fonte: "metas.md", paginas: [METAS], versao: 1 });
      await ligar(t, financeiro, ws.diretoria);

      const { resposta, aoVivo } = await responder(
        t,
        ws.diretoria.id,
        bia,
        [{ wiki: "Financeiro", pagina: "metas" }],
        "A meta é 2 milhões [[wiki:Financeiro/metas]].",
      );
      const comLink = { state: "linked", wikiId: financeiro.id, slug: "metas", version: 1, title: "Metas" };
      expect(resposta.wikiCitations).toMatchObject([comLink]);
      expect(aoVivo.wikiCitations).toMatchObject([comLink]);

      expect((await lista([ws.eu.id])).status).toBe(200);

      const daBia = await respostaA(t, ws.diretoria.id, { id: resposta.originMessageId! } as MessageDto, bia);
      // Fora do alcance, nem pelo nome (história 52): nem a citação nem o corpo dizem qual é a Wiki.
      expect(daBia.wikiCitations).toEqual([{ marker: "[[wiki:?/metas]]", state: "unlinked", slug: "metas" }]);
      expect(daBia.body).toBe("A meta é 2 milhões [[wiki:?/metas]].");
      expect((await abrir(t, bia, financeiro.id, 1, "metas")).status).toBe(404);
      const daJuliana = await respostaA(t, ws.diretoria.id, { id: resposta.originMessageId! } as MessageDto, juliana);
      expect(daJuliana.wikiCitations).toMatchObject([comLink]);
    },
    LONGO,
  );
});

describe("pela Conta", () => {
  test(
    'o claude -p lê Ganchos pelo endpoint MCP do Shearim e cita [[wiki:Curso/ganchos]]: a mensagem traz o link na versão lida; o marcador de uma página não lida fica "não consultada"',
    async () => {
      const t = await testApp();
      const { marketing, curso } = await cursoNoMarketing(t);
      await t.linkAccount(bruno);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [
            { tool: { name: LER, input: { wiki: "Curso", pagina: "ganchos" } } },
            { text: "O gancho vem logo [[wiki:Curso/ganchos]], e o reels [[wiki:Curso/reels]]." },
          ],
        },
      });

      const origem = await enviar(t, marketing.id, "@social como abro um vídeo?", bruno);
      const resposta = await respostaA(t, marketing.id, origem, bruno);

      expect(resposta.payer).toBeUndefined();
      expect(resposta.wikiCitations).toEqual([
        {
          marker: "[[wiki:Curso/ganchos]]",
          state: "linked",
          wikiId: curso.id,
          wikiName: "Curso",
          slug: "ganchos",
          version: 1,
          title: "Ganchos",
        },
        { marker: "[[wiki:Curso/reels]]", state: "not_consulted" },
      ]);
    },
    LONGO,
  );
});
