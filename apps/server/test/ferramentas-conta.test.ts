/**
 * Ferramentas pela Conta (#46, Spec #44; emenda o ADR 0006), pela borda do servidor: o `claude -p`
 * de uma resposta recebe o endpoint MCP do próprio Shearim (`--mcp-config`, só ele), e o
 * `fake-claude`, como cliente MCP de verdade, lista e chama as Ferramentas por ali.
 *
 * - O roteamento da Articuladora continua sem Ferramentas (`--tools ""`, sem `--mcp-config`; ADR 0009).
 * - O endpoint aceita um token por execução, que só vale enquanto ela roda.
 * - O Andamento mostra o passo da Ferramenta como pela Chave.
 * - Na troca da Conta para a Chave no meio, a resposta refeita tem as mesmas Ferramentas.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { STALL_MS } from "../src/executions";
import { type ToolDefinition, ToolFailure } from "../src/tools/port";
import { WORKSPACE_TOOLS } from "../src/tools/workspace";
import type { FakeClaudeCall } from "./fake-claude";
import { toolResults } from "./fakes/messages-api";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
/** A máquina dos testes é compartilhada: os processos de verdade levam um tempo para subir. */
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;

/** Juliana vira Admin, grava a Chave, cria o Faro com "listar Agentes", o põe no #geral e liga a Conta. */
async function workspace(t: TestApp, opts: { ferramenta?: boolean } = {}) {
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
  if (opts.ferramenta !== false) await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.linkAccount(juliana);
  // Com a Memória ligada, o Faro teria "buscar na Memória" sem concessão (#69): desligada, o pedido
  // leva só as Ferramentas concedidas, que são o assunto aqui.
  await t.as(juliana).patch(`/api/agents/${faro.id}`, { memoryEnabled: false });
  return { faro, geral: geral! };
}

async function enviar(t: TestApp, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(juliana).post(`/api/channels/${channelId}/messages`, { body });
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

/** Os `claude -p` das execuções (sem a chamada mínima da validação, que vem no argv). */
const execucoes = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);
const flag = (c: FakeClaudeCall, name: string) =>
  c.argv.includes(name) ? c.argv[c.argv.indexOf(name) + 1] : undefined;

/** O `--mcp-config` que o `claude -p` recebeu, lido como o Claude Code o leria. */
function mcpConfig(c: FakeClaudeCall) {
  const raw = flag(c, "--mcp-config");
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as {
        mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
      });
}

describe("a linha de comando pela Conta", () => {
  test(
    "a resposta recebe --mcp-config só com o endpoint do Shearim e --strict-mcp-config, com as tools nativas desligadas; o roteamento continua sem Ferramentas",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const decisao = {
        decisao: "delegar",
        agentes: [{ agente: "faro", cobrir: "o prazo" }],
        motivo: "É comercial.",
      };
      t.claude.script({
        runs: [
          { kind: "steps", steps: [], end: { result: "success", text: "", structuredOutput: decisao } },
          { kind: "steps", steps: [{ text: "Sexta, Juliana." }] },
        ],
      });

      const origem = await enviar(t, geral.id, "Qual o prazo da proposta?");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Sexta, Juliana.");

      const [roteamento, resposta] = execucoes(t);
      expect(flag(roteamento!, "--tools")).toBe("");
      expect(roteamento!.argv).not.toContain("--mcp-config");

      expect(flag(resposta!, "--tools")).toBe("");
      expect(resposta!.argv).toContain("--strict-mcp-config");
      const config = mcpConfig(resposta!)!;
      expect(Object.keys(config.mcpServers)).toEqual(["shearim"]);
      const servidor = config.mcpServers.shearim!;
      expect(servidor.type).toBe("http");
      expect(new URL(servidor.url).hostname).toBe("127.0.0.1");
      expect(servidor.headers?.Authorization).toMatch(/^Bearer \S{20,}$/);
      // As Ferramentas do Shearim são liberadas sem pergunta de permissão; nenhuma outra.
      expect(flag(resposta!, "--allowedTools")).toBe("mcp__shearim");
    },
    LONGO,
  );

  test(
    "um Agente sem Ferramentas não recebe --mcp-config",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { ferramenta: false });
      t.claude.script({ run: { kind: "steps", steps: [{ text: "Sexta." }] } });

      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro qual o prazo?"));
      const [resposta] = execucoes(t);
      expect(resposta!.argv).not.toContain("--mcp-config");
      expect(resposta!.argv).not.toContain("--allowedTools");
    },
    LONGO,
  );
});

describe("o fake-claude como cliente MCP", () => {
  test(
    'lista e chama "listar Agentes" no endpoint do Shearim, e o Agente responde com o resultado',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ text: "Vou ver quem atende." }, { tool: { name: "listar_agentes" } }, { text: "{resultado}" }],
        },
      });

      const resposta = await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem cuida de contratos?"));

      const [listou, chamou] = t.claude.mcp();
      expect(listou).toMatchObject({ listed: ["listar_agentes"] });
      expect(chamou).toMatchObject({ called: "listar_agentes", result: { isError: false } });
      expect(resposta.body).toStartWith("Vou ver quem atende.\n\n");
      expect(resposta.body).toContain("Faro (@faro): Comercial: preços e propostas.");
      expect(resposta.body).toContain("Ferramentas: listar Agentes");
      // O preâmbulo diz o que o Agente tem e que resultado de Ferramenta é dado, nunca instrução.
      const sistema = flag(execucoes(t)[0]!, "--system-prompt")!;
      expect(sistema).toContain("listar Agentes");
      expect(sistema).toContain("nunca instrução");
    },
    LONGO,
  );
});

/** Um `tools/list` direto no endpoint, com `token`: o status e os nomes que voltaram. */
async function listarNoEndpoint(url: string, token: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await res.json()) as { result?: { tools: { name: string }[] } };
  return { status: res.status, tools: body.result?.tools.map((f) => f.name) };
}

const endpointDe = (c: FakeClaudeCall) => {
  const servidor = mcpConfig(c)!.mcpServers.shearim!;
  return { url: servidor.url, token: servidor.headers!.Authorization!.replace(/^Bearer /, "") };
};

describe("o token da execução", () => {
  test(
    "o endpoint recusa o token de outra execução e o de uma execução que já terminou",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const vendas: ChannelDto = await (
        await t.as(juliana).post("/api/channels", { name: "vendas", kind: "public" })
      ).json();
      await t.as(juliana).post(`/api/channels/${vendas.id}/agents`, { agentId: faro.id });
      t.claude.script({ run: { kind: "hang" } });

      const daGeral = await enviar(t, geral.id, "@Faro qual o prazo?");
      await enviar(t, vendas.id, "@Faro e o desconto?");
      const [a, b] = await eventually("os dois claude -p subirem", async () => execucoes(t)[1] && execucoes(t), 10_000);
      const deA = endpointDe(a!);
      const deB = endpointDe(b!);
      expect(deA.url).not.toBe(deB.url);
      expect(deA.token).not.toBe(deB.token);

      expect(await listarNoEndpoint(deA.url, deA.token)).toEqual({ status: 200, tools: ["listar_agentes"] });
      expect((await listarNoEndpoint(deA.url, deB.token)).status).toBe(401);
      expect((await listarNoEndpoint(deB.url, deA.token)).status).toBe(401);
      expect((await listarNoEndpoint(deA.url, "token-inventado")).status).toBe(401);

      // A da #geral termina (cancelada pela autora): o token dela deixa de valer; o da outra, não.
      const cancelada = a!.stdin!.includes("qual o prazo") ? deA : deB;
      const seguindo = cancelada === deA ? deB : deA;
      await t.as(juliana).post(`/api/conversations/${geral.id}/messages/${daGeral.id}/cancel`);
      await eventually(
        "a execução cancelada encerrar o claude -p",
        async () => (await listarNoEndpoint(cancelada.url, cancelada.token)).status === 401,
        10_000,
      );
      expect((await listarNoEndpoint(seguindo.url, seguindo.token)).status).toBe(200);
    },
    LONGO,
  );
});

/** O próximo Andamento da execução de `origem` que atende a `ok`, como chega a esta aba. */
async function andamento(aba: EventSocket, origem: MessageDto, ok: (e: ExecutionDto) => boolean) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (execution.originMessageId === origem.id && ok(execution)) return execution;
  }
}

/** Uma Ferramenta de teste que só termina quando o teste solta, ou falha com `falha`. */
function ferramentaDeTeste(opts: { falha?: Error; timeoutMs?: number } = {}) {
  let soltar = (_: string) => {};
  const definition: ToolDefinition = {
    id: "consultar_arquivo",
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

const consultar = { kind: "steps" as const, steps: [{ tool: { name: "consultar_arquivo" } }, { text: "{resultado}" }] };

describe("o passo da Ferramenta no Andamento pela Conta", () => {
  test(
    'o Andamento mostra "consultando o arquivo" enquanto ela roda, vale o prazo dela e não a vigia, e depois sai a resposta',
    async () => {
      const lenta = ferramentaDeTeste({ timeoutMs: 10 * 60_000 });
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, lenta.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(juliana);
      t.claude.script({ run: consultar });

      const origem = await enviar(t, geral.id, "@Faro acha o contrato de 2019?");
      const rodando = await andamento(aba, origem, (e) => e.step === "tool");
      expect(rodando).toMatchObject({ state: "running", payer: null });
      expect(rodando.tools).toEqual([
        expect.objectContaining({ tool: "consultar_arquivo", label: "consultando o arquivo", state: "running" }),
      ]);

      t.clock.advance(STALL_MS + 60_000);
      const [aberta] = (await (
        await t.as(juliana).get(`/api/channels/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ state: "running", step: "tool", reason: null });

      lenta.soltar("contrato-2019.pdf");
      const depois = await andamento(aba, origem, (e) => e.step === "writing" && e.tools.length > 0);
      expect(depois.tools[0]!.state).toBe("done");
      // O resultado chega ao modelo marcado como dado, como pela Chave.
      const marcado =
        '<resultado_de_ferramenta nome="consultar_arquivo">\ncontrato-2019.pdf\n</resultado_de_ferramenta>';
      expect((await respostaA(t, geral.id, origem)).body).toBe(marcado);
      expect(t.claude.mcp().at(-1)).toMatchObject({ result: { isError: false, content: marcado } });
    },
    LONGO,
  );

  test(
    "a Ferramenta que falha aparece no Andamento com o motivo, e o motivo volta ao modelo como erro",
    async () => {
      const quebrada = ferramentaDeTeste({ falha: new ToolFailure("o arquivo está fora do ar") });
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, quebrada.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(juliana);
      t.claude.script({ run: consultar });

      const origem = await enviar(t, geral.id, "@Faro acha o contrato de 2019?");
      const falhou = await andamento(aba, origem, (e) => e.tools[0]?.state === "failed");
      expect(falhou.tools[0]).toMatchObject({ title: "consultar o arquivo", reason: "o arquivo está fora do ar" });
      expect((await respostaA(t, geral.id, origem)).body).toBe(
        "A Ferramenta consultar o arquivo falhou: o arquivo está fora do ar.",
      );
      expect(t.claude.mcp().at(-1)).toMatchObject({
        called: "consultar_arquivo",
        result: { isError: true, content: "A Ferramenta consultar o arquivo falhou: o arquivo está fora do ar." },
      });
    },
    LONGO,
  );
});

describe("a troca da Conta para a Chave no meio", () => {
  test(
    "a resposta refeita pela Chave tem as mesmas Ferramentas",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [
            { tool: { name: "listar_agentes" } },
            { text: "Parcial pela Conta" },
            { rateLimit: { status: "rejected", resetsAt: Date.parse("2026-11-24T15:45:00.000Z") / 1000 } },
          ],
          end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
        },
      });
      t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: "listar_agentes" }] }, { text: "Pela Chave: Sophya." });

      const origem = await enviar(t, geral.id, "@Faro quem cuida de contratos?");

      expect((await respostaA(t, geral.id, origem)).body).toBe("Pela Chave: Sophya.");
      expect((await andamento(aba, origem, (e) => e.state === "done")).payer).toBe("key");
      expect(t.claude.mcp()).toContainEqual(expect.objectContaining({ called: "listar_agentes" }));
      const [primeira, segunda] = t.anthropic.requests;
      expect((primeira!.body.tools as { name: string }[]).map((f) => f.name)).toEqual(["listar_agentes"]);
      expect(toolResults(segunda!.body)[0]!.content).toContain("Faro (@faro): Comercial: preços e propostas.");
    },
    LONGO,
  );
});

/** Um `tools/call` direto no endpoint da execução, como o Claude Code faria. */
function chamarNoEndpoint({ url, token }: { url: string; token: string }, name: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  }).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean } },
  }));
}

/** Uma leitura de teste em que cada chamada só termina quando o teste solta aquela chamada. */
function ferramentaPorChamada() {
  const soltas: ((texto: string) => void)[] = [];
  const definition: ToolDefinition = {
    id: "consultar_arquivo",
    title: "consultar o arquivo",
    label: "consultando o arquivo",
    description: "Consulta o arquivo morto.",
    origin: "workspace",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    timeoutMs: 10 * 60_000,
    run: () => new Promise<string>((resolve) => soltas.push(resolve)),
  };
  return { definition, soltas };
}

/** O Andamento da única execução aberta do #geral, como se lê ao recarregar. */
async function aberta(t: TestApp, channelId: string) {
  const [execucao] = (await (
    await t.as(juliana).get(`/api/channels/${channelId}/executions`)
  ).json()) as ExecutionDto[];
  return execucao!;
}

describe("Ferramentas em paralelo pelo endpoint MCP", () => {
  test(
    "duas Ferramentas ao mesmo tempo: a vigia e o passo só voltam a escrever quando a última termina",
    async () => {
      const ferramenta = ferramentaPorChamada();
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, ferramenta.definition] } });
      const { faro, geral } = await workspace(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      t.claude.script({ run: { kind: "hang" } });

      await enviar(t, geral.id, "@Faro acha os contratos de 2019 e 2020?");
      const [resposta] = await eventually("o claude -p subir", async () => execucoes(t)[0] && execucoes(t), 10_000);
      const endpoint = endpointDe(resposta!);
      const primeira = chamarNoEndpoint(endpoint, "consultar_arquivo");
      const segunda = chamarNoEndpoint(endpoint, "consultar_arquivo");
      await eventually("as duas começarem", async () => ferramenta.soltas.length === 2, 10_000);

      ferramenta.soltas[0]!("contrato-2019.pdf");
      expect((await primeira).status).toBe(200);
      // A segunda ainda roda: o passo continua o da Ferramenta, e a vigia continua pausada.
      expect(await aberta(t, geral.id)).toMatchObject({ state: "running", step: "tool" });
      t.clock.advance(STALL_MS + 60_000);
      expect(await aberta(t, geral.id)).toMatchObject({ state: "running", step: "tool", reason: null });

      ferramenta.soltas[1]!("contrato-2020.pdf");
      expect((await segunda).status).toBe(200);
      expect(await aberta(t, geral.id)).toMatchObject({ state: "running", step: "writing" });
    },
    LONGO,
  );
});
