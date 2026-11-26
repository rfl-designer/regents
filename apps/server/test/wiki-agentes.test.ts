/**
 * A Wiki ligada a Agentes (spec #74, ticket #84; ADR 0014). O Admin liga a Wiki a um Agente, e
 * ela vai com ele a qualquer conversa, a DM inclusive, sempre dentro do alcance dela: a restrita só
 * é lida numa conversa em que o autor e todos os que veem estão na lista. A tela do Agente mostra
 * as Wikis ligadas a ele, ao lado das Ferramentas e das Habilidades.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentDto,
  AgentWikiDto,
  ChannelDto,
  DmDto,
  ExecutionDto,
  MeDto,
  MessageDto,
  WikiDto,
} from "@shearim/contracts";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const ana = { id: "2101", login: "ana@exemplo.com", name: "Ana" }; // Admin (chega primeiro)
const bia = { id: "2102", login: "bia@exemplo.com", name: "Bia" };
const bruno = { id: "2103", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const LER = "ler_a_wiki";
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };
const FINANCEIRO = { name: "Financeiro", description: "O caixa, as metas e os salários." };

interface Workspace {
  ana: MeDto;
  bia: MeDto;
  bruno: MeDto;
  social: AgentDto;
  faro: AgentDto;
  geral: ChannelDto;
}

async function criarAgente(t: TestApp, name: string): Promise<AgentDto> {
  const res = await t.as(ana).post("/api/agents", {
    name,
    photo: null,
    description: `O ${name}.`,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Ana (Admin) grava a Chave e cria o Social e o Faro; Bia e Bruno entram. Os dois estão em #geral. */
async function workspace(t: TestApp): Promise<Workspace> {
  const eu: MeDto = await (await t.as(ana).get("/api/me")).json();
  await t.as(ana).put("/api/workspace-key", { apiKey: CHAVE });
  const social = await criarAgente(t, "Social");
  const faro = await criarAgente(t, "Faro");
  const daBia = await t.addMember(bia, { by: ana });
  const doBruno = await t.addMember(bruno, { by: ana });
  const canais: ChannelDto[] = await (await t.as(ana).get("/api/channels")).json();
  const geral = canais.find((c) => c.name === "geral")!;
  for (const agent of [social, faro]) await t.as(ana).post(`/api/channels/${geral.id}/agents`, { agentId: agent.id });
  return { ana: eu, bia: daBia, bruno: doBruno, social, faro, geral };
}

async function criarWiki(t: TestApp, input: { name: string; description: string }): Promise<WikiDto> {
  const res = await t.as(ana).post("/api/wikis", input);
  expect(res.status).toBe(201);
  return res.json();
}

const wikisDoAgente = (t: TestApp, agent: AgentDto, who: Person = ana) =>
  t.as(who).get(`/api/agents/${agent.id}/wikis`);

const ligar = (t: TestApp, agent: AgentDto, wiki: WikiDto, who: Person = ana) =>
  t.as(who).put(`/api/agents/${agent.id}/wikis/${wiki.id}`);

const desligar = (t: TestApp, agent: AgentDto, wiki: WikiDto, who: Person = ana) =>
  t.as(who).delete(`/api/agents/${agent.id}/wikis/${wiki.id}`);

describe("as Wikis na tela do Agente", () => {
  test(
    "a tela do Agente lista as Wikis do Workspace, por nome, com a marca de ligada; o Admin liga e desliga",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await criarWiki(t, FINANCEIRO);
      const curso = await criarWiki(t, CURSO);
      await t.as(ana).put(`/api/wikis/${financeiro.id}/reach`, { scope: "restricted", memberIds: [ws.bia.id] });

      const antes = await wikisDoAgente(t, ws.social);
      expect(antes.status).toBe(200);
      expect(await antes.json()).toEqual([
        { id: curso.id, name: "Curso", description: CURSO.description, scope: "public", linked: false },
        {
          id: financeiro.id,
          name: "Financeiro",
          description: FINANCEIRO.description,
          scope: "restricted",
          linked: false,
        },
      ] satisfies AgentWikiDto[]);

      const ligada = await ligar(t, ws.social, curso);
      expect(ligada.status).toBe(200);
      expect(((await ligada.json()) as AgentWikiDto[]).map((w) => [w.name, w.linked])).toEqual([
        ["Curso", true],
        ["Financeiro", false],
      ]);
      // Ligar de novo não muda nada; a ligação é do Social, não do Faro.
      expect((await ligar(t, ws.social, curso)).status).toBe(200);
      const doSocial: AgentWikiDto[] = await (await wikisDoAgente(t, ws.social)).json();
      expect(doSocial.filter((w) => w.linked).map((w) => w.name)).toEqual(["Curso"]);
      const doFaro: AgentWikiDto[] = await (await wikisDoAgente(t, ws.faro)).json();
      expect(doFaro.filter((w) => w.linked)).toEqual([]);

      const desligada = await desligar(t, ws.social, curso);
      expect(desligada.status).toBe(200);
      expect(((await desligada.json()) as AgentWikiDto[]).filter((w) => w.linked)).toEqual([]);
    },
    LONGO,
  );

  test(
    "só o Admin vê e muda as ligações (403); um Agente ou uma Wiki que não existe, 404",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const curso = await criarWiki(t, CURSO);

      expect((await wikisDoAgente(t, ws.social, bruno)).status).toBe(403);
      expect((await ligar(t, ws.social, curso, bruno)).status).toBe(403);
      expect((await desligar(t, ws.social, curso, bruno)).status).toBe(403);

      const fantasma = { ...ws.social, id: crypto.randomUUID() };
      expect((await wikisDoAgente(t, fantasma)).status).toBe(404);
      expect((await ligar(t, fantasma, curso)).status).toBe(404);
      expect((await ligar(t, ws.social, { ...curso, id: crypto.randomUUID() })).status).toBe(404);
      expect((await ligar(t, ws.social, { ...curso, id: "nao-e-uuid" })).status).toBe(404);
      const doSocial: AgentWikiDto[] = await (await wikisDoAgente(t, ws.social)).json();
      expect(doSocial.filter((w) => w.linked)).toEqual([]);
    },
    LONGO,
  );

  test(
    "o Agente apagado leva as ligações dele: ligar a ele dá 404",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const curso = await criarWiki(t, CURSO);
      expect((await ligar(t, ws.social, curso)).status).toBe(200);

      expect((await t.as(ana).delete(`/api/agents/${ws.social.id}`)).status).toBeLessThan(300);

      expect((await wikisDoAgente(t, ws.social)).status).toBe(404);
      expect((await ligar(t, ws.social, curso)).status).toBe(404);
    },
    LONGO,
  );
});

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto | undefined> => {
  const lista: WikiDto[] = await (await t.as(ana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id);
};

/** Sobe uma Fonte e sincroniza: a versão publicada tem a página Metas e o índice. */
async function sincronizada(t: TestApp, wiki: WikiDto) {
  const form = new FormData();
  form.append("files", new File(["# Metas\n\nA meta do trimestre é 2 milhões.\n"], "metas.md"));
  expect((await t.as(ana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(201);
  t.anthropic.sync(
    {
      toolUse: [
        {
          name: "escrever_pagina",
          input: { slug: "metas", titulo: "Metas", corpo: "A meta do trimestre é 2 milhões.", fontes: ["metas.md"] },
        },
        {
          name: "escrever_pagina",
          input: { slug: "index", titulo: "Índice", corpo: "- [[metas]]: as metas.", fontes: ["metas.md"] },
        },
      ],
    },
    { text: "Pronto." },
  );
  expect((await t.as(ana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await eventually("a Sincronização publicar", async () => {
    const w = await naAdministracao(t, wiki);
    return w?.currentVersion ? w : undefined;
  });
}

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

/** O pedido que chegou ao modelo para a resposta do Agente a `who` em `conversationId`, e a resposta. */
async function perguntar(t: TestApp, agent: AgentDto, conversationId: string, who: Person) {
  const antes = respostas(t).length;
  const origem = await enviar(t, conversationId, `@${agent.handle} qual é a meta?`, who);
  const resposta = await respostaA(t, conversationId, origem, who);
  return { pedido: respostas(t)[antes]!, resposta };
}

/** O Agente chama ler a Wiki com a entrada e responde "Pronto."; o resultado e o Andamento. */
async function ler(t: TestApp, agent: AgentDto, conversationId: string, who: Person, input: Record<string, unknown>) {
  const aba = await t.socket(who);
  const antes = respostas(t).length;
  t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: LER, input }] }, { text: "Pronto." });
  const origem = await enviar(t, conversationId, `@${agent.handle} qual é a meta?`, who);
  await respostaA(t, conversationId, origem, who);
  const resultado = toolResults(respostas(t)[antes + 1]!.body)[0]!;
  const andamento = await eventually("o Andamento terminar", async () => {
    const vistos: ExecutionDto[] = aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
    return vistos.some((e) => e.state === "done") ? vistos : undefined;
  });
  await aba.close();
  return { resultado, andamento };
}

const dm = async (t: TestApp, who: Person, body: { memberIds: string[]; agentId?: string }): Promise<DmDto> => {
  const res = await t.as(who).post("/api/dms", body);
  expect(res.status).toBeLessThan(300);
  return res.json();
};

/** O Curso (público) ligado ao Social; o Financeiro (só Ana e Bia) ligado ao Faro. Nenhum Canal ligado. */
async function ligadas(t: TestApp) {
  const ws = await workspace(t);
  const curso = await criarWiki(t, CURSO);
  const financeiro = await criarWiki(t, FINANCEIRO);
  const restrita = { scope: "restricted", memberIds: [ws.ana.id, ws.bia.id] };
  expect((await t.as(ana).put(`/api/wikis/${financeiro.id}/reach`, restrita)).status).toBe(200);
  await sincronizada(t, curso);
  await sincronizada(t, financeiro);
  expect((await ligar(t, ws.social, curso)).status).toBe(200);
  expect((await ligar(t, ws.faro, financeiro)).status).toBe(200);
  return { ...ws, curso, financeiro };
}

describe("a Wiki vai com o Agente ligado", () => {
  test(
    "numa DM de Ana com o Social, ele recebe o Curso no catálogo e o lê",
    async () => {
      const t = await testApp();
      const { social } = await ligadas(t);
      const comSocial = await dm(t, ana, { memberIds: [], agentId: social.id });

      const { pedido } = await perguntar(t, social, comSocial.id, ana);
      expect(systemDe(pedido)).toContain("- Curso: O curso de redes sociais, aula por aula.");
      expect(systemDe(pedido)).not.toContain("Financeiro");
      expect(ferramentasDe(pedido)).toContain(LER);

      const { resultado } = await ler(t, social, comSocial.id, ana, { wiki: "Curso", pagina: "metas" });
      expect(resultado.is_error ?? false).toBe(false);
      expect(resultado.content).toContain("A meta do trimestre é 2 milhões.");
    },
    LONGO,
  );

  test(
    "em #geral, sem Wiki ligada ao Canal, o Social também lê o Curso; o Faro, ali, não",
    async () => {
      const t = await testApp();
      const { social, faro, geral } = await ligadas(t);

      const doSocial = await perguntar(t, social, geral.id, bruno);
      expect(systemDe(doSocial.pedido)).toContain("- Curso:");
      expect(ferramentasDe(doSocial.pedido)).toContain(LER);
      const { resultado } = await ler(t, social, geral.id, bruno, { wiki: "Curso" });
      expect(resultado.is_error ?? false).toBe(false);
      expect(resultado.content).toContain("[[metas]]");

      const doFaro = await perguntar(t, faro, geral.id, bruno);
      expect(systemDe(doFaro.pedido)).not.toContain("Curso");
    },
    LONGO,
  );

  test(
    "o Faro lê o Financeiro numa DM só de Ana com ele; numa DM em grupo de Ana e Bruno, não o lê nem o nomeia",
    async () => {
      const t = await testApp();
      const { faro, bruno: doBruno } = await ligadas(t);
      const daAna = await dm(t, ana, { memberIds: [], agentId: faro.id });

      const sozinha = await perguntar(t, faro, daAna.id, ana);
      expect(systemDe(sozinha.pedido)).toContain("- Financeiro: O caixa, as metas e os salários.");
      const lida = await ler(t, faro, daAna.id, ana, { wiki: "Financeiro", pagina: "metas" });
      expect(lida.resultado.is_error ?? false).toBe(false);
      expect(lida.resultado.content).toContain("A meta do trimestre é 2 milhões.");

      const emGrupo = await dm(t, ana, { memberIds: [doBruno.id] });
      const doGrupo = await perguntar(t, faro, emGrupo.id, ana);
      expect(systemDe(doGrupo.pedido)).not.toContain("Financeiro");
      expect(ferramentasDe(doGrupo.pedido)).not.toContain(LER);
      // Mesmo pedida pelo nome, a Wiki não é lida, e a falha não confirma que ela existe.
      const { resultado, andamento } = await ler(t, faro, emGrupo.id, ana, { wiki: "Financeiro" });
      expect(resultado.is_error).toBe(true);
      expect(JSON.stringify(resultado)).not.toContain("Financeiro");
      expect(JSON.stringify(andamento)).not.toContain("Financeiro");
    },
    LONGO,
  );

  test(
    "o Faro responde em #geral sem o Financeiro, e a resposta não falha",
    async () => {
      const t = await testApp();
      const { faro, geral } = await ligadas(t);
      t.anthropic.reply({ text: "A meta está com a diretoria." });

      const { pedido, resposta } = await perguntar(t, faro, geral.id, ana);

      expect(systemDe(pedido)).not.toContain("Financeiro");
      expect(ferramentasDe(pedido)).not.toContain(LER);
      expect(resposta.body).toBe("A meta está com a diretoria.");
    },
    LONGO,
  );

  test(
    "o Admin desliga o Curso do Social, e ele sai do catálogo na resposta seguinte",
    async () => {
      const t = await testApp();
      const { social, curso } = await ligadas(t);
      const comSocial = await dm(t, ana, { memberIds: [], agentId: social.id });
      expect(systemDe((await perguntar(t, social, comSocial.id, ana)).pedido)).toContain("- Curso:");

      expect((await desligar(t, social, curso)).status).toBe(200);

      const { pedido } = await perguntar(t, social, comSocial.id, ana);
      expect(systemDe(pedido)).not.toContain("Curso");
      expect(ferramentasDe(pedido)).not.toContain(LER);
    },
    LONGO,
  );
});
