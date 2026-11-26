/**
 * Ler a web (#49, Spec #44): "buscar na web" e "abrir URL", nos dois cérebros, pela borda do servidor.
 *
 * - O Admin concede as duas por Agente, como qualquer Ferramenta (origem "web", só leitura).
 * - Pela Chave, o pedido leva as server tools da Messages API só quando concedidas, e os blocos
 *   `server_tool_use` viram passos no Andamento ("buscando na web", "abrindo <domínio>").
 * - Pela Conta, o argv liga só o WebSearch e o WebFetch concedidos e nenhuma tool nativa quando
 *   não; com uma Ferramenta da porta na mesma resposta, o WebFetch não liga (ele abriria uma URL
 *   montada com o dado lido); os blocos de tool no `stream-json` viram passos no Andamento.
 * - O custo das buscas pela Chave entra no orçamento do Agente.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, AgentToolDto, ChannelDto, ExecutionDto, MessageDto, ToolCallDto } from "@regents/contracts";
import { STALL_MS } from "../src/executions";
import type { FakeClaudeCall } from "./fake-claude";
import type { RecordedRequest } from "./fakes/messages-api";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral; Bruno entra (sem Conta: paga a Chave). */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial: preços e propostas.",
      instructions: "Você é o Faro, do comercial.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  // Com a Memória ligada, o Faro teria "buscar na Memória" sem concessão (#69): desligada, o pedido
  // leva só as Ferramentas concedidas, que são o assunto aqui.
  await t.as(juliana).patch(`/api/agents/${faro.id}`, { memoryEnabled: false });
  return { faro, geral: geral! };
}

async function conceder(t: TestApp, agentId: string, ...ids: string[]) {
  for (const id of ids) expect((await t.as(juliana).put(`/api/agents/${agentId}/tools/${id}`)).status).toBe(200);
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

describe("concessão das Ferramentas da web", () => {
  test(
    'o Admin vê "buscar na web" e "abrir URL" (da web, só leitura) e concede cada uma por Agente; todo Membro as vê na lista de Agentes',
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);

      const antes: AgentToolDto[] = await (await t.as(juliana).get(`/api/agents/${faro.id}/tools`)).json();
      expect(antes.filter((f) => f.origin === "web")).toEqual([
        expect.objectContaining({ id: "buscar_na_web", title: "buscar na web", access: "read", granted: false }),
        expect.objectContaining({ id: "abrir_url", title: "abrir URL", access: "read", granted: false }),
      ]);

      await conceder(t, faro.id, "buscar_na_web");
      const lista: AgentDto[] = await (await t.as(bruno).get("/api/agents")).json();
      expect(lista.find((a) => a.id === faro.id)?.tools).toEqual([
        { id: "buscar_na_web", title: "buscar na web", origin: "web" },
      ]);
      expect((await t.as(bruno).put(`/api/agents/${faro.id}/tools/abrir_url`)).status).toBe(403);
    },
    LONGO,
  );
});

/** As chamadas de resposta (sem o roteamento da Articuladora) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
const ferramentasDo = (req: RecordedRequest) => (req.body.tools as Record<string, unknown>[] | undefined) ?? [];

describe("pela Chave", () => {
  test(
    "o pedido leva as server tools da web só quando concedidas, e nunca como client tools",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro qual o preço do concorrente?"));
      expect(respostas(t)[0]!.body).not.toHaveProperty("tools");

      await conceder(t, faro.id, "buscar_na_web");
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro e agora?"));
      expect(ferramentasDo(respostas(t)[1]!)).toEqual([{ type: "web_search_20260209", name: "web_search" }]);

      await conceder(t, faro.id, "abrir_url");
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro e a página https://exemplo.com/precos?"));
      expect(ferramentasDo(respostas(t)[2]!)).toEqual([
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
      ]);
      expect(respostas(t)[2]!.body.system).toContain("abrir URL");
    },
    LONGO,
  );
});

/** Os usos de Ferramenta de cada Andamento de `origem` que chegou à aba, na ordem, até o fim da execução. */
async function usos(aba: EventSocket, origem: MessageDto): Promise<ToolCallDto[][]> {
  const deOrigem = () =>
    aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
  await eventually("o Andamento terminar", async () => deOrigem().find((e) => e.state === "done"), 10_000);
  return deOrigem().map((e) => e.tools);
}

describe("pela Chave, os passos no Andamento", () => {
  test(
    'cada server_tool_use vira um passo: "buscando na web" e "abrindo <domínio>", com o motivo da falha',
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await conceder(t, faro.id, "buscar_na_web", "abrir_url");
      const aba = await t.socket(juliana);

      t.anthropic.reply({
        delayMs: 20,
        serverToolUse: [
          { name: "web_search", input: { query: "preço do concorrente" } },
          { name: "web_fetch", input: { url: "https://www.exemplo.com/precos" }, error: "url_not_accessible" },
        ],
        text: "O concorrente cobra R$ 90.",
      });
      const origem = await enviar(t, geral.id, "@Faro qual o preço do concorrente? https://www.exemplo.com/precos");
      expect((await respostaA(t, geral.id, origem)).body).toBe("O concorrente cobra R$ 90.");

      const vistos = await usos(aba, origem);
      expect(vistos).toContainEqual([
        expect.objectContaining({ tool: "buscar_na_web", label: "buscando na web", state: "running" }),
      ]);
      expect(vistos).toContainEqual([
        expect.objectContaining({ tool: "buscar_na_web", state: "done" }),
        expect.objectContaining({
          tool: "abrir_url",
          title: "abrir URL",
          label: "abrindo exemplo.com",
          state: "running",
        }),
      ]);
      expect(vistos.at(-1)).toEqual([
        expect.objectContaining({ tool: "buscar_na_web", state: "done", reason: null }),
        expect.objectContaining({ tool: "abrir_url", state: "failed", reason: "a página não abriu" }),
      ]);
      // As server tools não voltam ao Shearim: uma chamada só.
      expect(respostas(t)).toHaveLength(1);
    },
    LONGO,
  );
});

describe("pela Chave, o custo", () => {
  test(
    "cada busca na web (US$ 10 por mil) soma no orçamento do Agente, junto com os tokens de todos os turnos",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await conceder(t, faro.id, "buscar_na_web", "listar_agentes");
      // No Sonnet (US$ 2 / US$ 10 por milhão), US$ 2,00 exatos por turno.
      const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };
      const busca = (query: string) => ({ name: "web_search" as const, input: { query } });

      t.anthropic.reply(
        { serverToolUse: [busca("a"), busca("b")], toolUse: [{ name: "listar_agentes" }], usage: DOIS_DOLARES },
        {
          serverToolUse: [busca("c"), { ...busca("d"), error: "too_many_requests" }],
          text: "Achei.",
          usage: DOIS_DOLARES,
        },
      );
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro pesquisa o concorrente"));

      // Três buscas feitas (a que deu erro não conta): US$ 0,03.
      const lista: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      expect(lista.find((a) => a.id === faro.id)?.keySpendUsd).toBeCloseTo(4.03, 6);
    },
    LONGO,
  );
});

describe("pela Chave, a pausa do lado da Anthropic", () => {
  test(
    "um turno que para em pause_turn é retomado com o que o modelo já fez, e a resposta sai inteira",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await conceder(t, faro.id, "buscar_na_web");

      t.anthropic.reply(
        { serverToolUse: [{ name: "web_search", input: { query: "a" } }], text: "Buscando.", stopReason: "pause_turn" },
        { text: "Achei." },
      );
      const origem = await enviar(t, geral.id, "@Faro pesquisa o concorrente");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Buscando.\n\nAchei.");

      const [, retomada] = respostas(t);
      // A retomada manda o turno do modelo como veio, sem resultado do Shearim depois dele.
      expect(retomada!.body.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [
          { type: "server_tool_use", name: "web_search" },
          { type: "web_search_tool_result" },
          { type: "text" },
        ],
      });
    },
    LONGO,
  );
});

/** Os `claude -p` das execuções (sem a chamada mínima da validação, que vem no argv). */
const execucoes = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);
const flag = (c: FakeClaudeCall, name: string) =>
  c.argv.includes(name) ? c.argv[c.argv.indexOf(name) + 1] : undefined;

describe("pela Conta, a linha de comando", () => {
  test(
    "o argv liga só o WebSearch e o WebFetch concedidos, e nenhuma tool nativa quando não; com Ferramenta da porta, o WebFetch não liga; o endpoint MCP só vai com Ferramentas da porta e nunca lista as da web",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.linkAccount(bruno);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro sem Ferramentas"));
      const [nenhuma] = execucoes(t);
      expect(flag(nenhuma!, "--tools")).toBe("");
      expect(nenhuma!.argv).not.toContain("--allowedTools");

      await conceder(t, faro.id, "buscar_na_web");
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro só a busca"));
      const busca = execucoes(t)[1]!;
      expect(flag(busca, "--tools")).toBe("WebSearch");
      expect(flag(busca, "--allowedTools")).toBe("WebSearch");
      expect(busca.argv).not.toContain("--mcp-config");
      expect(busca.argv).toContain("--strict-mcp-config");

      await conceder(t, faro.id, "abrir_url");
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro só a web"));
      const web = execucoes(t)[2]!;
      expect(flag(web, "--tools")).toBe("WebSearch,WebFetch");
      expect(flag(web, "--allowedTools")).toBe("WebSearch,WebFetch");
      expect(flag(web, "--system-prompt")).not.toContain("abrir URL não está disponível");

      // Com uma Ferramenta da porta, o WebFetch não liga: ele abriria uma URL montada com o dado lido.
      await conceder(t, faro.id, "listar_agentes");
      t.claude.script({ run: { kind: "steps", steps: [{ tool: { name: "listar_agentes" } }, { text: "Pronto." }] } });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro tudo"));
      const tudo = execucoes(t)[3]!;
      expect(flag(tudo, "--tools")).toBe("WebSearch");
      expect(flag(tudo, "--allowedTools")).toBe("mcp__regents,WebSearch");
      expect(flag(tudo, "--system-prompt")).toContain("abrir URL não está disponível");
      expect(t.claude.mcp()).toContainEqual({ pid: tudo.pid, listed: ["listar_agentes"] });
    },
    LONGO,
  );
});

describe("pela Conta, os passos no Andamento", () => {
  test(
    "os blocos de WebSearch e WebFetch no stream-json viram passos, com o motivo da falha; o modelo segue com o resultado",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.linkAccount(bruno);
      await conceder(t, faro.id, "buscar_na_web", "abrir_url");
      const aba = await t.socket(juliana);

      t.claude.script({
        run: {
          kind: "steps",
          steps: [
            { native: { name: "WebSearch", input: { query: "preço do concorrente" } } },
            { text: "{resultado}" },
            {
              native: {
                name: "WebFetch",
                input: { url: "https://www.exemplo.com/precos", prompt: "Qual o preço?" },
                error: "Request failed with status code 404",
              },
            },
            { text: "Não abriu." },
          ],
        },
      });
      const origem = await enviar(t, geral.id, "@Faro qual o preço? https://www.exemplo.com/precos");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Resultado de WebSearch.\n\nNão abriu.");

      const vistos = await usos(aba, origem);
      expect(vistos).toContainEqual([
        expect.objectContaining({ tool: "buscar_na_web", label: "buscando na web", state: "running" }),
      ]);
      expect(vistos).toContainEqual([
        expect.objectContaining({ tool: "buscar_na_web", state: "done" }),
        expect.objectContaining({ tool: "abrir_url", label: "abrindo exemplo.com", state: "running" }),
      ]);
      // O motivo é neutro: a Conta é só do autor, e o Andamento é de todos.
      expect(vistos.at(-1)).toEqual([
        expect.objectContaining({ tool: "buscar_na_web", state: "done", reason: null }),
        expect.objectContaining({ tool: "abrir_url", state: "failed", reason: "a página não abriu" }),
      ]);
    },
    LONGO,
  );
});

describe("o prazo das Ferramentas da web", () => {
  test(
    "enquanto ela roda vale o prazo dela, não a vigia; passado o prazo, o uso falha com o motivo e a vigia volta a contar",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.linkAccount(bruno);
      await conceder(t, faro.id, "abrir_url");
      const aba = await t.socket(juliana);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ native: { name: "WebFetch", input: { url: "https://lenta.com.br/" }, hang: true } }],
        },
      });

      const origem = await enviar(t, geral.id, "@Faro abre https://lenta.com.br/");
      const deOrigem = async () => {
        const lista: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
        return lista.find((e) => e.originMessageId === origem.id)!;
      };
      for (;;) {
        const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
        if (execution.originMessageId === origem.id && execution.step === "tool") break;
      }
      expect((await deOrigem()).tools).toEqual([
        expect.objectContaining({ tool: "abrir_url", label: "abrindo lenta.com.br", state: "running" }),
      ]);

      // Passa dos 2 minutos da vigia: o prazo da Ferramenta (60 s) vence antes, e a resposta segue aberta.
      t.clock.advance(STALL_MS + 1_000);
      const vencida = await eventually("o uso falhar", async () => {
        const e = await deOrigem();
        return e.tools[0]?.state === "failed" ? e : undefined;
      });
      expect(vencida).toMatchObject({ state: "running", step: "writing" });
      expect(vencida.tools[0]!.reason).toBe("não terminou em 60 s");

      // Sem nada depois, a vigia encerra como sempre.
      t.clock.advance(STALL_MS);
      const parada = await eventually("a vigia encerrar", async () => {
        const e = await deOrigem();
        return e.state === "running" ? undefined : e;
      });
      expect(parada.reason).toBe("ficou 2 minutos sem escrever nada");
    },
    LONGO,
  );
});
