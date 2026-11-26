/**
 * Habilidades na lista de Agentes e no Desfecho (spec #74, ticket #77): todo Membro vê o nome e a
 * descrição das Habilidades ativas de cada Agente, e a Articuladora as recebe na linha de cada
 * Agente do roteamento, junto das Ferramentas, para delegar. O corpo não sai em nenhum dos dois, e o
 * roteamento continua sem Ferramentas (ADR 0009).
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MessageDto, SkillDto } from "@shearim/contracts";
import { eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

const CARROSSEL = {
  name: "Criar carrossel",
  description: "Use quando pedirem um carrossel para o Instagram.",
  body: "# Criar carrossel\n\n1. Comece com um gancho.\n2. Uma ideia por slide.",
};
const REELS = {
  name: "Roteiro de Reels",
  description: "Use quando pedirem um vídeo curto.",
  body: "# Reels\n\nTrês segundos de gancho, sempre.",
};

/** Juliana (Admin) grava a Chave e põe o Social e o Lince no #geral; Bruno (Membro) entra nele. */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const social = await novoAgente(t, "Social", "Redes sociais.");
  const lince = await novoAgente(t, "Lince", "Jurídico: contratos.");
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  for (const a of [social, lince]) await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: a.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { social, lince, geral: geral! };
}

async function novoAgente(t: TestApp, name: string, description: string): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function criar(t: TestApp, input: typeof CARROSSEL): Promise<SkillDto> {
  const res = await t.as(juliana).post("/api/skills", input);
  expect(res.status).toBe(201);
  return res.json();
}

async function ativar(t: TestApp, agentId: string, skillId: string) {
  expect((await t.as(juliana).put(`/api/agents/${agentId}/skills/${skillId}`)).status).toBe(200);
}

const agentesVistosPor = async (t: TestApp, who = bruno): Promise<AgentDto[]> =>
  (await t.as(who).get("/api/agents")).json();

describe("a lista de Agentes mostra as Habilidades", () => {
  test("Bruno, que não é Admin, vê o nome e a descrição das Habilidades ativas do Social, sem o corpo; o Lince vem sem nenhuma", async () => {
    const t = await testApp();
    const { social, lince } = await workspace(t);
    const carrossel = await criar(t, CARROSSEL);
    const reels = await criar(t, REELS);
    await ativar(t, social.id, reels.id);
    await ativar(t, social.id, carrossel.id);

    const lista = await agentesVistosPor(t);

    expect(lista.find((a) => a.id === social.id)?.skills).toEqual([
      { name: CARROSSEL.name, description: CARROSSEL.description },
      { name: REELS.name, description: REELS.description },
    ]);
    expect(lista.find((a) => a.id === lince.id)?.skills).toEqual([]);
    expect(JSON.stringify(lista)).not.toContain("Uma ideia por slide");
  });

  test("desativada no Social, a Habilidade sai da lista dele; editada, a lista traz a descrição nova", async () => {
    const t = await testApp();
    const { social } = await workspace(t);
    const carrossel = await criar(t, CARROSSEL);
    const reels = await criar(t, REELS);
    await ativar(t, social.id, carrossel.id);
    await ativar(t, social.id, reels.id);

    expect((await t.as(juliana).delete(`/api/agents/${social.id}/skills/${reels.id}`)).status).toBe(200);
    await t.as(juliana).patch(`/api/skills/${carrossel.id}`, { description: "Use para carrosséis." });

    const doSocial = (await agentesVistosPor(t)).find((a) => a.id === social.id);
    expect(doSocial?.skills).toEqual([{ name: CARROSSEL.name, description: "Use para carrosséis." }]);
  });
});

/** O `system` do pedido de roteamento (o que tem `output_config`) e as linhas de Agente dele. */
async function roteamento(t: TestApp) {
  const pedido = await eventually("o roteamento chegar", async () =>
    t.anthropic.requests.find((r) => r.body.output_config),
  );
  const { system } = pedido.body;
  const texto = typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
  return {
    body: pedido.body,
    system: texto,
    linha: (handle: string) => texto.split("\n").find((l) => l.startsWith(`- @${handle} `)),
  };
}

async function enviar(t: TestApp, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(bruno).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

const nenhum = { json: { decisao: "nenhum", agentes: [], motivo: "Ok." } };
/** Tudo o que chegou ao modelo falso, em texto: para conferir que o corpo de uma Habilidade não foi. */
const tudoQueChegou = (t: TestApp) => JSON.stringify(t.anthropic.requests.map((r) => r.body));

describe("a Articuladora sabe as Habilidades de cada Agente", () => {
  test(
    "o roteamento traz, na linha do Social, o nome e a descrição das Habilidades ativas dele, depois das Ferramentas, sem o corpo e sem Ferramentas no pedido",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${social.id}/tools/listar_agentes`);
      await ativar(t, social.id, (await criar(t, CARROSSEL)).id);
      await ativar(t, social.id, (await criar(t, REELS)).id);
      t.anthropic.reply(nenhum);

      await enviar(t, geral.id, "Alguém monta um carrossel da campanha?");

      const { body, system, linha } = await roteamento(t);
      expect(linha("social")).toBe(
        "- @social (Social): Redes sociais. · Ferramentas: listar Agentes · Habilidades: " +
          "Criar carrossel (Use quando pedirem um carrossel para o Instagram.); " +
          "Roteiro de Reels (Use quando pedirem um vídeo curto.)",
      );
      expect(system).toContain("as Habilidades que tem");
      // O Desfecho não carrega Habilidade: o pedido vai sem Ferramentas e sem o corpo de nenhuma.
      expect(body).not.toHaveProperty("tools");
      expect(tudoQueChegou(t)).not.toContain("Uma ideia por slide");
      expect(tudoQueChegou(t)).not.toContain("Três segundos de gancho");
    },
    LONGO,
  );

  test(
    "o Lince, sem Habilidade ativa, tem a linha de antes; um Agente de fora do Canal vem com as Habilidades dele",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      const prisma = await novoAgente(t, "Prisma", "Dados.");
      const carrossel = await criar(t, CARROSSEL);
      await ativar(t, social.id, carrossel.id);
      await ativar(t, prisma.id, carrossel.id);
      t.anthropic.reply(nenhum);

      await enviar(t, geral.id, "Quem cuida do contrato da Acme?");

      const { linha } = await roteamento(t);
      expect(linha("lince")).toBe("- @lince (Lince): Jurídico: contratos. · Ferramentas: nenhuma");
      expect(linha("prisma")).toBe(
        "- @prisma (Prisma): Dados. · Ferramentas: nenhuma · Habilidades: Criar carrossel (Use quando pedirem um carrossel para o Instagram.)",
      );
    },
    LONGO,
  );

  test(
    "com uma Habilidade ativa na própria Articuladora, o roteamento continua sem Ferramentas e sem o corpo dela",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const sophya = (await agentesVistosPor(t, juliana)).find((a) => a.builtin)!;
      await ativar(t, sophya.id, (await criar(t, CARROSSEL)).id);
      t.anthropic.reply(nenhum);

      await enviar(t, geral.id, "Bom dia, pessoal!");

      const { body } = await roteamento(t);
      expect(body).not.toHaveProperty("tools");
      expect(tudoQueChegou(t)).not.toContain("Uma ideia por slide");
    },
    LONGO,
  );
});
