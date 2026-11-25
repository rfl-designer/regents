/**
 * Conector MCP com credencial do Workspace (#54, Spec #44), pela borda do servidor, com um servidor
 * MCP remoto falso no papel do sistema de fora (o "CRM").
 *
 * - O Admin adiciona o Conector com nome, endereço e token; o token fica cifrado e nunca volta.
 * - O catálogo vem do `tools/list` do servidor: só o que tem `readOnlyHint` é leitura.
 * - As Ferramentas concedidas chegam ao Agente pelos dois cérebros, e as chamadas passam pelo
 *   Shearim (a Chave chama a porta; a Conta chama o endpoint MCP do Shearim, nunca o servidor).
 * - A descrição pública do Agente ganha "acessa CRM com a credencial do Workspace".
 * - Credencial recusada (401) é falha da Ferramenta com motivo, e o Admin vê a recusa no Conector.
 * - Remover o Conector tira as Ferramentas dele de todos os Agentes na hora.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentDto,
  AgentToolDto,
  ApprovalRequestDto,
  ChannelDto,
  ConnectorDto,
  ExecutionDto,
  MessageDto,
} from "@shearim/contracts";
import type { ToolDefinition } from "../src/tools/port";
import { WORKSPACE_TOOLS } from "../src/tools/workspace";
import type { FakeClaudeCall } from "./fake-claude";
import { toolResults } from "./fakes/messages-api";
import type { FakeRemoteTool } from "./fakes/remote-mcp";
import { type EventSocket, eventually, remoteMcp, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const TOKEN = "crm-token-secreto-do-workspace-123";
const LONGO = 120_000;

/** O CRM: uma leitura (com `readOnlyHint`) e uma escrita (sem a marca). */
const CRM_TOOLS: FakeRemoteTool[] = [
  {
    name: "buscar_cliente",
    title: "buscar cliente",
    description: "Busca um cliente pelo nome.",
    inputSchema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
    readOnlyHint: true,
    handler: (args) => `Cliente ${String(args.nome)}: plano Ouro, desde 2021.`,
  },
  {
    name: "criar-oportunidade",
    description: "Cria uma oportunidade no funil.",
    inputSchema: { type: "object", properties: { titulo: { type: "string" } } },
    handler: (args) => `Oportunidade "${String(args.titulo)}" criada: #77.`,
  },
];

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

async function adicionarCrm(t: TestApp, url: string, token = TOKEN) {
  const res = await t.as(juliana).post("/api/connectors", { name: "CRM", url, token });
  expect(res.status).toBe(201);
  return (await res.json()) as ConnectorDto;
}

async function ferramentasDo(t: TestApp, agentId: string): Promise<AgentToolDto[]> {
  return (await t.as(juliana).get(`/api/agents/${agentId}/tools`)).json();
}

describe("adicionar um Conector", () => {
  test(
    "o Admin adiciona o Conector com nome, endereço e token; o catálogo vem do tools/list, e o token nunca volta",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });

      const res = await t.as(juliana).post("/api/connectors", { name: "CRM", url: crm.url, token: TOKEN });
      expect(res.status).toBe(201);
      const texto = await res.text();
      expect(texto).not.toContain(TOKEN);
      const conector: ConnectorDto = JSON.parse(texto);
      expect(conector).toMatchObject({
        name: "CRM",
        url: crm.url,
        credential: "workspace",
        credentialState: "ok",
        refusedAt: null,
      });
      // Só o que o servidor marca como "só leitura" é leitura; o resto é escrita.
      expect(conector.tools.map((f) => [f.title, f.access])).toEqual([
        ["buscar cliente", "read"],
        ["criar-oportunidade", "write"],
      ]);
      expect(crm.tokens()).toContain(TOKEN);

      const lista = await (await t.as(juliana).get("/api/connectors")).text();
      expect(lista).not.toContain(TOKEN);
      expect((JSON.parse(lista) as ConnectorDto[]).map((c) => c.name)).toEqual(["CRM"]);

      // As Ferramentas dele aparecem na tela do Agente, com a origem e o Conector.
      const doFaro = await ferramentasDo(t, faro.id);
      const buscar = doFaro.find((f) => f.title === "buscar cliente")!;
      expect(buscar).toMatchObject({
        origin: "connector",
        access: "read",
        granted: false,
        connector: { id: conector.id, name: "CRM", credential: "workspace" },
      });
      expect(doFaro.find((f) => f.title === "criar-oportunidade")?.access).toBe("write");

      // Só o Admin.
      expect((await t.as(bruno).get("/api/connectors")).status).toBe(403);
      expect((await t.as(bruno).post("/api/connectors", { name: "X", url: crm.url, token: TOKEN })).status).toBe(403);
      // Nome repetido, campos faltando.
      expect((await t.as(juliana).post("/api/connectors", { name: "crm", url: crm.url, token: TOKEN })).status).toBe(
        409,
      );
      expect((await t.as(juliana).post("/api/connectors", { name: "ERP", url: "", token: TOKEN })).status).toBe(400);
      expect((await t.as(juliana).post("/api/connectors", { name: "ERP", url: crm.url, token: " " })).status).toBe(400);
    },
    LONGO,
  );

  test(
    "um servidor que recusa o token ao adicionar não vira Conector: o Admin vê o motivo",
    async () => {
      const t = await testApp();
      await workspace(t);
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });

      const res = await t.as(juliana).post("/api/connectors", { name: "CRM", url: crm.url, token: "outro" });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "credential_refused" });
      expect(await (await t.as(juliana).get("/api/connectors")).json()).toEqual([]);
    },
    LONGO,
  );
});

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/conversations/${channelId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
  );
}

async function andamento(aba: EventSocket, origem: MessageDto, ok: (e: ExecutionDto) => boolean) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.originMessageId === origem.id && ok(execution)) return execution;
  }
}

/** As chamadas de resposta (sem o roteamento da Articuladora) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
const nomes = (t: TestApp, i: number) =>
  ((respostas(t)[i]!.body.tools as { name: string }[] | undefined) ?? []).map((f) => f.name);

/** O CRM ligado e as Ferramentas dele, pelo título. */
async function crmLigado(t: TestApp, agentId: string, conceder: string[]) {
  const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });
  const conector = await adicionarCrm(t, crm.url);
  const id = (title: string) => conector.tools.find((f) => f.title === title)!.id;
  for (const title of conceder) {
    expect((await t.as(juliana).put(`/api/agents/${agentId}/tools/${id(title)}`)).status).toBe(200);
  }
  return { crm, conector, id };
}

describe("pela Chave", () => {
  test(
    "a Ferramenta de leitura concedida vai ao modelo, a chamada passa pelo Shearim até o servidor com o token, e o Andamento mostra de quem é a credencial",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, id } = await crmLigado(t, faro.id, ["buscar cliente"]);
      const aba = await t.socket(juliana);

      t.anthropic.reply(
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "A Acme é cliente Ouro desde 2021." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");

      const usando = await andamento(aba, origem, (e) => e.step === "tool");
      expect(usando.tools.at(-1)?.label).toBe("usando buscar cliente no CRM, com a credencial do Workspace");
      expect((await respostaA(t, geral.id, origem)).body).toBe("A Acme é cliente Ouro desde 2021.");

      // Só a concedida foi oferecida; a escrita não.
      expect(nomes(t, 0)).toEqual([id("buscar cliente")]);
      expect(crm.calls).toEqual([{ name: "buscar_cliente", arguments: { nome: "Acme" }, token: TOKEN }]);
      const [resultado] = toolResults(respostas(t)[1]!.body);
      expect(resultado?.content).toBe(
        `<resultado_de_ferramenta nome="${id("buscar cliente")}">\nCliente Acme: plano Ouro, desde 2021.\n</resultado_de_ferramenta>`,
      );
      expect(resultado?.is_error).toBeFalsy();
    },
    LONGO,
  );

  test(
    "a Ferramenta sem readOnlyHint é escrita: vira Pedido de aprovação, e só na aprovação o Shearim a chama no servidor",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, id } = await crmLigado(t, faro.id, ["criar-oportunidade"]);

      t.anthropic.reply(
        { toolUse: [{ name: id("criar-oportunidade"), input: { titulo: "Acme 2027" } }] },
        { text: "Criei a oportunidade #77." },
      );
      const origem = await enviar(t, geral.id, "@Faro cria a oportunidade Acme 2027");

      const pedido = await eventually(
        "o Pedido aparecer",
        async () =>
          (
            (await (await t.as(juliana).get(`/api/conversations/${geral.id}/approvals`)).json()) as ApprovalRequestDto[]
          )[0],
        10_000,
      );
      expect(pedido).toMatchObject({
        state: "pending",
        tool: id("criar-oportunidade"),
        summary: 'Usar “criar-oportunidade” no CRM, com a credencial do Workspace: {"titulo":"Acme 2027"}',
      });
      // Nada saiu para o servidor antes da aprovação.
      expect(crm.calls).toEqual([]);

      const aprovado = await t.as(bruno).post(`/api/conversations/${geral.id}/approvals/${pedido.id}/approve`);
      expect(aprovado.status).toBe(200);
      expect(await aprovado.json()).toMatchObject({
        state: "approved",
        result: 'Oportunidade "Acme 2027" criada: #77.',
      });
      expect(crm.calls).toEqual([{ name: "criar-oportunidade", arguments: { titulo: "Acme 2027" }, token: TOKEN }]);
      expect((await respostaA(t, geral.id, origem)).body).toBe("Criei a oportunidade #77.");
    },
    LONGO,
  );
});

describe("pela Conta", () => {
  test(
    "o claude -p recebe só o endpoint do Shearim, e a Ferramenta do Conector chamada por ali chega ao servidor pelo Shearim",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, id } = await crmLigado(t, faro.id, ["buscar cliente"]);
      await t.linkAccount(juliana);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ tool: { name: id("buscar cliente"), input: { nome: "Acme" } } }, { text: "{resultado}" }],
        },
      });

      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?", juliana);
      expect((await respostaA(t, geral.id, origem)).body).toBe(
        `<resultado_de_ferramenta nome="${id("buscar cliente")}">\nCliente Acme: plano Ouro, desde 2021.\n</resultado_de_ferramenta>`,
      );

      const [listou] = t.claude.mcp();
      expect(listou).toMatchObject({ listed: [id("buscar cliente")] });
      const resposta = t.claude
        .callsOf("-p")
        .filter((c: FakeClaudeCall) => c.stdin)
        .at(-1)!;
      const config = resposta.argv[resposta.argv.indexOf("--mcp-config") + 1]!;
      // O endereço e o token do CRM nunca vão ao processo do modelo.
      expect(Object.keys(JSON.parse(config).mcpServers)).toEqual(["shearim"]);
      expect(config).not.toContain(crm.url);
      expect(resposta.argv.join(" ")).not.toContain(TOKEN);
      expect(crm.calls).toEqual([{ name: "buscar_cliente", arguments: { nome: "Acme" }, token: TOKEN }]);
    },
    LONGO,
  );
});

describe("a descrição pública do Agente", () => {
  test(
    'o Agente com Ferramentas do Conector ganha a linha "acessa CRM com a credencial do Workspace", que todo Membro vê',
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const agente = async () =>
        ((await (await t.as(bruno).get("/api/agents")).json()) as AgentDto[]).find((a) => a.id === faro.id)!;
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });
      const conector = await adicionarCrm(t, crm.url);
      expect((await agente()).reach).toEqual([]);

      for (const f of conector.tools) await t.as(juliana).put(`/api/agents/${faro.id}/tools/${f.id}`);
      const depois = await agente();
      // Uma linha por Conector, por mais Ferramentas dele que o Agente tenha.
      expect(depois.reach).toEqual(["acessa CRM com a credencial do Workspace"]);
      expect(depois.description).toBe("Comercial: preços e propostas.");
      expect(depois.tools).toContainEqual({
        id: conector.tools[0]!.id,
        title: "buscar cliente",
        origin: "connector",
        connector: { id: conector.id, name: "CRM", credential: "workspace" },
      });
      // A Articuladora, sem nada do Conector, não ganha a linha.
      const articuladora = ((await (await t.as(bruno).get("/api/agents")).json()) as AgentDto[]).find(
        (a) => a.builtin,
      )!;
      expect(articuladora.reach).toEqual([]);
    },
    LONGO,
  );
});

describe("credencial recusada", () => {
  test(
    "o servidor responde 401: a Ferramenta falha com motivo, a resposta segue, e o Admin vê a recusa no Conector até colar outro token",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmLigado(t, faro.id, ["buscar cliente"]);
      const aba = await t.socket(bruno);
      crm.refuse();

      t.anthropic.reply(
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "Não consegui consultar o CRM agora." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");
      const falhou = await andamento(aba, origem, (e) => e.tools.some((f) => f.state === "failed"));
      expect(falhou.tools.at(-1)).toMatchObject({
        title: "buscar cliente",
        state: "failed",
        reason: "o CRM recusou a credencial do Workspace",
      });
      expect((await respostaA(t, geral.id, origem)).body).toBe("Não consegui consultar o CRM agora.");
      const [resultado] = toolResults(respostas(t)[1]!.body);
      expect(resultado).toMatchObject({
        is_error: true,
        content: "A Ferramenta buscar cliente falhou: o CRM recusou a credencial do Workspace.",
      });

      const [recusado] = (await (await t.as(juliana).get("/api/connectors")).json()) as ConnectorDto[];
      expect(recusado).toMatchObject({
        id: conector.id,
        credentialState: "refused",
        refusedAt: t.clock.now().toISOString(),
      });

      // Um token que o servidor também recusa não substitui o guardado.
      expect((await t.as(juliana).put(`/api/connectors/${conector.id}/credential`, { token: "errado" })).status).toBe(
        422,
      );
      crm.refuse(false);
      crm.accept("token-novo");
      const trocado = await t.as(juliana).put(`/api/connectors/${conector.id}/credential`, { token: "token-novo" });
      expect(trocado.status).toBe(200);
      expect(await trocado.json()).toMatchObject({ credentialState: "ok", refusedAt: null });
      expect(await (await t.as(bruno).put(`/api/connectors/${conector.id}/credential`, { token: "x" })).json()).toEqual(
        {
          error: "not_admin",
        },
      );
    },
    LONGO,
  );

  test(
    "abrir o Conector relê o catálogo; se o servidor recusar, o Admin vê o último catálogo, a recusa e o motivo",
    async () => {
      const t = await testApp();
      await workspace(t);
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });
      const conector = await adicionarCrm(t, crm.url);

      crm.setTools([...CRM_TOOLS, { name: "listar_contratos", readOnlyHint: true }]);
      const relido: ConnectorDto = await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json();
      expect(relido.tools.map((f) => f.name)).toEqual(["buscar_cliente", "criar-oportunidade", "listar_contratos"]);
      // Os ids das que já existiam não mudam (as concessões continuam valendo).
      expect(relido.tools[0]!.id).toBe(conector.tools[0]!.id);

      crm.refuse();
      const recusado: ConnectorDto = await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json();
      expect(recusado).toMatchObject({ credentialState: "refused", catalogError: "O CRM recusou o token." });
      expect(recusado.tools).toHaveLength(3);
    },
    LONGO,
  );

  test(
    "a Ferramenta que sai do catálogo leva a concessão junto: a que volta depois com o mesmo id não chega concedida",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });
      const conector = await adicionarCrm(t, crm.url);
      const buscar = conector.tools.find((f) => f.name === "buscar_cliente")!.id;
      expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${buscar}`)).status).toBe(200);

      // O servidor tira "buscar_cliente"; depois lança outra, de escrita, que vira o mesmo id.
      crm.setTools(CRM_TOOLS.filter((f) => f.name !== "buscar_cliente"));
      await t.as(juliana).get(`/api/connectors/${conector.id}`);
      crm.setTools([...CRM_TOOLS.filter((f) => f.name !== "buscar_cliente"), { name: "Buscar cliente!" }]);
      const relido: ConnectorDto = await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json();
      expect(relido.tools.find((f) => f.name === "Buscar cliente!")!.id).toBe(buscar);

      expect((await ferramentasDo(t, faro.id)).find((f) => f.id === buscar)).toMatchObject({
        access: "write",
        granted: false,
      });
    },
    LONGO,
  );

  test(
    "um nome novo que daria o mesmo id de um nome que já existia ganha outro id, e o antigo fica com o dele",
    async () => {
      const t = await testApp();
      await workspace(t);
      const crm = remoteMcp({ token: TOKEN, tools: CRM_TOOLS });
      const conector = await adicionarCrm(t, crm.url);
      const antigo = conector.tools.find((f) => f.name === "criar-oportunidade")!.id;

      // "criar_oportunidade" vira o mesmo id de "criar-oportunidade", e vem antes na lista.
      crm.setTools([{ name: "criar_oportunidade" }, ...CRM_TOOLS]);
      const relido: ConnectorDto = await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json();
      expect(relido.catalogError).toBeNull();
      expect(relido.tools.map((f) => f.name)).toEqual(["criar_oportunidade", "buscar_cliente", "criar-oportunidade"]);
      expect(relido.tools.find((f) => f.name === "criar-oportunidade")!.id).toBe(antigo);
      expect(new Set(relido.tools.map((f) => f.id)).size).toBe(3);
    },
    LONGO,
  );
});

describe("remover o Conector", () => {
  test(
    "as Ferramentas dele saem de todos os Agentes na hora, e a próxima resposta já vai sem elas",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const lince: AgentDto = await (
        await t.as(juliana).post("/api/agents", { name: "Lince", model: "claude-haiku-5-5" })
      ).json();
      const { crm, conector, id } = await crmLigado(t, faro.id, ["buscar cliente", "criar-oportunidade"]);
      await t.as(juliana).put(`/api/agents/${lince.id}/tools/${id("buscar cliente")}`);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);

      expect((await t.as(bruno).delete(`/api/connectors/${conector.id}`)).status).toBe(403);
      expect((await t.as(juliana).delete(`/api/connectors/${conector.id}`)).status).toBe(204);

      const agentes: AgentDto[] = await (await t.as(bruno).get("/api/agents")).json();
      expect(agentes.find((a) => a.id === faro.id)).toMatchObject({
        tools: [{ id: "listar_agentes", title: "listar Agentes", origin: "workspace" }],
        reach: [],
      });
      expect(agentes.find((a) => a.id === lince.id)).toMatchObject({ tools: [], reach: [] });
      expect((await ferramentasDo(t, faro.id)).some((f) => f.origin === "connector")).toBe(false);
      expect(await (await t.as(juliana).get("/api/connectors")).json()).toEqual([]);
      expect((await t.as(juliana).get(`/api/connectors/${conector.id}`)).status).toBe(404);
      // Conceder uma Ferramenta do Conector removido não existe mais.
      expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`)).status).toBe(404);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro a Acme é cliente?"));
      expect(nomes(t, 0)).toEqual(["listar_agentes"]);
      expect(crm.calls).toEqual([]);
    },
    LONGO,
  );

  test(
    "removido no meio da resposta: a chamada que o modelo ainda pede volta como indisponível, sem chegar ao servidor",
    async () => {
      // Uma Ferramenta do Workspace que segura o primeiro turno até o teste soltar.
      let soltar = () => {};
      const segura: ToolDefinition = {
        id: "consultar_arquivo",
        title: "consultar o arquivo",
        label: "consultando o arquivo",
        description: "Consulta o arquivo morto.",
        origin: "workspace",
        access: "read",
        inputSchema: { type: "object", properties: {} },
        run: () => new Promise<string>((resolve) => (soltar = () => resolve("nada no arquivo"))),
      };
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, segura] } });
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmLigado(t, faro.id, ["buscar cliente"]);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/consultar_arquivo`);
      const aba = await t.socket(juliana);

      t.anthropic.reply(
        { toolUse: [{ name: "consultar_arquivo" }] },
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "Sem o CRM." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");
      await andamento(aba, origem, (e) => e.step === "tool");
      expect((await t.as(juliana).delete(`/api/connectors/${conector.id}`)).status).toBe(204);
      soltar();

      expect((await respostaA(t, geral.id, origem)).body).toBe("Sem o CRM.");
      const [resultado] = toolResults(respostas(t)[2]!.body);
      expect(resultado).toMatchObject({ is_error: true });
      expect(resultado?.content).toContain("não está disponível");
      expect(crm.calls).toEqual([]);
    },
    LONGO,
  );
});

describe("listar Agentes", () => {
  test(
    "mostra as Ferramentas do Conector de cada Agente e a linha de alcance da descrição pública",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await crmLigado(t, faro.id, ["buscar cliente"]);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);

      t.anthropic.reply({ toolUse: [{ name: "listar_agentes" }] }, { text: "Pronto." });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem faz o quê?"));
      const [resultado] = toolResults(respostas(t)[1]!.body);
      expect(resultado?.content).toContain(
        "- Faro (@faro): Comercial: preços e propostas. Acessa CRM com a credencial do Workspace.",
      );
      expect(resultado?.content).toMatch(
        /Ferramentas: (buscar cliente, listar Agentes|listar Agentes, buscar cliente)/,
      );
    },
    LONGO,
  );
});
