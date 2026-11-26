/**
 * Apagar uma Wiki (spec #74, história 25). Só o Admin apaga. A Wiki sai na hora de todos os
 * Canais e Agentes: do catálogo e da Ferramenta nas respostas, do Desfecho, da barra lateral e da
 * lista de Agentes. Quem via a Wiki recebe só `wiki.left`, com o id. Uma Sincronização em curso é
 * cancelada antes. As citações antigas ficam sem link e sem o nome da Wiki.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MessageDto, WikiDto } from "@shearim/contracts";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "3101", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "3102", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const LER = "ler_a_wiki";
const CURSO = { name: "Curso", description: "O curso de redes sociais, aula por aula." };
const GANCHOS = "O gancho vem nos 3 primeiros segundos.";

/** Juliana (Admin) grava a Chave e cria o Social, em #marketing (público, com Bruno). */
async function workspace(t: TestApp) {
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
  const criado = await t.as(juliana).post("/api/channels", { name: "marketing", kind: "public" });
  const marketing: ChannelDto = await criado.json();
  await t.as(juliana).post(`/api/channels/${marketing.id}/agents`, { agentId: social.id });
  await t.as(bruno).post(`/api/channels/${marketing.id}/join`);
  return { social, marketing };
}

async function criarWiki(t: TestApp): Promise<WikiDto> {
  const res = await t.as(juliana).post("/api/wikis", CURSO);
  expect(res.status).toBe(201);
  return res.json();
}

async function subirFonte(t: TestApp, wiki: WikiDto, nome: string) {
  const form = new FormData();
  form.append("files", new File([`# ${nome}\n\nUma aula.\n`], nome));
  const res = await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  expect(res.status).toBe(201);
}

const naAdministracao = async (t: TestApp, wiki: WikiDto) => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id);
};

/** Sobe uma Fonte e sincroniza: a versão 1 tem Ganchos e o índice. */
async function sincronizada(t: TestApp, wiki: WikiDto) {
  await subirFonte(t, wiki, "aula-01.md");
  const escrever = (slug: string, titulo: string, corpo: string) => ({
    name: "escrever_pagina",
    input: { slug, titulo, corpo, fontes: ["aula-01.md"] },
  });
  t.anthropic.sync(
    { toolUse: [escrever("ganchos", "Ganchos", GANCHOS), escrever("index", "Índice", "- [[ganchos]]: Ganchos.")] },
    { text: "Pronto." },
  );
  expect((await t.as(juliana).post(`/api/wikis/${wiki.id}/sync`)).status).toBe(202);
  await eventually("a Sincronização publicar", async () =>
    (await naAdministracao(t, wiki))?.currentVersion ? 1 : undefined,
  );
}

async function enviar(t: TestApp, channelId: string, body: string, who: Person = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto, who: Person = bruno) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(who).get(`/api/conversations/${channelId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    20_000,
  );
}

const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
const textoDe = (system: unknown) =>
  typeof system === "string" ? system : ((system ?? []) as { text: string }[]).map((b) => b.text).join("\n");

const apagar = (t: TestApp, wiki: WikiDto, who: Person = juliana) => t.as(who).delete(`/api/wikis/${wiki.id}`);

describe("o Admin apaga uma Wiki", () => {
  test(
    "ela sai na hora do catálogo, da Ferramenta, do Desfecho, da barra lateral e da lista de Agentes; quem a via recebe wiki.left sem o nome; a citação antiga fica sem link e sem o nome",
    async () => {
      const t = await testApp();
      const { social, marketing } = await workspace(t);
      const curso = await criarWiki(t);
      await sincronizada(t, curso);
      expect((await t.as(juliana).put(`/api/wikis/${curso.id}/channels/${marketing.id}`)).status).toBe(200);
      expect((await t.as(juliana).put(`/api/agents/${social.id}/wikis/${curso.id}`)).status).toBe(200);

      // Antes: o Social lê Ganchos e cita a página.
      t.anthropic.reply(
        { toolUse: [{ id: "toolu_1", name: LER, input: { wiki: "Curso", pagina: "ganchos" } }] },
        { text: "Nos 3 primeiros segundos [[wiki:Curso/ganchos]]." },
      );
      const origem = await enviar(t, marketing.id, "@social como abro um vídeo?");
      const antes = await respostaA(t, marketing.id, origem);
      expect(antes.wikiCitations).toMatchObject([{ state: "linked", wikiId: curso.id, slug: "ganchos" }]);

      const doBruno = await t.socket(bruno);
      const res = await apagar(t, curso);
      expect(res.status).toBe(204);

      // A administração e a barra lateral.
      expect(await naAdministracao(t, curso)).toBeUndefined();
      expect(await (await t.as(bruno).get("/api/wikis")).json()).toEqual([]);
      expect((await t.as(bruno).get(`/api/wikis/${curso.id}/pages/ganchos`)).status).toBe(404);
      // Quem a via recebe só o id, sem o nome.
      const saida = await eventually("o wiki.left chegar ao Bruno", async () =>
        doBruno.received().find((e) => e.type === "wiki.left"),
      );
      expect(saida).toEqual({ type: "wiki.left", wikiId: curso.id });
      expect(JSON.stringify(doBruno.received())).not.toContain("Curso");
      await doBruno.close();
      // A lista de Agentes e a tela do Agente.
      const agentes: AgentDto[] = await (await t.as(bruno).get("/api/agents")).json();
      expect(agentes.find((a) => a.id === social.id)?.wikis).toEqual([]);
      expect(await (await t.as(juliana).get(`/api/agents/${social.id}/wikis`)).json()).toEqual([]);

      // A citação antiga: sem link e sem o nome da Wiki, nem no corpo.
      const depois = await respostaA(t, marketing.id, origem);
      expect(depois.wikiCitations).toEqual([{ marker: "[[wiki:?/ganchos]]", state: "unlinked", slug: "ganchos" }]);
      expect(depois.body).toBe("Nos 3 primeiros segundos [[wiki:?/ganchos]].");

      // A próxima resposta: nem o catálogo nem a Ferramenta.
      const n = respostas(t).length;
      t.anthropic.reply({ text: "Ok." });
      await respostaA(t, marketing.id, await enviar(t, marketing.id, "@social e agora?"));
      const pedido = respostas(t)[n]!;
      expect(textoDe(pedido.body.system)).not.toContain("Curso");
      expect(((pedido.body.tools ?? []) as { name: string }[]).map((f) => f.name)).not.toContain(LER);

      // O Desfecho: a linha do Social não traz mais a Wiki.
      const k = t.anthropic.requests.length;
      t.anthropic.reply({ json: { decisao: "nenhum", agentes: [], motivo: "Ok." } });
      await enviar(t, marketing.id, "Alguém sabe da aula 3?");
      const roteamento = await eventually("o roteamento chegar", async () =>
        t.anthropic.requests.slice(k).find((r) => r.body.output_config),
      );
      const linha = textoDe(roteamento.body.system)
        .split("\n")
        .find((l) => l.startsWith("- @social "));
      expect(linha).toBe("- @social (Social): O Social. · Ferramentas: nenhuma");

      // O nome fica livre para uma Wiki nova.
      expect((await t.as(juliana).post("/api/wikis", CURSO)).status).toBe(201);
    },
    LONGO,
  );

  test(
    "com uma Sincronização em curso, ela é cancelada antes (a chamada em curso é interrompida) e nada mais sai",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      await workspace(t);
      const curso = await criarWiki(t);
      await subirFonte(t, curso, "aula-01.md");
      expect((await t.as(juliana).post(`/api/wikis/${curso.id}/sync`)).status).toBe(202);
      const chamada = await cerebro.nextSync();

      expect((await apagar(t, curso)).status).toBe(204);
      expect(chamada.signal.aborted).toBe(true);
      expect(await naAdministracao(t, curso)).toBeUndefined();
      t.clock.advance(60_000);
      expect(cerebro.syncs).toHaveLength(1);
    },
    LONGO,
  );

  test("um Membro que não é Admin recebe 403, e a Wiki fica", async () => {
    const t = await testApp();
    await workspace(t);
    const curso = await criarWiki(t);
    const res = await apagar(t, curso, bruno);
    expect(res.status).toBe(403);
    expect(await naAdministracao(t, curso)).toBeDefined();
  });

  test("uma Wiki que não existe: 404", async () => {
    const t = await testApp();
    await workspace(t);
    const curso = await criarWiki(t);
    expect((await apagar(t, curso)).status).toBe(204);
    expect((await apagar(t, curso)).status).toBe(404);
    expect((await t.as(juliana).delete("/api/wikis/nao-e-um-id")).status).toBe(404);
  });
});
