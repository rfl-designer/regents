/**
 * Pedido de aprovação pela Conta (#51, ADR 0011), pela borda do servidor: a escrita chamada pelo
 * endpoint MCP do Shearim interrompe o `claude -p`.
 *
 * - A escrita cria o Pedido, e o processo é encerrado pelo caminho do cancelamento (`SIGINT`, e só
 *   depois `SIGTERM` e `SIGKILL`). A execução termina em "esperando aprovação", não em cancelada.
 * - A continuação depois da decisão roda num `claude -p` novo, pela mesma tabela de quem paga.
 * - O token da execução deixa de valer no endpoint quando ela termina.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ApprovalRequestDto, ChannelDto, ExecutionDto, MessageDto } from "@regents/contracts";
import type { FakeClaudeCall, FakeRun } from "./fake-claude";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;

/**
 * Juliana vira Admin, grava a Chave, cria o Faro com "postar mensagem", o põe no #geral e no
 * #anuncios e liga a Conta: as respostas a ela saem pela Conta.
 */
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
  expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/postar_mensagem`)).status).toBe(200);
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  const anuncios: ChannelDto = await (
    await t.as(juliana).post("/api/channels", { name: "anuncios", kind: "public" })
  ).json();
  for (const c of [geral!, anuncios]) await t.as(juliana).post(`/api/channels/${c.id}/agents`, { agentId: faro.id });
  await t.linkAccount(juliana);
  return { faro, geral: geral!, anuncios };
}

async function enviar(t: TestApp, channelId: string, body: string): Promise<MessageDto> {
  const res = await t.as(juliana).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function mensagens(t: TestApp, channelId: string): Promise<MessageDto[]> {
  return (await t.as(juliana).get(`/api/conversations/${channelId}/messages`)).json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => (await mensagens(t, channelId)).find((m) => m.originMessageId === origem.id),
    10_000,
  );
}

async function pedidoPendente(t: TestApp, channelId: string) {
  return eventually(
    "o Pedido aparecer",
    async () => {
      const lista: ApprovalRequestDto[] = await (
        await t.as(juliana).get(`/api/conversations/${channelId}/approvals`)
      ).json();
      return lista[0]?.state === "pending" && lista[0];
    },
    10_000,
  );
}

async function andamento(aba: EventSocket, origem: MessageDto, ok: (e: ExecutionDto) => boolean) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (execution.originMessageId === origem.id && ok(execution)) return execution;
  }
}

/** Os `claude -p` das execuções (sem a chamada mínima da validação, que vem no argv). */
const execucoes = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);
const flag = (c: FakeClaudeCall, name: string) =>
  c.argv.includes(name) ? c.argv[c.argv.indexOf(name) + 1] : undefined;

/** O endpoint e o token que o `claude -p` recebeu no `--mcp-config`. */
function endpointDe(c: FakeClaudeCall) {
  const servidor = (
    JSON.parse(flag(c, "--mcp-config")!) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    }
  ).mcpServers.regents!;
  return { url: servidor.url, token: servidor.headers.Authorization!.replace(/^Bearer /, "") };
}

/** Um `tools/list` direto no endpoint: o status que voltou. */
async function listarNoEndpoint({ url, token }: { url: string; token: string }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

/** Se o processo `pid` ainda existe. */
function vivo(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * O modelo escreve, pede para postar no #anuncios e, se o processo não fosse encerrado, seguiria
 * escrevendo (o `hang` é o turno seguinte que nunca termina).
 */
const postar = (reacao: Pick<FakeRun, "onSigint" | "onSigterm"> = {}): FakeRun => ({
  kind: "steps",
  steps: [
    { text: "Vou avisar lá." },
    { tool: { name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou para 15h." } } },
    { hang: true },
  ],
  ...reacao,
});

describe("a escrita pelo MCP vira Pedido de aprovação", () => {
  test(
    "o Pedido nasce, o claude -p leva SIGINT e a execução termina esperando aprovação, sem o texto parcial",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({ run: postar() });

      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");

      const esperando = await andamento(aba, origem, (e) => e.state === "awaiting_approval");
      // Pela Conta da autora (`payer` nulo é a Conta; a Chave seria "key").
      expect(esperando).toMatchObject({ payer: null, step: null, reason: null });
      const { approval } = await aba.next("approval.created", ESPERA);
      expect(approval).toMatchObject({
        executionId: esperando.id,
        tool: "postar_mensagem",
        summary: "Postar em #anuncios: “A reunião mudou para 15h.”",
        state: "pending",
      });

      const [processo] = execucoes(t);
      await eventually("o claude -p sair", async () => !vivo(processo!.pid), 10_000);
      expect(t.claude.signals(processo!.pid).map((s) => s.signal)).toEqual(["SIGINT"]);

      // Nem cancelada nem falha: continua esperando, e o parcial ("Vou avisar lá.") não vira resposta.
      const [aberta] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ id: esperando.id, state: "awaiting_approval", reason: null });
      expect((await mensagens(t, geral.id)).some((m) => m.originMessageId === origem.id)).toBe(false);
    },
    LONGO,
  );

  test(
    "um claude -p que ignora o SIGINT leva SIGTERM depois, e um que ignora o SIGTERM, SIGKILL; a execução continua esperando aprovação",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({ run: postar({ onSigint: "ignore", onSigterm: "ignore" }) });

      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");

      await andamento(aba, origem, (e) => e.state === "awaiting_approval");
      const [processo] = execucoes(t);
      await eventually("o claude -p sair", async () => !vivo(processo!.pid), 10_000);
      // O SIGKILL não se registra (não dá para tratá-lo): o processo saiu depois dos outros dois.
      expect(t.claude.signals(processo!.pid).map((s) => s.signal)).toEqual(["SIGINT", "SIGTERM"]);

      const [aberta] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ state: "awaiting_approval", reason: null });
      expect(await pedidoPendente(t, geral.id)).toMatchObject({ tool: "postar_mensagem" });
    },
    LONGO,
  );
});

describe("o token da execução", () => {
  test(
    "deixa de valer no endpoint quando a execução termina em esperando aprovação",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({ run: postar() });

      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");
      await andamento(aba, origem, (e) => e.state === "awaiting_approval");

      const endpoint = endpointDe(execucoes(t)[0]!);
      await eventually("o token deixar de valer", async () => (await listarNoEndpoint(endpoint)) === 401, 10_000);
    },
    LONGO,
  );
});

describe("a continuação depois da decisão", () => {
  test(
    "na aprovação, a continuação roda num claude -p novo, pela Conta da autora, com outro token e sabendo do resultado",
    async () => {
      const t = await testApp();
      const { geral, anuncios } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({ runs: [postar()], run: { kind: "steps", steps: [{ text: "Pronto, avisei no #anuncios." }] } });

      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");
      const pedido = await pedidoPendente(t, geral.id);
      const [primeira] = execucoes(t);
      await eventually("o primeiro claude -p sair", async () => !vivo(primeira!.pid), 10_000);

      const aprovado = await t.as(juliana).post(`/api/conversations/${geral.id}/approvals/${pedido.id}/approve`);
      expect(aprovado.status).toBe(200);

      const resposta = await respostaA(t, geral.id, origem);
      expect(resposta.body).toBe("Pronto, avisei no #anuncios.");
      expect((await mensagens(t, anuncios.id)).map((m) => m.body)).toContain("A reunião mudou para 15h.");

      const continuacao = await andamento(aba, origem, (e) => e.state === "done" && e.id !== pedido.executionId);
      expect(continuacao.payer).toBeNull();
      const [, segunda] = execucoes(t);
      expect(segunda!.pid).not.toBe(primeira!.pid);
      expect(endpointDe(segunda!).token).not.toBe(endpointDe(primeira!).token);
      // A continuação sabe o que pediu e o que a autora decidiu (ADR 0011).
      expect(segunda!.stdin).toContain("A reunião mudou para 15h.");
      expect(segunda!.stdin).toContain("Juliana aprovou, e o Regents fez:");
      expect(t.anthropic.requests).toHaveLength(0);
    },
    LONGO,
  );

  test(
    "a continuação decide de novo quem paga: com a Conta desligada na espera, sai pela Chave",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(juliana);
      t.claude.script({ runs: [postar()] });
      t.anthropic.reply({ text: "Pronto, avisei pela Chave." });

      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");
      const pedido = await pedidoPendente(t, geral.id);
      const [primeira] = execucoes(t);
      await eventually("o primeiro claude -p sair", async () => !vivo(primeira!.pid), 10_000);

      expect((await t.as(juliana).delete("/api/account")).status).toBe(200);
      expect((await t.as(juliana).post(`/api/conversations/${geral.id}/approvals/${pedido.id}/approve`)).status).toBe(
        200,
      );

      expect((await respostaA(t, geral.id, origem)).body).toBe("Pronto, avisei pela Chave.");
      const continuacao = await andamento(aba, origem, (e) => e.state === "done" && e.id !== pedido.executionId);
      expect(continuacao.payer).toBe("key");
      expect(execucoes(t)).toHaveLength(1);
    },
    LONGO,
  );
});
