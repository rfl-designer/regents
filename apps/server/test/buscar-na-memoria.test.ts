/**
 * Buscar na Memória (spec #60, ticket #69; ADR 0012): o que não cabe no orçamento do resumo entra
 * só pelo título (o começo do texto), e todo Agente com a Memória ligada busca o resto pela
 * Ferramenta "buscar na Memória", de leitura, sem concessão do Admin, pela Chave e pela Conta.
 *
 * A busca é por texto e alcança a Memória do Workspace, a Memória da Conversa e a Memória do
 * próprio Agente de toda conversa dentro do alcance da resposta (o mesmo das Ferramentas do
 * Workspace, `reachOf`). Nada fora do alcance aparece, nem pelo título.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, ExecutionDto, MeDto, MemoryItemDto, MessageDto } from "@shearim/contracts";
import { schema } from "../src/db/client";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const ana = { id: "1002", login: "ana@exemplo.com", name: "Ana" };
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const BUSCAR = "buscar_na_memoria";

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

/**
 * Juliana (Admin) grava a Chave; Ana e Bruno entram no #geral, com o Faro. Ana cria o #financeiro
 * (privado, só ela) e põe o Faro lá. Nenhuma Ferramenta é concedida.
 */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const me: Record<string, MeDto> = {};
  for (const p of [ana, bruno]) me[p.name] = await t.addMember(p, { by: juliana });
  const faro = await novoAgente(t, "Faro");
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  for (const p of [ana, bruno]) await t.as(p).post(`/api/channels/${geral!.id}/join`);
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  const financeiro: ChannelDto = await (
    await t.as(ana).post("/api/channels", { name: "financeiro", kind: "private" })
  ).json();
  expect((await t.as(ana).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id })).status).toBe(200);
  return { me, faro, geral: geral!, financeiro };
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function dm(t: TestApp, who: Person, input: { memberIds: string[]; agentId?: string }): Promise<DmDto> {
  const res = await t.as(who).post("/api/dms", input);
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, who: Person, conversationId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(who).get(`/api/conversations/${conversationId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
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

/** `who` guarda `textos` na Memória de `conversationId` pela troca com o Faro (a extração roteirizada). */
async function guardar(t: TestApp, who: Person, conversationId: string, textos: string[]) {
  const ler = async () =>
    (await (await t.as(who).get(`/api/conversations/${conversationId}/memory`)).json()) as MemoryItemDto[];
  const antes = (await ler()).length;
  t.anthropic.remember({ json: { operacoes: textos.map((texto) => ({ acao: "criar", texto })) } });
  await enviar(t, who, conversationId, "@faro anota isso");
  return eventually(
    "os itens guardados",
    async () => {
      const itens = await ler();
      return itens.length >= antes + textos.length ? itens : undefined;
    },
    10_000,
  );
}

/**
 * Um item da Memória do Agente com origem numa mensagem da conversa. A extração ainda não escolhe
 * o escopo do Agente (#65): o item é gravado como ela gravaria.
 */
async function licaoDoAgente(t: TestApp, agentId: string, origem: MessageDto, text: string) {
  await t.db.insert(schema.memoryItems).values({
    id: crypto.randomUUID(),
    scope: "agent",
    agentId,
    conversationId: origem.channelId,
    originMessageId: origem.id,
    text,
    createdBy: "extraction",
    state: "active",
    createdAt: t.clock.now(),
  });
}

/**
 * `who` fala com o Faro em `conversationId`, e o modelo chama "buscar na Memória" com `texto`.
 * Devolve o resultado que voltou ao modelo, o pedido da resposta e o Andamento visto por `who`.
 */
async function buscar(t: TestApp, who: Person, conversationId: string, texto: string, body = "@faro o que sabe?") {
  const aba = await t.socket(who);
  const antes = respostas(t).length;
  t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: BUSCAR, input: { texto } }] }, { text: "Pronto." });
  const origem = await enviar(t, who, conversationId, body);
  await respostaA(t, who, conversationId, origem);
  const pedido = respostas(t)[antes]!;
  const [resultado] = toolResults(respostas(t)[antes + 1]!.body);
  const andamento = await eventually("o Andamento terminar", async () => {
    const vistos = aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
    return vistos.some((e) => e.state === "done") ? vistos : undefined;
  });
  await aba.close();
  return { resultado: resultado!, pedido, andamento };
}

describe("o que não cabe no resumo entra só pelo título", () => {
  test(
    "passando do orçamento, o item mais velho entra só pelo começo do texto, e a busca traz o texto inteiro",
    async () => {
      // Cabem as duas linhas curtas ("- Segundo fato.\n", "- Terceiro fato.\n"); a longa não.
      const t = await testApp({ memory: { summaryChars: 40 } });
      const { geral } = await workspace(t);
      await guardar(t, ana, geral.id, [
        "O reembolso de viagens agora sai pelo Flouz, a partir de dezembro, com a nota fiscal anexada.",
      ]);
      await guardar(t, ana, geral.id, ["Segundo fato.", "Terceiro fato."]);

      const { resultado, pedido } = await buscar(t, bruno, geral.id, "reembolso");

      const system = systemDe(pedido);
      expect(system).toContain("- Segundo fato.\n- Terceiro fato.");
      expect(system).toContain("- O reembolso de viagens agora sai pelo Flouz, a partir de…");
      expect(system).not.toContain("nota fiscal");
      // O título diz ao modelo como ler o resto.
      expect(system).toContain("buscar na Memória");
      expect(resultado.is_error).toBeFalsy();
      expect(resultado.content).toContain(
        "O reembolso de viagens agora sai pelo Flouz, a partir de dezembro, com a nota fiscal anexada.",
      );
    },
    LONGO,
  );
});

describe("a Ferramenta vem com a Memória ligada", () => {
  test(
    "sem concessão do Admin, o Agente recebe buscar na Memória; o Admin não a vê para conceder ou retirar",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);

      const catalogo = (await (await t.as(juliana).get(`/api/agents/${faro.id}/tools`)).json()) as { id: string }[];
      expect(catalogo.map((f) => f.id)).not.toContain(BUSCAR);
      expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${BUSCAR}`)).status).toBe(404);

      await respostaA(t, bruno, geral.id, await enviar(t, bruno, geral.id, "@faro oi"));
      const [pedido] = respostas(t);
      expect(ferramentasDe(pedido!)).toEqual([BUSCAR]);
      expect(systemDe(pedido!)).toContain("Você pode usar estas Ferramentas durante a resposta: buscar na Memória.");
    },
    LONGO,
  );

  test(
    'é de leitura, sem Pedido de aprovação, e aparece no Andamento como "buscando na Memória"',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.as(juliana).post("/api/workspace-memory", { text: "O reembolso sai pelo Flouz." });

      const { resultado, andamento } = await buscar(t, bruno, geral.id, "reembolso");

      expect(resultado.is_error).toBeFalsy();
      expect(resultado.content).toContain("O reembolso sai pelo Flouz.");
      const passos = andamento.flatMap((e: ExecutionDto) => e.tools);
      expect(passos.some((f) => f.tool === BUSCAR && f.label === "buscando na Memória")).toBe(true);
      expect(passos.filter((f) => f.tool === BUSCAR).every((f) => f.state !== "failed")).toBe(true);
      expect(andamento.map((e) => e.state)).not.toContain("awaiting_approval");
      expect(andamento.at(-1)!.state).toBe("done");
    },
    LONGO,
  );

  test(
    "com a Memória desligada, o Agente não tem a Ferramenta",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.as(juliana).post("/api/workspace-memory", { text: "O reembolso sai pelo Flouz." });
      expect((await t.as(juliana).patch(`/api/agents/${faro.id}`, { memoryEnabled: false })).status).toBe(200);

      await respostaA(t, bruno, geral.id, await enviar(t, bruno, geral.id, "@faro como sai o reembolso?"));

      const [pedido] = respostas(t);
      expect(ferramentasDe(pedido!)).toEqual([]);
      expect(systemDe(pedido!)).toContain("Você não tem ferramentas");
    },
    LONGO,
  );
});

describe("pela Conta", () => {
  test(
    "o claude -p recebe o endpoint MCP do Shearim mesmo sem concessão, lista e chama buscar na Memória, e o Agente responde com o resultado",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.as(juliana).post("/api/workspace-memory", { text: "O reembolso sai pelo Flouz." });
      await t.linkAccount(juliana);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ tool: { name: BUSCAR, input: { texto: "reembolso" } } }, { text: "{resultado}" }],
        },
      });

      const resposta = await respostaA(
        t,
        juliana,
        geral.id,
        await enviar(t, juliana, geral.id, "@faro e o reembolso?"),
      );

      const [listou, chamou] = t.claude.mcp();
      expect(listou).toMatchObject({ listed: [BUSCAR] });
      expect(chamou).toMatchObject({ called: BUSCAR, result: { isError: false } });
      expect(resposta.body).toContain("O reembolso sai pelo Flouz.");
      const [execucao] = t.claude.callsOf("-p").filter((c) => c.stdin);
      expect(execucao!.argv).toContain("--mcp-config");
    },
    LONGO,
  );
});

describe("o que a busca alcança", () => {
  test(
    "a Memória do Workspace, a da Conversa e a do próprio Agente, cada uma com a origem; a de outro Agente não",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const lia = await novoAgente(t, "Lia");
      await t.as(juliana).post("/api/workspace-memory", { text: "Reembolso: todo pedido passa pelo financeiro." });
      await guardar(t, ana, geral.id, ["O reembolso de viagens sai pelo Flouz."]);
      const origem = await enviar(t, ana, geral.id, "Faro, sempre cite o número do pedido de reembolso.");
      await licaoDoAgente(t, faro.id, origem, "Citar o número do pedido de reembolso.");
      await licaoDoAgente(t, lia.id, origem, "Reembolso é com o Faro.");

      const { resultado } = await buscar(t, bruno, geral.id, "REEMBOLSO");

      expect(resultado.content).toContain("Reembolso: todo pedido passa pelo financeiro.");
      expect(resultado.content).toContain("O reembolso de viagens sai pelo Flouz.");
      expect(resultado.content).toContain("Citar o número do pedido de reembolso.");
      expect(resultado.content).toContain("#geral");
      expect(resultado.content).not.toContain("Reembolso é com o Faro.");
    },
    LONGO,
  );

  test(
    "a Memória de #financeiro (privado) não aparece numa resposta no #geral, nem pelo título, nem no Andamento",
    async () => {
      const t = await testApp({ memory: { summaryChars: 1 } });
      const { faro, geral, financeiro } = await workspace(t);
      await guardar(t, ana, financeiro.id, ["O orçamento de 2027 fecha em março."]);
      const origem = await enviar(t, ana, financeiro.id, "Faro, no orçamento use sempre valores sem centavos.");
      await licaoDoAgente(t, faro.id, origem, "Orçamento com valores sem centavos.");
      await guardar(t, ana, geral.id, ["O orçamento do evento é de 10 mil."]);

      const { resultado, pedido, andamento } = await buscar(t, ana, geral.id, "orçamento");

      expect(resultado.content).toContain("O orçamento do evento é de 10 mil.");
      const tudo = systemDe(pedido) + resultado.content + JSON.stringify(andamento);
      expect(tudo).not.toContain("2027");
      expect(tudo).not.toContain("centavos");
      expect(tudo).not.toContain("financeiro");
    },
    LONGO,
  );

  test(
    "numa DM só entre Ana e o Faro, a busca alcança a Memória dos Canais de Ana; numa DM em grupo, só o que todos veem",
    async () => {
      const t = await testApp();
      const { me, faro, financeiro } = await workspace(t);
      await guardar(t, ana, financeiro.id, ["O orçamento de 2027 fecha em março."]);
      const origem = await enviar(t, ana, financeiro.id, "Faro, no orçamento use sempre valores sem centavos.");
      await licaoDoAgente(t, faro.id, origem, "Orçamento com valores sem centavos.");
      const emGrupo = await dm(t, ana, { memberIds: [me.Bruno!.id] });
      await guardar(t, ana, emGrupo.id, ["O orçamento da viagem é da Ana."]);

      const soComAna = await dm(t, ana, { memberIds: [], agentId: faro.id });
      const sozinha = await buscar(t, ana, soComAna.id, "orçamento", "o que tem do orçamento?");
      expect(sozinha.resultado.content).toContain("O orçamento de 2027 fecha em março.");
      expect(sozinha.resultado.content).toContain("Orçamento com valores sem centavos.");
      expect(sozinha.resultado.content).toContain("#financeiro");

      const juntos = await buscar(t, ana, emGrupo.id, "orçamento", "@faro o que tem do orçamento?");
      expect(juntos.resultado.content).toContain("O orçamento da viagem é da Ana.");
      const tudo = juntos.resultado.content + systemDe(juntos.pedido) + JSON.stringify(juntos.andamento);
      expect(tudo).not.toContain("2027");
      expect(tudo).not.toContain("centavos");
      expect(tudo).not.toContain("financeiro");
    },
    LONGO,
  );

  test(
    "a busca nunca alcança uma conversa que o autor não vê, mesmo que o Agente participe dela",
    async () => {
      const t = await testApp();
      const { faro, financeiro } = await workspace(t);
      await guardar(t, ana, financeiro.id, ["O orçamento de 2027 fecha em março."]);
      const origem = await enviar(t, ana, financeiro.id, "Faro, no orçamento use sempre valores sem centavos.");
      await licaoDoAgente(t, faro.id, origem, "Orçamento com valores sem centavos.");

      const comBruno = await dm(t, bruno, { memberIds: [], agentId: faro.id });
      const { resultado, pedido, andamento } = await buscar(t, bruno, comBruno.id, "orçamento", "e o orçamento?");

      const tudo = resultado.content + systemDe(pedido) + JSON.stringify(andamento);
      expect(tudo).not.toContain("2027");
      expect(tudo).not.toContain("centavos");
      expect(tudo).not.toContain("financeiro");
    },
    LONGO,
  );
});
