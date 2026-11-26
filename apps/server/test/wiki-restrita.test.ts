/**
 * A Wiki restrita a uma lista de Membros (spec #74, ticket #83; ADR 0014). O Admin restringe a
 * Wiki "Financeiro" a Ana e Bia. Ela só é lida numa resposta em que o autor e todos os que veem a
 * conversa estão na lista; fora disso ela não aparece, nem pelo nome: nem no catálogo, nem na
 * Ferramenta, nem no Andamento, nem na barra lateral, nem nos eventos em tempo real. O Admin vê e
 * mantém toda Wiki na administração, mesmo as restritas a uma lista sem ele.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentDto,
  ChannelDto,
  ExecutionDto,
  MeDto,
  MessageDto,
  WikiDto,
  WikiPageViewDto,
  WikiReachDto,
} from "@shearim/contracts";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const ana = { id: "2001", login: "ana@exemplo.com", name: "Ana" }; // Admin (chega primeiro)
const bia = { id: "2002", login: "bia@exemplo.com", name: "Bia" };
const bruno = { id: "2003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const LER = "ler_a_wiki";
const FINANCEIRO = { name: "Financeiro", description: "O caixa, as metas e os salários." };
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };

interface Workspace {
  ana: MeDto;
  bia: MeDto;
  bruno: MeDto;
  social: AgentDto;
  geral: ChannelDto;
  diretoria: ChannelDto;
}

/**
 * Ana (Admin) grava a Chave e cria o Social; Bia e Bruno entram. O Social está em #geral (público,
 * todo Membro) e em #diretoria (privado, só Ana e Bia).
 */
async function workspace(t: TestApp): Promise<Workspace> {
  const eu: MeDto = await (await t.as(ana).get("/api/me")).json();
  await t.as(ana).put("/api/workspace-key", { apiKey: CHAVE });
  const social: AgentDto = await (
    await t.as(ana).post("/api/agents", {
      name: "Social",
      photo: null,
      description: "O Social.",
      instructions: "Você é o Social.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const daBia = await t.addMember(bia, { by: ana });
  const doBruno = await t.addMember(bruno, { by: ana });
  const canais: ChannelDto[] = await (await t.as(ana).get("/api/channels")).json();
  const geral = canais.find((c) => c.name === "geral")!;
  await t.as(ana).post(`/api/channels/${geral.id}/agents`, { agentId: social.id });
  const res = await t.as(ana).post("/api/channels", { name: "diretoria", kind: "private" });
  expect(res.status).toBe(201);
  const diretoria: ChannelDto = await res.json();
  expect((await t.as(ana).post(`/api/channels/${diretoria.id}/participants`, { memberId: daBia.id })).status).toBe(200);
  await t.as(ana).post(`/api/channels/${diretoria.id}/agents`, { agentId: social.id });
  return { ana: eu, bia: daBia, bruno: doBruno, social, geral, diretoria };
}

async function criarWiki(t: TestApp, input: { name: string; description: string }): Promise<WikiDto> {
  const res = await t.as(ana).post("/api/wikis", input);
  expect(res.status).toBe(201);
  return res.json();
}

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto | undefined> => {
  const lista: WikiDto[] = await (await t.as(ana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id);
};

/** Sobe uma Fonte e sincroniza: a versão publicada tem a página Metas e o índice. */
async function sincronizada(t: TestApp, wiki: WikiDto, versao = 1) {
  const form = new FormData();
  form.append("files", new File([`# Metas ${versao}\n\nA meta do trimestre é 2 milhões.\n`], `metas-${versao}.md`));
  expect((await t.as(ana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(201);
  t.anthropic.sync(
    {
      toolUse: [
        {
          name: "escrever_pagina",
          input: {
            slug: "metas",
            titulo: "Metas",
            corpo: "A meta do trimestre é 2 milhões.",
            fontes: [`metas-${versao}.md`],
          },
        },
        {
          name: "escrever_pagina",
          input: { slug: "index", titulo: "Índice", corpo: "- [[metas]]: as metas.", fontes: [`metas-${versao}.md`] },
        },
      ],
    },
    { text: "Pronto." },
  );
  expect((await t.as(ana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await eventually("a Sincronização publicar", async () => {
    const w = await naAdministracao(t, wiki);
    return w?.currentVersion?.number === versao ? w : undefined;
  });
}

const alcance = (t: TestApp, wiki: WikiDto, body: { scope: string; memberIds: string[] }) =>
  t.as(ana).put(`/api/wikis/${wiki.id}/reach`, body);

const ligar = async (t: TestApp, wiki: WikiDto, channel: ChannelDto) =>
  expect((await t.as(ana).put(`/api/wikis/${wiki.id}/channels/${channel.id}`)).status).toBe(200);

describe("o alcance da Wiki, na administração", () => {
  test(
    "a Wiki nasce pública; o Admin a restringe a Ana e Bia, e a tela mostra os Membros ativos com a marca de quem está na lista",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const wiki = await criarWiki(t, FINANCEIRO);

      const antes = await t.as(ana).get(`/api/wikis/${wiki.id}/reach`);
      expect(antes.status).toBe(200);
      expect(await antes.json()).toEqual({
        scope: "public",
        members: [
          { id: ws.ana.id, name: "Ana", inList: false },
          { id: ws.bia.id, name: "Bia", inList: false },
          { id: ws.bruno.id, name: "Bruno", inList: false },
        ],
      } satisfies WikiReachDto);

      const res = await alcance(t, wiki, { scope: "restricted", memberIds: [ws.bia.id, ws.ana.id] });
      expect(res.status).toBe(200);
      const esperado: WikiReachDto = {
        scope: "restricted",
        members: [
          { id: ws.ana.id, name: "Ana", inList: true },
          { id: ws.bia.id, name: "Bia", inList: true },
          { id: ws.bruno.id, name: "Bruno", inList: false },
        ],
      };
      expect(await res.json()).toEqual(esperado);
      expect(await (await t.as(ana).get(`/api/wikis/${wiki.id}/reach`)).json()).toEqual(esperado);
      expect(await naAdministracao(t, wiki)).toMatchObject({ scope: "restricted" });
    },
    LONGO,
  );

  test(
    "um alcance inválido é recusado com o motivo; quem não é Admin recebe 403; uma Wiki que não existe, 404",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const wiki = await criarWiki(t, FINANCEIRO);

      const escopo = await alcance(t, wiki, { scope: "secreta", memberIds: [] });
      expect(escopo.status).toBe(400);
      expect(await escopo.json()).toMatchObject({ error: "invalid_input" });
      const estranho = await alcance(t, wiki, { scope: "restricted", memberIds: [crypto.randomUUID()] });
      expect(estranho.status).toBe(400);
      expect(await estranho.json()).toMatchObject({ error: "invalid_input" });

      expect((await t.as(bruno).get(`/api/wikis/${wiki.id}/reach`)).status).toBe(403);
      expect(
        (await t.as(bruno).put(`/api/wikis/${wiki.id}/reach`, { scope: "restricted", memberIds: [ws.bruno.id] }))
          .status,
      ).toBe(403);
      expect((await t.as(ana).get(`/api/wikis/${crypto.randomUUID()}/reach`)).status).toBe(404);
      expect(await naAdministracao(t, wiki)).toMatchObject({ scope: "public" });
    },
    LONGO,
  );

  test(
    "quem sai do Workspace sai da lista: some da tela do alcance e, se voltar, volta fora da lista",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const wiki = await criarWiki(t, FINANCEIRO);
      await alcance(t, wiki, { scope: "restricted", memberIds: [ws.bia.id, ws.bruno.id] });

      expect((await t.as(ana).delete(`/api/members/${ws.bruno.id}`)).status).toBeLessThan(300);

      const tela: WikiReachDto = await (await t.as(ana).get(`/api/wikis/${wiki.id}/reach`)).json();
      expect(tela.members.map((m) => [m.name, m.inList])).toEqual([
        ["Ana", false],
        ["Bia", true],
      ]);

      await t.addMember(bruno, { by: ana });
      const depois: WikiReachDto = await (await t.as(ana).get(`/api/wikis/${wiki.id}/reach`)).json();
      expect(depois.members.find((m) => m.name === "Bruno")).toMatchObject({ inList: false });
    },
    LONGO,
  );
});

async function enviar(t: TestApp, conversationId: string, body: string, who: Person): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

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

/** As chamadas de resposta (sem o roteamento nem a extração) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
const systemDe = (r: ReturnType<typeof respostas>[number]) => {
  const { system } = r.body;
  return typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
};
const ferramentasDe = (r: ReturnType<typeof respostas>[number]) =>
  ((r.body.tools ?? []) as { name: string }[]).map((f) => f.name);

/** O pedido que chegou ao modelo para a resposta do Social a `who` em `conversationId`. */
async function perguntar(t: TestApp, conversationId: string, who: Person) {
  const antes = respostas(t).length;
  await respostaA(t, conversationId, await enviar(t, conversationId, "@social qual é a meta?", who), who);
  return respostas(t)[antes]!;
}

/** Os Andamentos da execução de `origem` que chegaram à aba, até o `done`. */
function terminou(aba: Awaited<ReturnType<TestApp["socket"]>>, origem: MessageDto) {
  return eventually("o Andamento terminar", async () => {
    const vistos: ExecutionDto[] = aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
    return vistos.some((e) => e.state === "done") ? vistos : undefined;
  });
}

/** O Social chama ler a Wiki com a entrada e responde "Pronto."; o resultado e o Andamento. */
async function ler(t: TestApp, conversationId: string, who: Person, input: Record<string, unknown>) {
  const aba = await t.socket(who);
  const antes = respostas(t).length;
  t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: LER, input }] }, { text: "Pronto." });
  const origem = await enviar(t, conversationId, "@social qual é a meta?", who);
  await respostaA(t, conversationId, origem, who);
  const resultado = toolResults(respostas(t)[antes + 1]!.body)[0]!;
  const andamento = await terminou(aba, origem);
  await aba.close();
  return { resultado, andamento };
}

/** O Financeiro, restrito a Ana e Bia, sincronizado e ligado a #diretoria. */
async function financeiroNaDiretoria(t: TestApp) {
  const ws = await workspace(t);
  const financeiro = await criarWiki(t, FINANCEIRO);
  expect((await alcance(t, financeiro, { scope: "restricted", memberIds: [ws.ana.id, ws.bia.id] })).status).toBe(200);
  await sincronizada(t, financeiro);
  await ligar(t, financeiro, ws.diretoria);
  return { ...ws, financeiro };
}

describe("a Wiki restrita nas respostas", () => {
  test(
    "em #diretoria, só com Ana e Bia, o Social recebe o Financeiro no catálogo e o lê",
    async () => {
      const t = await testApp();
      const { diretoria } = await financeiroNaDiretoria(t);

      const pedido = await perguntar(t, diretoria.id, bia);
      expect(systemDe(pedido)).toContain("- Financeiro: O caixa, as metas e os salários.");
      expect(ferramentasDe(pedido)).toContain(LER);

      const { resultado, andamento } = await ler(t, diretoria.id, bia, { wiki: "Financeiro", pagina: "metas" });
      expect(resultado.is_error ?? false).toBe(false);
      expect(resultado.content).toContain("A meta do trimestre é 2 milhões.");
      expect(andamento.at(-1)!.tools.filter((f) => f.tool === LER)).toMatchObject([
        { label: "lendo Metas da Wiki Financeiro", state: "done" },
      ]);
    },
    LONGO,
  );

  test(
    "ligado também a #geral (público), o Financeiro não entra no catálogo ali; ler a Wiki com o nome dele falha sem confirmar que ele existe, e o Andamento não o nomeia",
    async () => {
      const t = await testApp();
      const { geral, financeiro } = await financeiroNaDiretoria(t);
      await ligar(t, financeiro, geral);
      // O Curso, público, também está em #geral: ler a Wiki é oferecida ali.
      const curso = await criarWiki(t, CURSO);
      await sincronizada(t, curso);
      await ligar(t, curso, geral);

      const pedido = await perguntar(t, geral.id, ana);
      expect(systemDe(pedido)).toContain("- Curso:");
      expect(systemDe(pedido)).not.toContain("Financeiro");
      expect(ferramentasDe(pedido)).toContain(LER);

      const { resultado, andamento } = await ler(t, geral.id, ana, { wiki: "Financeiro", pagina: "metas" });
      expect(resultado.is_error).toBe(true);
      expect(resultado.content).toBe("A Ferramenta ler a Wiki falhou: não há uma Wiki com esse nome nesta conversa.");
      expect(andamento.at(-1)!.tools.filter((f) => f.tool === LER)).toMatchObject([
        { label: "lendo a Wiki", state: "failed", reason: "não há uma Wiki com esse nome nesta conversa" },
      ]);
      expect(JSON.stringify(andamento)).not.toContain("Financeiro");
    },
    LONGO,
  );

  test(
    "Bruno entra em #diretoria: na resposta seguinte ali, o Financeiro deixa de ser lido",
    async () => {
      const t = await testApp();
      const { diretoria, bruno: doBruno } = await financeiroNaDiretoria(t);
      expect(systemDe(await perguntar(t, diretoria.id, bia))).toContain("- Financeiro:");

      expect(
        (await t.as(ana).post(`/api/channels/${diretoria.id}/participants`, { memberId: doBruno.id })).status,
      ).toBe(200);
      const depois = await perguntar(t, diretoria.id, bia);

      expect(systemDe(depois)).not.toContain("Financeiro");
      expect(ferramentasDe(depois)).not.toContain(LER);
    },
    LONGO,
  );

  test(
    "Ana sai da lista: as respostas a ela em #diretoria deixam de ler o Financeiro",
    async () => {
      const t = await testApp();
      const { diretoria, financeiro, bia: daBia } = await financeiroNaDiretoria(t);
      expect(systemDe(await perguntar(t, diretoria.id, ana))).toContain("- Financeiro:");

      expect((await alcance(t, financeiro, { scope: "restricted", memberIds: [daBia.id] })).status).toBe(200);
      const depois = await perguntar(t, diretoria.id, ana);

      expect(systemDe(depois)).not.toContain("Financeiro");
      expect(ferramentasDe(depois)).not.toContain(LER);
    },
    LONGO,
  );

  test(
    "o Admin torna o Financeiro público: ele passa a ser lido em #geral",
    async () => {
      const t = await testApp();
      const { geral, financeiro } = await financeiroNaDiretoria(t);
      await ligar(t, financeiro, geral);
      expect(systemDe(await perguntar(t, geral.id, bruno))).not.toContain("Financeiro");

      expect((await alcance(t, financeiro, { scope: "public", memberIds: [] })).status).toBe(200);

      expect(systemDe(await perguntar(t, geral.id, bruno))).toContain("- Financeiro:");
    },
    LONGO,
  );
});

const barraLateral = async (t: TestApp, who: Person): Promise<string[]> =>
  ((await (await t.as(who).get("/api/wikis")).json()) as WikiDto[]).map((w) => w.name);

describe("a Wiki restrita para quem lê", () => {
  test(
    "a barra lateral mostra o Financeiro só para Ana e Bia; para Bruno ele não aparece, e a rota da página devolve 404",
    async () => {
      const t = await testApp();
      const { financeiro } = await financeiroNaDiretoria(t);

      expect(await barraLateral(t, ana)).toEqual(["Financeiro"]);
      expect(await barraLateral(t, bia)).toEqual(["Financeiro"]);
      expect(await barraLateral(t, bruno)).toEqual([]);

      const daBia = await t.as(bia).get(`/api/wikis/${financeiro.id}/pages/metas`);
      expect(daBia.status).toBe(200);
      expect(((await daBia.json()) as WikiPageViewDto).page.title).toBe("Metas");
      for (const slug of ["index", "metas", "nao-existe"]) {
        const doBruno = await t.as(bruno).get(`/api/wikis/${financeiro.id}/pages/${slug}`);
        expect(doBruno.status).toBe(404);
        expect(await doBruno.json()).toEqual({ error: "not_found", message: "Essa Wiki não existe." });
      }
    },
    LONGO,
  );

  test(
    "o Admin vê e mantém na administração uma Wiki restrita a uma lista sem ele, mas não a lê fora dela",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await criarWiki(t, FINANCEIRO);
      expect((await alcance(t, financeiro, { scope: "restricted", memberIds: [ws.bia.id] })).status).toBe(200);

      // Ana mantém: sobe Fontes, sincroniza, vê as versões, as páginas e os Canais.
      await sincronizada(t, financeiro);
      await sincronizada(t, financeiro, 2);
      expect(await naAdministracao(t, financeiro)).toMatchObject({
        scope: "restricted",
        currentVersion: { number: 2 },
      });
      expect((await t.as(ana).get(`/api/wikis/${financeiro.id}/sources`)).status).toBe(200);
      expect((await t.as(ana).get(`/api/wikis/${financeiro.id}/versions`)).status).toBe(200);
      expect((await t.as(ana).get(`/api/wikis/${financeiro.id}/versions/2/pages`)).status).toBe(200);
      await ligar(t, financeiro, ws.diretoria);

      // Fora da administração, ela não o lê.
      expect(await barraLateral(t, ana)).toEqual([]);
      expect((await t.as(ana).get(`/api/wikis/${financeiro.id}/pages/index`)).status).toBe(404);
      expect(await barraLateral(t, bia)).toEqual(["Financeiro"]);
    },
    LONGO,
  );
});

describe("a Wiki restrita em tempo real", () => {
  test(
    "a Sincronização do Financeiro chega a Bia (na lista) e a Ana (Admin), e nada dele chega a Bruno",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await criarWiki(t, FINANCEIRO);
      await alcance(t, financeiro, { scope: "restricted", memberIds: [ws.bia.id] });
      const [daAna, daBia, doBruno] = await Promise.all([t.socket(ana), t.socket(bia), t.socket(bruno)]);

      await sincronizada(t, financeiro);
      for (const aba of [daAna, daBia]) {
        const publicada = await eventually("a versão 1 chegar", async () => {
          const wiki = aba.received().findLast((e) => e.type === "wiki.updated")?.wiki;
          return wiki?.currentVersion?.number === 1 ? wiki : undefined;
        });
        expect(publicada.id).toBe(financeiro.id);
        expect(aba.received().some((e) => e.type === "wiki_sync.updated")).toBe(true);
      }

      // Depois, uma Wiki pública sincroniza: ela chega a todos. Para Bruno, os eventos de Wiki que
      // chegaram são só dela.
      const curso = await criarWiki(t, CURSO);
      await sincronizada(t, curso);
      await eventually("o Curso chegar a Bruno", async () =>
        doBruno.received().find((e) => e.type === "wiki.updated" && e.wiki.currentVersion !== null),
      );
      const doFinanceiro = doBruno
        .received()
        .filter((e) => e.type.startsWith("wiki"))
        .filter((e) => JSON.stringify(e).includes(financeiro.id) || JSON.stringify(e).includes("Financeiro"));
      expect(doFinanceiro).toEqual([]);
      await Promise.all([daAna.close(), daBia.close(), doBruno.close()]);
    },
    LONGO,
  );

  test(
    "o Admin restringe uma Wiki pública: quem fica fora recebe só que ela saiu do alcance, e quem fica dentro, a Wiki nova",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await criarWiki(t, FINANCEIRO);
      await sincronizada(t, financeiro);
      const [daBia, doBruno] = await Promise.all([t.socket(bia), t.socket(bruno)]);

      await alcance(t, financeiro, { scope: "restricted", memberIds: [ws.bia.id] });

      expect(await doBruno.next("wiki.left")).toEqual({ type: "wiki.left", wikiId: financeiro.id });
      expect((await daBia.next("wiki.updated")).wiki).toMatchObject({ id: financeiro.id, scope: "restricted" });
      // Bia recebe a Wiki nova, e não a saída.
      await alcance(t, financeiro, { scope: "restricted", memberIds: [ws.bia.id, ws.bruno.id] });
      expect((await doBruno.next("wiki.updated")).wiki).toMatchObject({ id: financeiro.id });
      expect(daBia.received().some((e) => e.type === "wiki.left")).toBe(false);
      expect(doBruno.received().filter((e) => e.type === "wiki.updated")).toHaveLength(1);
      await Promise.all([daBia.close(), doBruno.close()]);
    },
    LONGO,
  );
});
