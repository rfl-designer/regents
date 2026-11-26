/**
 * Ler uma Wiki pública ligada a um Canal (spec #74, ticket #81): o Admin liga a Wiki a Canais, e
 * todo Agente que responde ali (a Articuladora inclusive) recebe no contexto o catálogo das Wikis
 * (o nome e a descrição) e lê o índice e as páginas pela Ferramenta automática "ler a Wiki", à
 * vista no Andamento. Pela Chave e pela Conta.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto, WikiChannelDto, WikiDto } from "@regents/contracts";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const LER = "ler_a_wiki";
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };

/**
 * Juliana (Admin) grava a Chave, cria o Social e os Canais públicos #marketing e #dev, com o Social
 * nos dois; Bruno (Membro) entra nos dois.
 */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const social = await novoAgente(t, "Social");
  await t.addMember(bruno, { by: juliana });
  const canal = async (name: string): Promise<ChannelDto> => {
    const res = await t.as(juliana).post("/api/channels", { name, kind: "public" });
    expect(res.status).toBe(201);
    const channel: ChannelDto = await res.json();
    await t.as(juliana).post(`/api/channels/${channel.id}/agents`, { agentId: social.id });
    await t.as(bruno).post(`/api/channels/${channel.id}/join`);
    return channel;
  };
  return { social, marketing: await canal("marketing"), dev: await canal("dev") };
}

async function novoAgente(t: TestApp, name: string): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description: `O ${name}.`,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function criarWiki(t: TestApp, input = CURSO): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", input);
  expect(res.status).toBe(201);
  return res.json();
}

/** Sobe uma aula e sincroniza: a versão publicada tem a página Ganchos e o índice. */
async function sincronizada(t: TestApp, wiki: WikiDto) {
  const form = new FormData();
  form.append("files", new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md"));
  expect((await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(
    201,
  );
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
  );
  expect((await t.as(juliana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await eventually("a Sincronização publicar", async () => {
    const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
    return lista.find((w) => w.id === wiki.id)?.currentVersion ?? undefined;
  });
}

const ligar = (t: TestApp, wiki: WikiDto, channel: ChannelDto) =>
  t.as(juliana).put(`/api/wikis/${wiki.id}/channels/${channel.id}`);
const desligar = (t: TestApp, wiki: WikiDto, channel: ChannelDto) =>
  t.as(juliana).delete(`/api/wikis/${wiki.id}/channels/${channel.id}`);

/** A Wiki Curso, sincronizada e ligada a #marketing. */
async function cursoNoMarketing(t: TestApp) {
  const ws = await workspace(t);
  const wiki = await criarWiki(t);
  await sincronizada(t, wiki);
  expect((await ligar(t, wiki, ws.marketing)).status).toBe(200);
  return { ...ws, wiki };
}

async function enviar(t: TestApp, conversationId: string, body: string, who: Person = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, conversationId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (
        await t.as(juliana).get(`/api/conversations/${conversationId}/messages`)
      ).json();
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

/** A resposta do Social a uma pergunta em `conversationId`, e o pedido que chegou ao modelo. */
async function perguntar(t: TestApp, conversationId: string, body = "@social como abro um vídeo?") {
  const antes = respostas(t).length;
  await respostaA(t, conversationId, await enviar(t, conversationId, body));
  return respostas(t)[antes]!;
}

describe("o catálogo das Wikis no contexto", () => {
  test(
    "o Admin liga a Wiki Curso a #marketing: a próxima resposta ali recebe o nome e a descrição dela, depois das Habilidades, com as regras",
    async () => {
      const t = await testApp();
      const { social, marketing } = await cursoNoMarketing(t);
      const skill = await t.as(juliana).post("/api/skills", {
        name: "Criar carrossel",
        description: "Use quando pedirem um carrossel.",
        body: "1. Um gancho.",
      });
      await t.as(juliana).put(`/api/agents/${social.id}/skills/${(await skill.json()).id}`);

      const pedido = await perguntar(t, marketing.id);

      const system = systemDe(pedido);
      expect(system).toContain("## Wikis\n\n");
      expect(system).toContain("- Curso: O curso de redes sociais, aula por aula.");
      const posicoes = ["## Suas Habilidades", "## Wikis", "## Quem é quem"].map((s) => system.indexOf(s));
      expect(posicoes.every((p) => p >= 0)).toBe(true);
      expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
      expect(system).toContain("cite a página com [[wiki:<nome da Wiki>/<slug>]]");
      expect(system).toContain("Quando a Wiki não tiver a resposta, diga isso");
      expect(system).toContain(
        "Quando a Wiki e a Memória se contradisserem, diga que há uma contradição e cite as duas.",
      );
      expect(system).not.toContain("O gancho vem nos 3 primeiros segundos.");
      expect(ferramentasDe(pedido)).toContain(LER);
    },
    LONGO,
  );

  test(
    "a Articuladora, chamada por Menção em #marketing, também recebe o catálogo e ler a Wiki",
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);

      const pedido = await perguntar(t, marketing.id, "@sophya como abro um vídeo?");

      expect(systemDe(pedido)).toContain("- Curso: O curso de redes sociais, aula por aula.");
      expect(ferramentasDe(pedido)).toContain(LER);
    },
    LONGO,
  );

  test(
    "uma Wiki que nunca foi sincronizada não entra no catálogo; sem nenhuma Wiki que alcance a resposta, ler a Wiki não é oferecida",
    async () => {
      const t = await testApp();
      const { marketing } = await workspace(t);
      const rascunho = await criarWiki(t, { name: "Rascunho", description: "Ainda sem páginas." });
      expect((await ligar(t, rascunho, marketing)).status).toBe(200);

      const pedido = await perguntar(t, marketing.id);

      expect(systemDe(pedido)).not.toContain("## Wikis");
      expect(systemDe(pedido)).not.toContain("Rascunho");
      expect(ferramentasDe(pedido)).not.toContain(LER);
    },
    LONGO,
  );

  test(
    "em #dev, sem ligação, a Wiki Curso não entra",
    async () => {
      const t = await testApp();
      const { dev } = await cursoNoMarketing(t);

      const pedido = await perguntar(t, dev.id);

      expect(systemDe(pedido)).not.toContain("Curso");
      expect(ferramentasDe(pedido)).not.toContain(LER);
    },
    LONGO,
  );

  test(
    "o Admin desliga a Wiki de #marketing, e ela sai do catálogo na resposta seguinte",
    async () => {
      const t = await testApp();
      const { marketing, wiki } = await cursoNoMarketing(t);
      expect(systemDe(await perguntar(t, marketing.id))).toContain("- Curso:");

      expect((await desligar(t, wiki, marketing)).status).toBe(200);
      const depois = await perguntar(t, marketing.id);

      expect(systemDe(depois)).not.toContain("Curso");
      expect(ferramentasDe(depois)).not.toContain(LER);
    },
    LONGO,
  );
});

describe("a precedência", () => {
  test(
    "a nota diz: Contexto do Workspace > Instruções do Canal > instruções do Agente e Habilidades > Wiki e Memória, mesmo sem Memória",
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);

      const system = systemDe(await perguntar(t, marketing.id));

      expect(system).not.toContain("## Memória");
      expect(system).toContain(
        "O Contexto do Workspace vale acima das Instruções do Canal, que valem acima das suas instruções e das suas Habilidades, que valem acima da Wiki e da Memória: quando se contradizem, siga o que vale mais. Entre a Wiki e a Memória não há ordem.",
      );
    },
    LONGO,
  );
});

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

/** O Social chama ler a Wiki com cada entrada, um turno por chamada, e responde "Pronto.". */
async function ler(t: TestApp, conversationId: string, entradas: Record<string, unknown>[]) {
  const aba = await t.socket(bruno);
  const antes = respostas(t).length;
  t.anthropic.reply(...entradas.map((input, i) => ({ toolUse: [{ id: `toolu_${i + 1}`, name: LER, input }] })), {
    text: "Pronto.",
  });
  const origem = await enviar(t, conversationId, "@social como abro um vídeo?");
  const resposta = await respostaA(t, conversationId, origem);
  const resultados = entradas.map((_, i) => toolResults(respostas(t)[antes + i + 1]!.body)[0]!);
  const andamento = await terminou(aba, origem);
  await aba.close();
  const passos = andamento.at(-1)!.tools.filter((f) => f.tool === LER);
  return { resposta, resultados, passos };
}

describe("ler a Wiki", () => {
  test(
    'pela Chave, sem página vem o índice e com a página vem a página, com a versão lida; o Andamento mostra "lendo o índice da Wiki Curso" e "lendo Ganchos da Wiki Curso"',
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);

      const { resposta, resultados, passos } = await ler(t, marketing.id, [
        { wiki: "curso" },
        { wiki: "Curso", pagina: "ganchos" },
      ]);

      expect(resultados.map((r) => r.is_error ?? false)).toEqual([false, false]);
      expect(resultados[0]!.content).toContain("Wiki Curso, versão 1: o índice.");
      expect(resultados[0]!.content).toContain("- [[ganchos]]: o começo do vídeo.");
      expect(resultados[1]!.content).toContain("Wiki Curso, versão 1: a página Ganchos ([[ganchos]]).");
      expect(resultados[1]!.content).toContain("O gancho vem nos 3 primeiros segundos.");
      expect(passos).toMatchObject([
        { label: "lendo o índice da Wiki Curso", state: "done" },
        { label: "lendo Ganchos da Wiki Curso", state: "done" },
      ]);
      expect(resposta.body).toBe("Pronto.");
    },
    LONGO,
  );

  test(
    "uma página que não existe vira falha com motivo no Andamento, e a resposta segue",
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);

      const { resposta, resultados, passos } = await ler(t, marketing.id, [{ wiki: "Curso", pagina: "reels" }]);

      expect(resultados[0]!.is_error).toBe(true);
      expect(resultados[0]!.content).toContain("essa página não existe na Wiki Curso");
      expect(passos).toMatchObject([
        { label: "lendo reels da Wiki Curso", state: "failed", reason: "essa página não existe na Wiki Curso" },
      ]);
      expect(resposta.body).toBe("Pronto.");
    },
    LONGO,
  );

  test(
    "a Wiki Produto, ligada só a #dev, não é lida em #marketing, nem nomeada no resultado e no Andamento",
    async () => {
      const t = await testApp();
      const { marketing, dev } = await cursoNoMarketing(t);
      const produto = await criarWiki(t, { name: "Produto", description: "O roadmap do produto." });
      await sincronizada(t, produto);
      await ligar(t, produto, dev);

      const { resultados, passos } = await ler(t, marketing.id, [{ wiki: "Produto" }, { wiki: "Nenhuma" }]);

      expect(resultados.map((r) => r.content)).toEqual([
        "A Ferramenta ler a Wiki falhou: não há uma Wiki com esse nome nesta conversa.",
        "A Ferramenta ler a Wiki falhou: não há uma Wiki com esse nome nesta conversa.",
      ]);
      expect(passos).toMatchObject([
        { label: "lendo a Wiki", state: "failed", reason: "não há uma Wiki com esse nome nesta conversa" },
        { label: "lendo a Wiki", state: "failed", reason: "não há uma Wiki com esse nome nesta conversa" },
      ]);
    },
    LONGO,
  );

  test(
    "ler a Wiki conta no teto de turnos de Ferramenta: no limite, a última chamada vai sem Ferramentas",
    async () => {
      const t = await testApp({ tools: { maxTurns: 2 } });
      const { marketing } = await cursoNoMarketing(t);
      const aba = await t.socket(bruno);
      const leDeNovo = (id: string) => ({ toolUse: [{ id, name: LER, input: { wiki: "Curso" } }] });

      t.anthropic.reply(leDeNovo("toolu_1"), leDeNovo("toolu_2"), { text: "Com o que tenho." });
      const origem = await enviar(t, marketing.id, "@social como abro um vídeo?");

      expect((await respostaA(t, marketing.id, origem)).body).toBe("Com o que tenho.");
      expect((await terminou(aba, origem)).at(-1)!.toolLimit).toBe(true);
      const ultimo = respostas(t).at(-1)!;
      expect(!ultimo.body.tools || (ultimo.body.tool_choice as { type?: string })?.type === "none").toBe(true);
      await aba.close();
    },
    LONGO,
  );

  test(
    "o que a resposta gasta lendo a Wiki conta no orçamento do Agente",
    async () => {
      const t = await testApp();
      const { social, marketing } = await cursoNoMarketing(t);
      await t.as(juliana).patch(`/api/agents/${social.id}`, { monthlyBudgetUsd: 10 });
      const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };

      t.anthropic.reply(
        { toolUse: [{ id: "toolu_1", name: LER, input: { wiki: "Curso" } }], usage: DOIS_DOLARES },
        { text: "Pronto.", usage: DOIS_DOLARES },
      );
      await respostaA(t, marketing.id, await enviar(t, marketing.id, "@social como abro um vídeo?"));

      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      expect(agentes.find((a) => a.id === social.id)).toMatchObject({ keySpendUsd: 4 });
    },
    LONGO,
  );

  test(
    "pela Conta, o claude -p lista e chama ler a Wiki no endpoint MCP do Shearim e recebe a página",
    async () => {
      const t = await testApp();
      const { marketing } = await cursoNoMarketing(t);
      await t.linkAccount(bruno);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ tool: { name: LER, input: { wiki: "Curso", pagina: "ganchos" } } }, { text: "{resultado}" }],
        },
      });
      const aba = await t.socket(bruno);

      const origem = await enviar(t, marketing.id, "@social como abro um vídeo?");
      const resposta = await respostaA(t, marketing.id, origem);

      const [listou, chamou] = t.claude.mcp();
      expect((listou as { listed: string[] }).listed).toContain(LER);
      expect(chamou).toMatchObject({ called: LER, result: { isError: false } });
      expect(resposta.body).toContain("Wiki Curso, versão 1");
      expect(resposta.body).toContain("O gancho vem nos 3 primeiros segundos.");
      const fim = (await terminou(aba, origem)).at(-1)!;
      expect(fim.tools.filter((f) => f.tool === LER)).toMatchObject([
        { label: "lendo Ganchos da Wiki Curso", state: "done" },
      ]);
      await aba.close();
    },
    LONGO,
  );
});

describe("as ligações da Wiki a Canais, na administração", () => {
  test(
    "o Admin vê os Canais que ele vê, com a marca de ligado; um Canal privado sem ele não aparece e não se liga",
    async () => {
      const t = await testApp();
      const { marketing, dev } = await workspace(t);
      const wiki = await criarWiki(t);
      const diretoria: ChannelDto = await (
        await t.as(bruno).post("/api/channels", { name: "diretoria", kind: "private" })
      ).json();

      const ligada = await ligar(t, wiki, marketing);
      expect(ligada.status).toBe(200);
      const esperado: WikiChannelDto[] = [
        { id: dev.id, name: "dev", kind: "public", linked: false },
        { id: (await geralDe(t)).id, name: "geral", kind: "public", linked: false },
        { id: marketing.id, name: "marketing", kind: "public", linked: true },
      ];
      expect(await ligada.json()).toEqual(esperado);
      expect(await (await t.as(juliana).get(`/api/wikis/${wiki.id}/channels`)).json()).toEqual(esperado);

      expect((await ligar(t, wiki, diretoria)).status).toBe(404);
      expect((await t.as(juliana).put(`/api/wikis/${wiki.id}/channels/nao-e-um-id`)).status).toBe(404);
    },
    LONGO,
  );

  test("um Membro que não é Admin recebe 403 ao ver, ligar ou desligar", async () => {
    const t = await testApp();
    const { marketing } = await workspace(t);
    const wiki = await criarWiki(t);

    expect((await t.as(bruno).get(`/api/wikis/${wiki.id}/channels`)).status).toBe(403);
    expect((await t.as(bruno).put(`/api/wikis/${wiki.id}/channels/${marketing.id}`)).status).toBe(403);
    expect((await t.as(bruno).delete(`/api/wikis/${wiki.id}/channels/${marketing.id}`)).status).toBe(403);
  });
});

async function geralDe(t: TestApp): Promise<ChannelDto> {
  const lista: ChannelDto[] = await (await t.as(juliana).get("/api/channels")).json();
  return lista.find((c) => c.name === "geral")!;
}
