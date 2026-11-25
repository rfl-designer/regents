import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MeDto, WorkspaceKeyDto } from "@shearim/contracts";
import { schema } from "../src/db/client";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };

/** Bruno entra pelo Pedido de entrada; Juliana abre o Workspace (vira Admin) e aprova. */
function membro(t: TestApp, who: Person): Promise<MeDto> {
  return t.addMember(who, { by: juliana });
}

const faro = {
  name: "Faro",
  photo: "data:image/png;base64,iVBORw0KGgo=",
  description: "Comercial: preços, propostas e prazos.",
  instructions: "Você é o Faro. Responda curto e com números.",
  model: "claude-sonnet-5-5",
};

async function criarAgente(t: TestApp, input: Partial<typeof faro> = {}): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", { ...faro, ...input });
  expect(res.status).toBe(201);
  return res.json();
}

/** Os Agentes criados no teste: a Articuladora, que vem com todo Workspace, fica de fora. */
async function semArticuladora(t: TestApp, who: Person): Promise<AgentDto[]> {
  const all: AgentDto[] = await (await t.as(who).get("/api/agents")).json();
  return all.filter((a) => !a.builtin);
}

describe("Chave do Workspace", () => {
  test("o Admin grava a Chave, e ela nunca volta ao navegador", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const antes: WorkspaceKeyDto = await (await t.as(juliana).get("/api/workspace-key")).json();
    const res = await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-segredo-do-workspace" });
    const depois = await t.as(juliana).get("/api/workspace-key");

    expect(antes).toEqual({ configured: false, updatedAt: null, incident: null });
    expect(res.status).toBe(200);
    const gravada: WorkspaceKeyDto = await res.json();
    expect(gravada).toEqual({ configured: true, updatedAt: "2026-11-24T12:00:00.000Z", incident: null });
    expect(await depois.text()).not.toContain("segredo");
  });

  test("a Chave fica cifrada com a chave mestra, nunca em texto puro no banco", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-segredo-do-workspace" });

    // Propriedade que não se vê pela borda: o que fica guardado não contém a Chave.
    const rows = await t.db.select().from(schema.workspaceSettings);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("segredo");
  });

  test("só o Admin vê ou grava a Chave", async () => {
    const t = await testApp();
    await membro(t, bruno);

    const ver = await t.as(bruno).get("/api/workspace-key");
    const gravar = await t.as(bruno).put("/api/workspace-key", { apiKey: "sk-ant-do-bruno" });

    expect(ver.status).toBe(403);
    expect(gravar.status).toBe(403);
    expect(await gravar.json()).toEqual({ error: "not_admin" });
    expect(await (await t.as(juliana).get("/api/workspace-key")).json()).toMatchObject({ configured: false });
  });

  test("uma Chave vazia é recusada", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const res = await t.as(juliana).put("/api/workspace-key", { apiKey: "   " });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });
});

describe("Agentes", () => {
  test("o Admin cria um Agente com nome, foto, descrição pública, instruções e modelo", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const res = await t.as(juliana).post("/api/agents", faro);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: expect.any(String),
      handle: "faro",
      builtin: false,
      ...faro,
      // Nasce sem Ferramentas: o Admin as concede na tela do Agente (Spec #44).
      tools: [],
      // Sem Conector, nenhuma linha de alcance na descrição pública.
      reach: [],
      // O orçamento e o gasto na Chave, só para o Admin (#28).
      monthlyBudgetUsd: null,
      keySpendUsd: 0,
      overBudget: false,
    });
  });

  test("o Agente ganha o identificador de Menção do nome inteiro, sem espaço nem acento", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const agente = await criarAgente(t, { name: "Sophya Jurídico" });

    expect(agente.handle).toBe("sophyajuridico");
    const visto = await semArticuladora(t, juliana);
    expect(visto[0]!.handle).toBe("sophyajuridico");
  });

  test("todo Membro vê a descrição dos Agentes, mas as instruções são só do Admin", async () => {
    const t = await testApp();
    await membro(t, bruno);
    const criado = await criarAgente(t);

    const visto = await semArticuladora(t, bruno);
    const doAdmin = await semArticuladora(t, juliana);

    const { instructions: _, monthlyBudgetUsd: _b, keySpendUsd: _g, overBudget: _o, ...publico } = criado;
    expect(visto).toEqual([publico]);
    expect(doAdmin).toEqual([criado]);
  });

  test("só o Admin cria Agentes", async () => {
    const t = await testApp();
    await membro(t, bruno);

    const res = await t.as(bruno).post("/api/agents", faro);

    expect(res.status).toBe(403);
    expect(await semArticuladora(t, bruno)).toEqual([]);
  });

  test("um Agente precisa de nome e de um modelo conhecido, e o nome não se repete", async () => {
    const t = await testApp();
    await criarAgente(t);

    const semNome = await t.as(juliana).post("/api/agents", { ...faro, name: " " });
    const modelo = await t.as(juliana).post("/api/agents", { ...faro, name: "Prisma", model: "gpt-qualquer" });
    const repetido = await t.as(juliana).post("/api/agents", { ...faro, name: "faro" });

    expect(semNome.status).toBe(400);
    expect(modelo.status).toBe(400);
    expect(repetido.status).toBe(409);
    expect(await repetido.json()).toMatchObject({ error: "name_taken" });
  });
});

describe("Agente num Canal", () => {
  test("um Membro adiciona um Agente a um Canal, e quem vê o Canal fica sabendo", async () => {
    const t = await testApp();
    await membro(t, bruno);
    const agente = await criarAgente(t);
    const [geral] = (await (await t.as(bruno).get("/api/channels")).json()) as ChannelDto[];
    const aba = await t.socket(juliana);

    const res = await t.as(bruno).post(`/api/channels/${geral!.id}/agents`, { agentId: agente.id });

    expect(res.status).toBe(200);
    const canal: ChannelDto = await res.json();
    expect(canal.participants).toContainEqual({
      kind: "agent",
      id: agente.id,
      displayName: "Faro",
      photo: faro.photo,
    });
    expect((await aba.next("channel.updated")).channel).toEqual(canal);
  });

  test("um Agente que não existe não entra no Canal", async () => {
    const t = await testApp();
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];

    const res = await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: crypto.randomUUID() });

    expect(res.status).toBe(400);
  });
});
