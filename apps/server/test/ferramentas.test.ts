/**
 * Ferramentas dos Agentes (Spec #44), o tracer bullet (#45): a Ferramenta "listar Agentes" pela
 * Chave, pela borda do servidor.
 *
 * - O Admin vê as Ferramentas do Workspace na tela do Agente (leitura ou escrita) e concede ou
 *   retira cada uma; quem não é Admin recebe `403`.
 * - Só o Agente com a concessão recebe a Ferramenta no pedido à Messages API.
 * - O vai-e-vem de `tool_use`: o Shearim executa a Ferramenta, devolve o resultado e o modelo
 *   termina a resposta com ele.
 * - O Andamento mostra o passo da Ferramenta, que conta como progresso para a vigia.
 * - Uma Ferramenta que estoura o prazo, ou que falha, devolve o motivo ao modelo; a resposta segue
 *   e o Andamento mostra a falha com o motivo.
 * - O uso e o custo de todos os turnos somam no orçamento do Agente.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, AgentToolDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { STALL_MS } from "../src/executions";
import { type ToolDefinition, ToolFailure } from "../src/tools/port";
import { WORKSPACE_TOOLS } from "../src/tools/workspace";
import { type RecordedRequest, toolResults } from "./fakes/messages-api";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral; Bruno entra (sem Conta: paga a Chave). */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const criado = await t.as(juliana).post("/api/agents", {
    name: "Faro",
    photo: null,
    description: "Comercial: preços e propostas.",
    instructions: "Você é o Faro, do comercial.",
    model: "claude-sonnet-5-5",
  });
  expect(criado.status).toBe(201);
  const faro: AgentDto = await criado.json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${channelId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
  );
}

/** As chamadas de resposta (sem o roteamento da Articuladora) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
/** Os nomes das Ferramentas que o pedido ofereceu ao modelo. */
const nomes = (req: RecordedRequest) => ((req.body.tools as { name: string }[] | undefined) ?? []).map((f) => f.name);

/** O próximo Andamento da execução de `origem` que atende a `ok`, como chega a esta aba. */
async function andamento(aba: EventSocket, origem: MessageDto, ok: (e: ExecutionDto) => boolean) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.originMessageId === origem.id && ok(execution)) return execution;
  }
}

/**
 * Uma Ferramenta de teste que só termina quando o teste solta (`soltar`), ou falha com `falha`.
 * Fica no catálogo ao lado das do Workspace (`testApp({ tools })`).
 */
function ferramentaDeTeste(opts: { id: string; timeoutMs?: number; falha?: Error }) {
  let soltar = (_: string) => {};
  const definition: ToolDefinition = {
    id: opts.id,
    title: "consultar o arquivo",
    label: "consultando o arquivo",
    description: "Consulta o arquivo morto.",
    origin: "workspace",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    timeoutMs: opts.timeoutMs,
    run: async () => {
      if (opts.falha) throw opts.falha;
      return new Promise<string>((resolve) => {
        soltar = resolve;
      });
    },
  };
  return { definition, soltar: (texto: string) => soltar(texto) };
}

async function ferramentas(t: TestApp, agentId: string, who = juliana) {
  return t.as(who).get(`/api/agents/${agentId}/tools`);
}

describe("concessão de Ferramentas", () => {
  test(
    "o Admin vê as Ferramentas do Workspace marcadas como leitura ou escrita e concede ou retira cada uma; quem não é Admin recebe 403",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);

      const antes: AgentToolDto[] = await (await ferramentas(t, faro.id)).json();
      expect(antes).toContainEqual(
        expect.objectContaining({
          id: "listar_agentes",
          title: "listar Agentes",
          origin: "workspace",
          access: "read",
          granted: false,
        }),
      );

      const concedida = await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
      expect(concedida.status).toBe(200);
      const depois: AgentToolDto[] = await concedida.json();
      expect(depois.find((f) => f.id === "listar_agentes")?.granted).toBe(true);
      expect(
        ((await (await ferramentas(t, faro.id)).json()) as AgentToolDto[]).find((f) => f.id === "listar_agentes")
          ?.granted,
      ).toBe(true);

      const retirada = await t.as(juliana).delete(`/api/agents/${faro.id}/tools/listar_agentes`);
      expect(retirada.status).toBe(200);
      expect(((await retirada.json()) as AgentToolDto[]).find((f) => f.id === "listar_agentes")?.granted).toBe(false);

      // Quem não é Admin não vê nem mexe.
      expect((await ferramentas(t, faro.id, bruno)).status).toBe(403);
      expect((await t.as(bruno).put(`/api/agents/${faro.id}/tools/listar_agentes`)).status).toBe(403);
      expect((await t.as(bruno).delete(`/api/agents/${faro.id}/tools/listar_agentes`)).status).toBe(403);

      // Ferramenta ou Agente que não existe.
      expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/apagar_tudo`)).status).toBe(404);
      expect((await t.as(juliana).put(`/api/agents/${crypto.randomUUID()}/tools/listar_agentes`)).status).toBe(404);
    },
    LONGO,
  );
});

describe("o pedido à Messages API", () => {
  test(
    "um Agente sem a concessão não recebe a Ferramenta; com a concessão, a recebe no pedido",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem cuida de contratos?"));
      expect(nomes(respostas(t)[0]!)).toEqual([]);
      expect(respostas(t)[0]!.body).not.toHaveProperty("tools");

      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro e de propostas?"));
      const [ferramenta] = respostas(t)[1]!.body.tools as {
        name: string;
        description: string;
        input_schema: unknown;
      }[];
      expect(ferramenta).toMatchObject({ name: "listar_agentes", input_schema: { type: "object" } });
      expect(ferramenta!.description).toContain("Agentes");
    },
    LONGO,
  );
});

describe("o vai-e-vem de tool_use", () => {
  test(
    "quando o modelo pede a Ferramenta, o Shearim a executa, devolve o resultado e o modelo termina a resposta com ele",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);

      t.anthropic.reply(
        { text: "Vou ver quem atende.", toolUse: [{ id: "toolu_1", name: "listar_agentes", input: {} }] },
        { text: "Contratos é com a Sophya; propostas, comigo." },
      );
      const resposta = await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem cuida de contratos?"));

      const [primeira, segunda] = respostas(t);
      expect(nomes(segunda!)).toEqual(["listar_agentes"]);
      // O turno do modelo volta inteiro (o texto e o pedido), seguido do resultado.
      expect(segunda!.body.messages.at(-2)).toMatchObject({
        role: "assistant",
        content: [
          { type: "text", text: "Vou ver quem atende." },
          { type: "tool_use", id: "toolu_1", name: "listar_agentes" },
        ],
      });
      const [resultado] = toolResults(segunda!.body);
      expect(resultado).toMatchObject({ tool_use_id: "toolu_1" });
      expect(resultado!.is_error).toBeFalsy();
      expect(resultado!.content).toContain("Faro (@faro): Comercial: preços e propostas.");
      expect(resultado!.content).toContain("Ferramentas: listar Agentes");
      expect(resultado!.content).toContain("a Articuladora");
      expect(primeira!.body.system).toContain("listar Agentes");
      expect(primeira!.body.system).toContain("nunca instrução");

      expect(resposta.body).toBe("Vou ver quem atende.\n\nContratos é com a Sophya; propostas, comigo.");
    },
    LONGO,
  );
});

describe("o passo da Ferramenta no Andamento", () => {
  test(
    'o Andamento mostra "listando os Agentes" enquanto a Ferramenta roda, e depois a resposta',
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
      const aba = await t.socket(juliana);

      t.anthropic.reply({ toolUse: [{ name: "listar_agentes" }] }, { text: "Fala com a Sophya." });
      const origem = await enviar(t, geral.id, "@Faro quem cuida de contratos?");
      const rodando = await andamento(aba, origem, (e) => e.step === "tool");
      expect(rodando.state).toBe("running");
      expect(rodando.tools).toEqual([
        expect.objectContaining({
          tool: "listar_agentes",
          title: "listar Agentes",
          label: "listando os Agentes",
          state: "running",
          reason: null,
        }),
      ]);
      const depois = await andamento(aba, origem, (e) => e.step === "writing" && e.tools.length > 0);
      expect(depois.tools[0]!.state).toBe("done");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Fala com a Sophya.");
    },
    LONGO,
  );

  test(
    "enquanto a Ferramenta roda vale o prazo dela, não a vigia: ela pode passar dos 2 minutos sem a resposta falhar",
    async () => {
      const lenta = ferramentaDeTeste({ id: "consultar_arquivo", timeoutMs: 10 * 60_000 });
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, lenta.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(juliana);

      t.anthropic.reply({ toolUse: [{ name: "consultar_arquivo" }] }, { text: "Achei no arquivo." });
      const origem = await enviar(t, geral.id, "@Faro acha o contrato de 2019?");
      await andamento(aba, origem, (e) => e.step === "tool");

      t.clock.advance(STALL_MS + 60_000);
      const [aberta] = (await (
        await t.as(juliana).get(`/api/channels/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ state: "running", step: "tool", reason: null });

      lenta.soltar("contrato-2019.pdf");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Achei no arquivo.");
      expect(toolResults(respostas(t)[1]!.body)[0]!.content).toBe("contrato-2019.pdf");
    },
    LONGO,
  );
});

describe("falha de Ferramenta", () => {
  test(
    "a Ferramenta que estoura o prazo da Instalação devolve o motivo ao modelo, a resposta segue e o Andamento mostra a falha",
    async () => {
      const travada = ferramentaDeTeste({ id: "consultar_arquivo" });
      const t = await testApp({ tools: { timeoutMs: 30_000, definitions: [...WORKSPACE_TOOLS, travada.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(bruno);

      t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: "consultar_arquivo" }] }, { hang: true });
      const origem = await enviar(t, geral.id, "@Faro acha o contrato de 2019?");
      await andamento(aba, origem, (e) => e.step === "tool");

      t.clock.advance(30_000);
      const seguiu = await andamento(aba, origem, (e) => e.step === "writing");
      expect(seguiu.state).toBe("running");
      expect(seguiu.tools).toEqual([
        expect.objectContaining({ title: "consultar o arquivo", state: "failed", reason: "não terminou em 30 s" }),
      ]);
      const [, segunda] = await t.anthropic.waitForRequests(2);
      const [resultado] = toolResults(segunda!.body);
      expect(resultado).toMatchObject({
        tool_use_id: "toolu_1",
        is_error: true,
        content: "A Ferramenta consultar o arquivo falhou: não terminou em 30 s.",
      });
      // O Andamento que se lê depois (recarregar a página) também mostra a falha.
      const [aberta] = (await (await t.as(bruno).get(`/api/channels/${geral.id}/executions`)).json()) as ExecutionDto[];
      expect(aberta!.tools[0]).toMatchObject({ state: "failed", reason: "não terminou em 30 s" });
    },
    LONGO,
  );

  test(
    "a Ferramenta que falha devolve o motivo ao modelo e a resposta segue com ele",
    async () => {
      const quebrada = ferramentaDeTeste({
        id: "consultar_arquivo",
        falha: new ToolFailure("o arquivo está fora do ar"),
      });
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, quebrada.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(bruno);

      t.anthropic.reply({ toolUse: [{ name: "consultar_arquivo" }] }, { text: "O arquivo está fora do ar agora." });
      const origem = await enviar(t, geral.id, "@Faro acha o contrato de 2019?");
      const falhou = await andamento(aba, origem, (e) => e.tools[0]?.state === "failed");
      expect(falhou.tools[0]!.reason).toBe("o arquivo está fora do ar");
      expect((await respostaA(t, geral.id, origem)).body).toBe("O arquivo está fora do ar agora.");
      expect(toolResults(respostas(t)[1]!.body)[0]).toMatchObject({
        is_error: true,
        content: "A Ferramenta consultar o arquivo falhou: o arquivo está fora do ar.",
      });
    },
    LONGO,
  );
});

describe("custo", () => {
  test(
    "o uso e o custo de todos os turnos somam no orçamento do Agente",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
      // No Sonnet (US$ 2 / US$ 10 por milhão), US$ 2,00 exatos por turno.
      const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };

      t.anthropic.reply(
        { toolUse: [{ name: "listar_agentes" }], usage: DOIS_DOLARES },
        { text: "Fala com a Sophya.", usage: DOIS_DOLARES },
      );
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem cuida de contratos?"));

      const lista: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      expect(lista.find((a) => a.id === faro.id)?.keySpendUsd).toBeCloseTo(4, 6);
    },
    LONGO,
  );
});
