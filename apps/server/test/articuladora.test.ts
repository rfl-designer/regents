import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, MeDto } from "@shearim/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };

async function agentes(t: TestApp, who: Person = juliana): Promise<AgentDto[]> {
  return (await t.as(who).get("/api/agents")).json();
}

async function articuladora(t: TestApp, who: Person = juliana): Promise<AgentDto> {
  return (await agentes(t, who)).find((a) => a.builtin)!;
}

async function criarCanal(t: TestApp, name: string, kind: "public" | "private"): Promise<ChannelDto> {
  const res = await t.as(juliana).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return res.json();
}

describe("a Articuladora existe em todo Workspace", () => {
  test("todo Workspace vem com a Sophya, embutida, com descrição do Shearim e o identificador @sophya", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const lista = await agentes(t);

    expect(lista).toEqual([
      {
        id: expect.any(String),
        name: "Sophya",
        handle: "sophya",
        photo: null,
        description: expect.stringContaining("Articuladora"),
        model: "claude-sonnet-5-5",
        builtin: true,
        // Sem Ferramentas até o Admin conceder (Spec #44).
        tools: [],
        reach: [],
        // O Admin lê as instruções dela (são do Shearim; ele só não as edita).
        instructions: expect.stringContaining("Articuladora"),
        // Sem lista de repositórios do GitHub (#58): alcança todos os da instalação.
        githubRepositories: null,
        // O orçamento dela, como o de todo Agente (#28): sem teto até o Admin definir.
        monthlyBudgetUsd: null,
        keySpendUsd: 0,
        overBudget: false,
        // A Memória vem ligada, inclusive na Articuladora (#67).
        memoryEnabled: true,
      },
    ]);
  });

  test("ela está no #geral e em todo Canal novo, público ou privado", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const sophya = await articuladora(t);
    const comoAgente = { kind: "agent" as const, id: sophya.id, displayName: "Sophya", photo: null };

    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    const vendas = await criarCanal(t, "vendas", "public");
    const diretoria = await criarCanal(t, "diretoria", "private");

    for (const canal of [geral!, vendas, diretoria]) expect(canal.participants).toContainEqual(comoAgente);
  });

  test("ela não entra nas DMs entre pessoas", async () => {
    const t = await testApp();
    const doBruno: MeDto = await t.addMember(bruno, { by: juliana });

    const dm: DmDto = await (await t.as(juliana).post("/api/dms", { memberIds: [doBruno.id] })).json();

    expect(dm.participants.every((p) => p.kind === "member")).toBe(true);
  });
});

describe("o Admin adapta a Articuladora sem quebrar o Desfecho", () => {
  const FOTO = "data:image/png;base64,iVBORw0KGgo=";

  test("o Admin muda o nome, a foto e o modelo dela, e o identificador acompanha o nome", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const sophya = await articuladora(t);

    const res = await t.as(juliana).patch(`/api/agents/${sophya.id}`, {
      name: "Ada",
      photo: FOTO,
      model: "claude-opus-5-5",
    });

    expect(res.status).toBe(200);
    const mudou: AgentDto = await res.json();
    expect(mudou).toMatchObject({ id: sophya.id, name: "Ada", handle: "ada", photo: FOTO, model: "claude-opus-5-5" });
    expect(await articuladora(t)).toEqual(mudou);
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    expect(geral!.participants).toContainEqual({ kind: "agent", id: sophya.id, displayName: "Ada", photo: FOTO });
  });

  test("as instruções e a descrição dela são do Shearim: o Admin não as muda", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const sophya = await articuladora(t);

    const instrucoes = await t.as(juliana).patch(`/api/agents/${sophya.id}`, { instructions: "Responda tudo." });
    const descricao = await t.as(juliana).patch(`/api/agents/${sophya.id}`, { description: "Faz-tudo." });

    for (const res of [instrucoes, descricao]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "builtin_locked" });
    }
    expect(await articuladora(t)).toEqual(sophya);
  });

  test("ninguém a apaga, e só o Admin a edita", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const sophya = await articuladora(t);

    const apagar = await t.as(juliana).delete(`/api/agents/${sophya.id}`);
    const doBruno = await t.as(bruno).patch(`/api/agents/${sophya.id}`, { name: "Bruna" });

    expect(apagar.status).toBe(404);
    expect(doBruno.status).toBe(403);
    expect(await articuladora(t)).toEqual(sophya);
  });

  test("o nome dela não pode ser o de outro Agente", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(juliana).post("/api/agents", { name: "Faro", model: "claude-sonnet-5-5" });
    const sophya = await articuladora(t);

    const res = await t.as(juliana).patch(`/api/agents/${sophya.id}`, { name: "faro" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "name_taken" });
  });
});
