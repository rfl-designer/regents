/**
 * A extração não descarta calada (spec #60; revisão de código, decisões 3C e "nada some sem
 * aparecer"): o que ela devolve e o Shearim não guarda aparece no Andamento da extração ("não
 * guardou na Memória: <motivo>"), junto do que foi guardado, sem push e sem "Tentar de novo".
 *
 * E cada operação cita a mensagem de pessoa da troca em que aquilo foi dito (ADR 0013): a entrada
 * mostra os ids das mensagens de pessoa, operação sem citação ou citando o que não é mensagem de
 * pessoa da troca é descartada (e aparece no Andamento), e a origem do item é a mensagem citada.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

/** Juliana (Admin, com a Chave), o Faro no #produto e o Bruno lá dentro. */
async function produtoComFaro(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.addMember(bruno, { by: juliana });
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-chave" });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "O Faro.",
      instructions: "Você é o Faro.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const produto: ChannelDto = await (
    await t.as(juliana).post("/api/channels", { name: "produto", kind: "public" })
  ).json();
  await t.as(juliana).post(`/api/channels/${produto.id}/agents`, { agentId: faro.id });
  await t.as(bruno).post(`/api/channels/${produto.id}/join`);
  return { faro, produto };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string) {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

async function memoria(t: TestApp, who: Person, conversationId: string): Promise<MemoryItemDto[]> {
  return (await t.as(who).get(`/api/conversations/${conversationId}/memory`)).json();
}

async function abertas(t: TestApp, who: Person, conversationId: string): Promise<ExecutionDto[]> {
  return (await t.as(who).get(`/api/conversations/${conversationId}/executions`)).json();
}

/** O Andamento da extração, como chega a esta aba. */
async function daExtracao(aba: EventSocket): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.kind === "memory") return execution;
  }
}

/** A entrada (o texto do usuário) da `n`-ésima extração que chegou à Messages API falsa. */
async function entradaDaExtracao(t: TestApp, n: number) {
  const [pedido] = (await t.anthropic.waitForExtractions(n, 5_000)).slice(n - 1);
  return JSON.stringify(pedido!.body.messages);
}

describe("o que a extração descarta aparece no Andamento", () => {
  test("um item com mais de 500 caracteres não é guardado nem cortado: o Andamento diz que não guardou, e o outro item fica guardado", async () => {
    const falhas: ExecutionDto[] = [];
    const t = await testApp({ hooks: { executionFailed: (e) => falhas.push(e) } });
    const { produto } = await produtoComFaro(t);
    const doBruno = await t.socket(bruno);
    const longo = `O contrato da Acme ${"tem muitas cláusulas ".repeat(30)}`;
    t.anthropic.remember({
      json: {
        operacoes: [
          { acao: "criar", texto: "A reunião de produto é às terças." },
          { acao: "criar", texto: longo },
        ],
      },
    });

    await enviar(t, juliana, produto.id, "@faro anota: reunião às terças, e o contrato da Acme");

    const andamento = await daExtracao(doBruno);
    expect(andamento.state).toBe("done");
    expect(andamento.reason).toContain("O contrato da Acme");
    expect(andamento.reason).toContain("passou de 500 caracteres");
    expect((await memoria(t, bruno, produto.id)).map((i) => i.text)).toEqual(["A reunião de produto é às terças."]);
    // Continua à vista para quem abre a conversa depois.
    expect(await abertas(t, bruno, produto.id)).toEqual([andamento]);
    // Sem push e sem "Tentar de novo": a resposta já chegou.
    expect(falhas).toEqual([]);
    const refazer = await t.as(juliana).post(`/api/conversations/${produto.id}/executions/${andamento.id}/retry`);
    expect(refazer.status).toBe(409);
  });

  test("mais de 10 operações: as 10 primeiras são guardadas, e o Andamento diz quantas ficaram de fora", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const doBruno = await t.socket(bruno);
    const textos = Array.from({ length: 12 }, (_, i) => `Fato número ${i + 1}.`);
    t.anthropic.remember({ json: { operacoes: textos.map((texto) => ({ acao: "criar", texto })) } });

    await enviar(t, juliana, produto.id, "@faro anota tudo isso");

    const andamento = await daExtracao(doBruno);
    expect(andamento.reason).toContain("2 itens a mais que o teto de 10");
    const guardados = (await memoria(t, bruno, produto.id)).map((i) => i.text);
    expect(guardados).toHaveLength(10);
    expect(guardados).not.toContain("Fato número 11.");
  });

  test("operação que não se entende (sem texto, ação desconhecida, substituir sem id) aparece no Andamento", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const doBruno = await t.socket(bruno);
    t.anthropic.remember({
      json: {
        operacoes: [
          { acao: "criar", texto: "   " },
          { acao: "apagar", texto: "O preço sobe em janeiro." },
          { acao: "substituir", texto: "O preço sobe em março." },
          { acao: "criar", texto: "A reunião é às terças." },
        ],
      },
    });

    await enviar(t, juliana, produto.id, "@faro anota");

    const andamento = await daExtracao(doBruno);
    expect(andamento.state).toBe("done");
    expect(andamento.reason).toContain("3 operações que não se entendem");
    expect((await memoria(t, bruno, produto.id)).map((i) => i.text)).toEqual(["A reunião é às terças."]);
  });

  test("sem nada descartado, a extração continua fora da vista", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    t.anthropic.remember({ json: { operacoes: [{ acao: "criar", texto: "A reunião é às terças." }] } });

    await enviar(t, juliana, produto.id, "@faro anota");

    await eventually("o item na Memória", async () =>
      (await memoria(t, bruno, produto.id)).length ? true : undefined,
    );
    expect(await abertas(t, bruno, produto.id)).toEqual([]);
  });
});

describe("cada operação cita a mensagem de pessoa em que aquilo foi dito", () => {
  test("a entrada da extração mostra o id de cada mensagem de pessoa", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const antes = await enviar(t, bruno, produto.id, "O preço sobe em janeiro.");
    const origem = await enviar(t, juliana, produto.id, "@faro anota isso");

    const entrada = await entradaDaExtracao(t, 1);
    expect(entrada).toContain(`[${antes.id}] Bruno (pessoa): O preço sobe em janeiro.`);
    expect(entrada).toContain(`[${origem.id}] Juliana (pessoa): @faro anota isso`);
  });

  test("a origem do item é a mensagem citada, mesmo que não seja a respondida", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const antes = await enviar(t, bruno, produto.id, "O preço sobe em janeiro.");
    t.anthropic.remember({
      json: { operacoes: [{ acao: "criar", texto: "O preço sobe em janeiro.", mensagem: antes.id }] },
    });

    await enviar(t, juliana, produto.id, "@faro anota o que o Bruno disse");

    const [item] = await eventually("o item na Memória", async () => {
      const lista = await memoria(t, bruno, produto.id);
      return lista.length ? lista : undefined;
    });
    expect(item!.origin).toMatchObject({ messageId: antes.id, author: "Bruno" });
  });

  test("operação sem citação ou citando o que não é mensagem de pessoa da troca é descartada, e o Andamento diz", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const doBruno = await t.socket(bruno);
    // Fora da troca: a mensagem de outra conversa.
    const outro: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "outro", kind: "public" })
    ).json();
    const deFora = await enviar(t, juliana, outro.id, "O preço sobe em março.");
    // Uma resposta do Faro: mensagem de Agente, nunca fonte.
    await enviar(t, juliana, produto.id, "@faro oi");
    const [resposta] = await eventually("a resposta do Faro", async () => {
      const lista = (await (
        await t.as(juliana).get(`/api/conversations/${produto.id}/messages`)
      ).json()) as MessageDto[];
      const doFaro = lista.filter((m) => m.author.kind === "agent");
      return doFaro.length ? doFaro : undefined;
    });
    await t.anthropic.waitForExtractions(1, 5_000);
    await eventually("a primeira extração terminar", async () =>
      (await abertas(t, bruno, produto.id)).length === 0 ? true : undefined,
    );
    t.anthropic.remember({
      json: {
        operacoes: [
          { acao: "criar", texto: "Sem citação.", mensagem: "" },
          { acao: "criar", texto: "Citando o Agente.", mensagem: resposta!.id },
          { acao: "criar", texto: "Citando outra conversa.", mensagem: deFora.id },
          { acao: "criar", texto: "A reunião é às terças." },
        ],
      },
    });

    await enviar(t, juliana, produto.id, "@faro a reunião é às terças");

    const andamento = await daExtracao(doBruno);
    expect(andamento.reason).toContain('"Sem citação.": não cita uma mensagem de pessoa da troca');
    expect(andamento.reason).toContain('"Citando o Agente.": não cita uma mensagem de pessoa da troca');
    expect(andamento.reason).toContain('"Citando outra conversa.": não cita uma mensagem de pessoa da troca');
    expect((await memoria(t, bruno, produto.id)).map((i) => i.text)).toEqual(["A reunião é às terças."]);
  });

  test("o id citado entre colchetes, como a entrada mostra, também vale (na mensagem e no item a substituir)", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const primeira = await enviar(t, bruno, produto.id, "O preço sobe em janeiro.");
    t.anthropic.remember({
      json: { operacoes: [{ acao: "criar", texto: "O preço sobe em janeiro.", mensagem: `[${primeira.id}]` }] },
    });
    await enviar(t, juliana, produto.id, "@faro anota");
    const [antigo] = await eventually("o item na Memória", async () => {
      const lista = await memoria(t, bruno, produto.id);
      return lista.length ? lista : undefined;
    });

    const segunda = await enviar(t, bruno, produto.id, "Na verdade sobe em março.");
    t.anthropic.remember({
      json: {
        operacoes: [
          { acao: "substituir", id: ` [${antigo!.id}] `, texto: "O preço sobe em março.", mensagem: `[${segunda.id}]` },
        ],
      },
    });
    await enviar(t, juliana, produto.id, "@faro corrige");

    const ativos = await eventually("a versão nova", async () => {
      const lista = (await memoria(t, bruno, produto.id)).filter((i) => i.state === "active");
      return lista[0]?.text === "O preço sobe em março." ? lista : undefined;
    });
    expect(ativos).toHaveLength(1);
    expect(ativos[0]!.origin).toMatchObject({ messageId: segunda.id });
  });
});

describe("substituir o mesmo item duas vezes numa extração", () => {
  test("só a primeira versão nova fica ativa; a outra é descartada, à vista", async () => {
    const t = await testApp();
    const { produto } = await produtoComFaro(t);
    const doBruno = await t.socket(bruno);
    t.anthropic.remember({ json: { operacoes: [{ acao: "criar", texto: "O preço sobe em janeiro." }] } });
    await enviar(t, juliana, produto.id, "@faro o preço sobe em janeiro");
    const [antigo] = await eventually("o item na Memória", async () => {
      const lista = await memoria(t, bruno, produto.id);
      return lista.length ? lista : undefined;
    });

    t.anthropic.remember({
      json: {
        operacoes: [
          { acao: "substituir", id: antigo!.id, texto: "O preço sobe em março." },
          { acao: "substituir", id: antigo!.id, texto: "O preço sobe em abril." },
        ],
      },
    });
    await enviar(t, juliana, produto.id, "@faro março, ou talvez abril");

    const andamento = await daExtracao(doBruno);
    expect(andamento.reason).toContain(
      '"O preço sobe em abril.": o item a substituir já foi substituído nesta extração',
    );
    const ativos = (await memoria(t, bruno, produto.id)).filter((i) => i.state === "active");
    expect(ativos.map((i) => i.text)).toEqual(["O preço sobe em março."]);
    const [arquivado] = (await memoria(t, bruno, produto.id)).filter((i) => i.id === antigo!.id);
    expect(arquivado!.replacedById).toBe(ativos[0]!.id);
  });
});
