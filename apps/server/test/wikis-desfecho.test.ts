/**
 * Wikis na lista de Agentes e no Desfecho (spec #74, ticket #90; ADR 0009, ADR 0014). Cada Membro
 * vê, na lista de Agentes, as Wikis ligadas a cada Agente que ele mesmo lê. A Articuladora recebe,
 * na linha de cada Agente do roteamento, o nome e a descrição das Wikis que alcançam a conversa
 * (ligadas ao Agente ou ao Canal), junto das Ferramentas e das Habilidades, e nunca uma restrita
 * fora do alcance da conversa. O Desfecho não lê páginas da Wiki: o pedido vai sem Ferramentas.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MeDto, MessageDto, WikiDto } from "@regents/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const ana = { id: "2201", login: "ana@exemplo.com", name: "Ana" }; // Admin (chega primeiro)
const bia = { id: "2202", login: "bia@exemplo.com", name: "Bia" };
const bruno = { id: "2203", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };
const FINANCEIRO = { name: "Financeiro", description: "O caixa, as metas e os salários." };
const MANUAL = { name: "Manual", description: "O manual do time." };
/** O corpo da página que a Sincronização escreve: não pode chegar ao roteamento. */
const PAGINA = "A meta do trimestre é 2 milhões.";

interface Workspace {
  ana: MeDto;
  bia: MeDto;
  bruno: MeDto;
  social: AgentDto;
  faro: AgentDto;
  geral: ChannelDto;
  diretoria: ChannelDto;
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

/**
 * Ana (Admin) grava a Chave e cria o Social e o Faro; Bia e Bruno entram. Os dois Agentes estão em
 * #geral (público, Bia e Bruno nele) e em #diretoria (privado: só Ana e Bia).
 */
async function workspace(t: TestApp): Promise<Workspace> {
  const eu: MeDto = await (await t.as(ana).get("/api/me")).json();
  await t.as(ana).put("/api/workspace-key", { apiKey: CHAVE });
  const social = await criarAgente(t, "Social");
  const faro = await criarAgente(t, "Faro");
  const daBia = await t.addMember(bia, { by: ana });
  const doBruno = await t.addMember(bruno, { by: ana });
  const canais: ChannelDto[] = await (await t.as(ana).get("/api/channels")).json();
  const geral = canais.find((c) => c.name === "geral")!;
  for (const who of [bia, bruno]) await t.as(who).post(`/api/channels/${geral.id}/join`);
  const res = await t.as(ana).post("/api/channels", { name: "diretoria", kind: "private" });
  expect(res.status).toBe(201);
  const diretoria: ChannelDto = await res.json();
  expect((await t.as(ana).post(`/api/channels/${diretoria.id}/participants`, { memberId: daBia.id })).status).toBe(200);
  for (const channel of [geral, diretoria]) {
    for (const agent of [social, faro]) {
      await t.as(ana).post(`/api/channels/${channel.id}/agents`, { agentId: agent.id });
    }
  }
  return { ana: eu, bia: daBia, bruno: doBruno, social, faro, geral, diretoria };
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
async function sincronizada(t: TestApp, wiki: WikiDto) {
  const form = new FormData();
  form.append("files", new File([`# Metas\n\n${PAGINA}\n`], "metas.md"));
  expect((await t.as(ana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(201);
  t.anthropic.sync(
    {
      toolUse: [
        {
          name: "escrever_pagina",
          input: { slug: "metas", titulo: "Metas", corpo: PAGINA, fontes: ["metas.md"] },
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

/** Uma Wiki criada e sincronizada, restrita à lista `memberIds` quando ela vem. */
async function wiki(t: TestApp, input: { name: string; description: string }, memberIds?: string[]) {
  const created = await criarWiki(t, input);
  if (memberIds) {
    const res = await t.as(ana).put(`/api/wikis/${created.id}/reach`, { scope: "restricted", memberIds });
    expect(res.status).toBe(200);
  }
  await sincronizada(t, created);
  return created;
}

async function ligar(t: TestApp, agent: AgentDto, w: WikiDto) {
  expect((await t.as(ana).put(`/api/agents/${agent.id}/wikis/${w.id}`)).status).toBe(200);
}

const wikisVistasPor = async (t: TestApp, who: Person, agent: AgentDto) => {
  const lista: AgentDto[] = await (await t.as(who).get("/api/agents")).json();
  return lista.find((a) => a.id === agent.id)?.wikis;
};

describe("a lista de Agentes mostra as Wikis de cada um", () => {
  test(
    "cada Membro vê só as Wikis ligadas ao Agente que ele lê: a restrita, só quem está na lista (o Admin não lê por ser Admin)",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const curso = await wiki(t, CURSO);
      const financeiro = await wiki(t, FINANCEIRO, [ws.bia.id]);
      await ligar(t, ws.social, financeiro);
      await ligar(t, ws.social, curso);

      const doCurso = { id: curso.id, name: CURSO.name, description: CURSO.description };
      const doFinanceiro = { id: financeiro.id, name: FINANCEIRO.name, description: FINANCEIRO.description };
      expect(await wikisVistasPor(t, bia, ws.social)).toEqual([doCurso, doFinanceiro]);
      expect(await wikisVistasPor(t, bruno, ws.social)).toEqual([doCurso]);
      expect(await wikisVistasPor(t, ana, ws.social)).toEqual([doCurso]);
      expect(await wikisVistasPor(t, bia, ws.faro)).toEqual([]);
      // O nome da restrita não chega a quem está fora dela, nem em outro campo.
      expect(JSON.stringify(await (await t.as(bruno).get("/api/agents")).json())).not.toContain("Financeiro");
      // Nenhuma página vem na lista.
      expect(JSON.stringify(await (await t.as(bia).get("/api/agents")).json())).not.toContain(PAGINA);
    },
    LONGO,
  );

  test(
    "uma Wiki ainda sem versão publicada, ou desligada do Agente, não aparece na lista",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const manual = await criarWiki(t, MANUAL);
      const curso = await wiki(t, CURSO);
      await ligar(t, ws.social, manual);
      await ligar(t, ws.social, curso);
      expect((await wikisVistasPor(t, bruno, ws.social))?.map((w) => w.name)).toEqual(["Curso"]);

      expect((await t.as(ana).delete(`/api/agents/${ws.social.id}/wikis/${curso.id}`)).status).toBe(200);
      expect(await wikisVistasPor(t, bruno, ws.social)).toEqual([]);
    },
    LONGO,
  );
});

/** O `system` do último pedido de roteamento (o que tem `output_config`) e as linhas de Agente dele. */
async function roteamento(t: TestApp, depoisDe = 0) {
  const pedido = await eventually("o roteamento chegar", async () =>
    t.anthropic.requests.slice(depoisDe).find((r) => r.body.output_config),
  );
  const { system } = pedido.body;
  const texto = typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
  return {
    body: pedido.body,
    system: texto,
    linha: (handle: string) => texto.split("\n").find((l) => l.startsWith(`- @${handle} `)),
  };
}

async function enviar(t: TestApp, channelId: string, body: string, who: Person): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

const nenhum = { json: { decisao: "nenhum", agentes: [], motivo: "Ok." } };
const doCurso = `Curso (${CURSO.description})`;
const doFinanceiro = `Financeiro (${FINANCEIRO.description})`;

describe("a Articuladora sabe as Wikis que alcançam a conversa", () => {
  test(
    "a linha de cada Agente traz as Wikis ligadas a ele ou ao Canal, depois das Ferramentas e das Habilidades; o pedido vai sem Ferramentas e sem página",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const curso = await wiki(t, CURSO);
      const manual = await wiki(t, MANUAL);
      await ligar(t, ws.social, curso);
      expect((await t.as(ana).put(`/api/wikis/${manual.id}/channels/${ws.geral.id}`)).status).toBe(200);
      const skill = await (
        await t.as(ana).post("/api/skills", { name: "Carrossel", description: "Para carrosséis.", body: "Um slide." })
      ).json();
      await t.as(ana).put(`/api/agents/${ws.social.id}/skills/${skill.id}`);
      t.anthropic.reply(nenhum);

      await enviar(t, ws.geral.id, "Alguém sabe da aula 3 do curso?", bruno);

      const { body, system, linha } = await roteamento(t);
      expect(linha("social")).toBe(
        `- @social (Social): O Social. · Ferramentas: nenhuma · Habilidades: Carrossel (Para carrosséis.) · Wikis: ${doCurso}; Manual (${MANUAL.description})`,
      );
      expect(linha("faro")).toBe(
        `- @faro (Faro): O Faro. · Ferramentas: nenhuma · Wikis: Manual (${MANUAL.description})`,
      );
      expect(system).toContain("as Wikis que alcançam esta conversa");
      // O Desfecho não lê a Wiki: sem Ferramentas no pedido, e nenhuma página chega a ele.
      expect(body).not.toHaveProperty("tools");
      const roteamentos = t.anthropic.requests.filter((r) => r.body.output_config);
      expect(JSON.stringify(roteamentos.map((r) => r.body))).not.toContain(PAGINA);
    },
    LONGO,
  );

  test(
    "num Canal público, a Wiki restrita ligada ao Agente não aparece no roteamento, nem o nome dela",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await wiki(t, FINANCEIRO, [ws.ana.id, ws.bia.id]);
      await ligar(t, ws.social, financeiro);
      t.anthropic.reply(nenhum);

      await enviar(t, ws.geral.id, "Qual é a meta do trimestre?", bia);

      const { system, linha } = await roteamento(t);
      expect(linha("social")).toBe("- @social (Social): O Social. · Ferramentas: nenhuma");
      expect(system).not.toContain("Financeiro");
    },
    LONGO,
  );

  test(
    "num Canal privado em que todos estão na lista, a restrita aparece; com alguém fora da lista, some",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const financeiro = await wiki(t, FINANCEIRO, [ws.ana.id, ws.bia.id]);
      await ligar(t, ws.social, financeiro);
      t.anthropic.reply(nenhum);

      await enviar(t, ws.diretoria.id, "Qual é a meta do trimestre?", bia);

      expect((await roteamento(t)).linha("social")).toBe(
        `- @social (Social): O Social. · Ferramentas: nenhuma · Wikis: ${doFinanceiro}`,
      );

      const antes = t.anthropic.requests.length;
      const entrou = await t.as(ana).post(`/api/channels/${ws.diretoria.id}/participants`, { memberId: ws.bruno.id });
      expect(entrou.status).toBe(200);
      t.anthropic.reply(nenhum);
      await enviar(t, ws.diretoria.id, "E a do ano?", bia);

      const depois = await roteamento(t, antes);
      expect(depois.linha("social")).toBe("- @social (Social): O Social. · Ferramentas: nenhuma");
      expect(depois.system).not.toContain("Financeiro");
    },
    LONGO,
  );

  test(
    "um Agente de fora do Canal vem com as Wikis dele que alcançam a conversa",
    async () => {
      const t = await testApp();
      const ws = await workspace(t);
      const prisma = await criarAgente(t, "Prisma");
      const curso = await wiki(t, CURSO);
      await ligar(t, prisma, curso);
      t.anthropic.reply(nenhum);

      await enviar(t, ws.geral.id, "Quem conhece o curso?", bruno);

      expect((await roteamento(t)).linha("prisma")).toBe(
        `- @prisma (Prisma): O Prisma. · Ferramentas: nenhuma · Wikis: ${doCurso}`,
      );
    },
    LONGO,
  );
});
