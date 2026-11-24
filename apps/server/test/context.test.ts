import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, MessageDto, WorkspaceContextDto } from "@shearim/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

async function novoAgente(t: TestApp, input: { name: string; description?: string; instructions?: string }) {
  const res = await t.as(juliana).post("/api/agents", { photo: null, model: "claude-sonnet-5-5", ...input });
  expect(res.status).toBe(201);
  return (await res.json()) as AgentDto;
}

async function geralDe(t: TestApp): Promise<ChannelDto> {
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  return geral!;
}

async function ajustarCanal(t: TestApp, channelId: string, change: { instructions?: string; recentMessages?: number }) {
  const res = await t.as(juliana).request(`/api/channel-settings/${channelId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  expect(res.status).toBe(200);
}

async function enviar(t: TestApp, who: Person, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana (Admin) com a Chave e o Faro no #geral. */
async function workspaceComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro = await novoAgente(t, {
    name: "Faro",
    description: "Comercial: propostas e preços.",
    instructions: "Você é o Faro, do comercial. Responda curto.",
  });
  const geral = await geralDe(t);
  await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: faro.id });
  return { faro, geral };
}

/** O que chegou à Messages API falsa na chamada `n` (a partir de 1), com o `system` como texto. */
async function contextoDaChamada(t: TestApp, n = 1) {
  const chamadas = await t.anthropic.waitForRequests(n);
  const { system, messages } = chamadas[n - 1]!.body;
  const texto = typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
  const conversa = messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")))
    .join("\n");
  return { system: texto, conversa, messages };
}

describe("Contexto do Workspace", () => {
  test("o Admin escreve o Contexto do Workspace e o lê de volta", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const vazio: WorkspaceContextDto = await (await t.as(juliana).get("/api/workspace-context")).json();
    const gravou = await t.as(juliana).put("/api/workspace-context", {
      context: "Somos a Acme, uma agência pequena. Falamos direto, sem jargão.",
    });

    expect(vazio).toEqual({ context: "" });
    expect(gravou.status).toBe(200);
    expect(await (await t.as(juliana).get("/api/workspace-context")).json()).toEqual({
      context: "Somos a Acme, uma agência pequena. Falamos direto, sem jargão.",
    });
  });

  test("só o Admin lê e edita o Contexto do Workspace", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });

    expect((await t.as(bruno).get("/api/workspace-context")).status).toBe(403);
    expect((await t.as(bruno).put("/api/workspace-context", { context: "outro" })).status).toBe(403);
  });

  test("o Contexto do Workspace é curto: texto longo demais é recusado", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const longo = await t.as(juliana).put("/api/workspace-context", { context: "a".repeat(4001) });
    const naoTexto = await t.as(juliana).put("/api/workspace-context", { context: 42 });

    expect(longo.status).toBe(400);
    expect(naoTexto.status).toBe(400);
    expect(await (await t.as(juliana).get("/api/workspace-context")).json()).toEqual({ context: "" });
  });
});

describe("Montagem de contexto", () => {
  test("o contexto entra na ordem: preâmbulo, Contexto do Workspace, instruções do Agente, Instruções do Canal, quem é quem e as mensagens", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    await t.as(bruno).patch("/api/me", { about: "Cuido do financeiro e das notas fiscais." });
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    const lince = await novoAgente(t, { name: "Lince", description: "Pesquisa de mercado." });
    await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: lince.id });
    await t.as(juliana).put("/api/workspace-context", { context: "Somos a Acme, uma agência pequena." });
    await ajustarCanal(t, geral.id, { instructions: "Aqui se fala de vendas." });

    await enviar(t, juliana, geral.id, "@Faro qual o prazo da proposta?");

    const { system, conversa } = await contextoDaChamada(t);
    const posicoes = [
      system.indexOf("chat de time"),
      system.indexOf("Somos a Acme, uma agência pequena."),
      system.indexOf("Você é o Faro, do comercial. Responda curto."),
      system.indexOf("Aqui se fala de vendas."),
      system.indexOf("Cuido do financeiro e das notas fiscais."),
    ];
    expect(posicoes.every((p) => p >= 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
    expect(conversa).toContain("@Faro qual o prazo da proposta?");
    expect(system).not.toContain("@Faro qual o prazo da proposta?");
  });

  test("o preâmbulo diz que é um chat de time em pt-BR, sem ferramentas, sem prometer ações, e quem chamou", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });

    await enviar(t, bruno, geral.id, "@Faro me manda a proposta por e-mail amanhã?");

    const { system } = await contextoDaChamada(t);
    expect(system).toContain("chat de time");
    expect(system).toContain("português do Brasil");
    expect(system).toContain("Você não tem ferramentas");
    expect(system).toContain("Não prometa ações que não pode fazer");
    expect(system).toContain("Bruno chamou você com uma Menção no Canal #geral.");
  });

  test('quem é quem traz as pessoas da conversa com o "sobre mim" e os Agentes com a descrição', async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    expect((await t.as(bruno).patch("/api/me", { about: "  Cuido do financeiro.  " })).status).toBe(200);
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    const lince = await novoAgente(t, { name: "Lince", description: "Pesquisa de mercado." });
    await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: lince.id });

    await enviar(t, juliana, geral.id, "@Faro oi");

    const { system } = await contextoDaChamada(t);
    const quemEQuem = system.slice(system.indexOf("## Quem é quem"));
    expect(quemEQuem).toContain(
      [
        "Pessoas:",
        "- Bruno: Cuido do financeiro.",
        "- Juliana",
        "Agentes:",
        "- Faro (você): Comercial: propostas e preços.",
        "- Lince: Pesquisa de mercado.",
      ].join("\n"),
    );
  });

  test("entram as N mensagens anteriores e a de origem, em ordem, com o autor e a marca de pessoa ou Agente", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.addMember(bruno, { by: juliana });
    const aba = await t.socket(juliana);
    t.anthropic.reply({ text: "Oi, sou o Faro." });
    await enviar(t, juliana, geral.id, "@Faro primeira, fica de fora");
    await aba.next("message.created");
    await aba.next("message.created"); // a resposta do Faro
    await ajustarCanal(t, geral.id, { recentMessages: 2 });
    await enviar(t, bruno, geral.id, "A proposta da Acme vence sexta.");

    await enviar(t, juliana, geral.id, "@Faro e o desconto?");

    const { conversa, messages } = await contextoDaChamada(t, 2);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(conversa).toContain(
      [
        "Faro (Agente): Oi, sou o Faro.",
        "Bruno (pessoa): A proposta da Acme vence sexta.",
        "Juliana (pessoa): @Faro e o desconto?",
      ].join("\n\n"),
    );
    expect(conversa).not.toContain("primeira, fica de fora");
  });

  test("com N = 0, o Agente recebe só a mensagem que responde", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await enviar(t, juliana, geral.id, "Antes de chamar o Faro.");
    await ajustarCanal(t, geral.id, { recentMessages: 0 });

    await enviar(t, juliana, geral.id, "@Faro só esta");

    const { conversa } = await contextoDaChamada(t);
    expect(conversa).toContain("Juliana (pessoa): @Faro só esta");
    expect(conversa).not.toContain("Antes de chamar o Faro.");
  });

  test("o contexto é lido quando a execução começa: a que sai de novo depois do reinício leva o que mudou", async () => {
    const t = await testApp();
    const { geral } = await workspaceComFaro(t);
    await t.as(juliana).put("/api/workspace-context", { context: "Contexto antigo." });
    await ajustarCanal(t, geral.id, { instructions: "Instruções antigas." });
    t.anthropic.reply({ hang: true }, { text: "Pronto." });
    await enviar(t, juliana, geral.id, "@Faro responde depois");
    const antes = await contextoDaChamada(t, 1);

    await t.as(juliana).put("/api/workspace-context", { context: "Contexto novo." });
    await ajustarCanal(t, geral.id, { instructions: "Instruções novas." });
    await t.restart();

    const depois = await contextoDaChamada(t, 2);
    expect(antes.system).toContain("Contexto antigo.");
    expect(antes.system).toContain("Instruções antigas.");
    expect(depois.system).toContain("Contexto novo.");
    expect(depois.system).toContain("Instruções novas.");
    expect(depois.system).not.toContain("antig");
  });
});
