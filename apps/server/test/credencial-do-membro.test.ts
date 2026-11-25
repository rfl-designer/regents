/**
 * Conector com credencial de cada Membro (#55, Spec #44), pela borda do servidor, com um servidor
 * MCP remoto falso no papel do sistema de fora (o "CRM"), que aceita um token por Membro.
 *
 * - O Admin escolhe o modo ao adicionar; o token que ele cola vira a credencial dele.
 * - Em Perfil › Conectores, cada Membro liga a dele colando um token (cifrado) e desliga quando quiser.
 * - A resposta usa a credencial do autor: o Andamento mostra "usou o CRM de Ana".
 * - Sem a credencial do autor, a Ferramenta responde "indisponível" e a resposta segue; só o autor
 *   vê o atalho "Ligar CRM".
 * - Credencial recusada (401): falha com motivo, a credencial fica recusada e o Membro é avisado.
 * - Um Membro removido perde as credenciais.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ConnectorDto, ExecutionDto, MessageDto, MyConnectorDto } from "@shearim/contracts";
import { toolResults } from "./fakes/messages-api";
import type { FakeRemoteTool } from "./fakes/remote-mcp";
import { type EventSocket, eventually, remoteMcp, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const ana = { id: "1002", login: "ana@exemplo.com", name: "Ana" };
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const DA_JULIANA = "crm-token-da-juliana-111";
const DA_ANA = "crm-token-da-ana-222";
const DO_BRUNO = "crm-token-do-bruno-333";
const LONGO = 120_000;

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

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral; Ana e Bruno entram (pagam pela Chave). */
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
  for (const who of [ana, bruno]) {
    await t.addMember(who, { by: juliana });
    await t.as(who).post(`/api/channels/${geral!.id}/join`);
  }
  return { faro, geral: geral! };
}

/** O CRM no modo de cada Membro, com o token da Juliana; o servidor aceita os três tokens. */
async function crmDeCadaMembro(t: TestApp) {
  const crm = remoteMcp({ token: [DA_JULIANA, DA_ANA, DO_BRUNO], tools: CRM_TOOLS });
  const res = await t.as(juliana).post("/api/connectors", {
    name: "CRM",
    url: crm.url,
    token: DA_JULIANA,
    credential: "member",
  });
  expect(res.status).toBe(201);
  const conector = (await res.json()) as ConnectorDto;
  return { crm, conector, id: (title: string) => conector.tools.find((f) => f.title === title)!.id };
}

async function meus(t: TestApp, who: typeof ana): Promise<MyConnectorDto[]> {
  const res = await t.as(who).get("/api/me/connectors");
  expect(res.status).toBe(200);
  return res.json();
}

async function ligar(t: TestApp, who: typeof ana, connectorId: string, token: string) {
  return t.as(who).put(`/api/me/connectors/${connectorId}/credential`, { token });
}

describe("adicionar no modo de cada Membro e ligar no Perfil", () => {
  test(
    "o Admin escolhe o modo ao adicionar; cada Membro vê o Conector em Perfil › Conectores, liga colando o token e desliga quando quer",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const { crm, conector } = await crmDeCadaMembro(t);
      expect(conector).toMatchObject({ name: "CRM", credential: "member" });
      expect(conector.tools.map((f) => [f.title, f.access])).toEqual([
        ["buscar cliente", "read"],
        ["criar-oportunidade", "write"],
      ]);

      // Um Conector com a credencial do Workspace não aparece no Perfil de ninguém.
      const outro = remoteMcp({ token: "erp-token", tools: CRM_TOOLS });
      expect(
        (await t.as(juliana).post("/api/connectors", { name: "ERP", url: outro.url, token: "erp-token" })).status,
      ).toBe(201);

      // O token que o Admin colou é a credencial dele; os outros ainda não ligaram.
      expect(await meus(t, juliana)).toEqual([
        { id: conector.id, name: "CRM", url: crm.url, credentialState: "ok", refusedAt: null },
      ]);
      expect(await meus(t, ana)).toEqual([
        { id: conector.id, name: "CRM", url: crm.url, credentialState: "off", refusedAt: null },
      ]);

      // Um token que o servidor recusa não liga nada.
      const recusado = await ligar(t, ana, conector.id, "token-errado");
      expect(recusado.status).toBe(422);
      expect(await recusado.json()).toMatchObject({ error: "credential_refused" });
      expect((await meus(t, ana))[0]?.credentialState).toBe("off");

      const ligado = await ligar(t, ana, conector.id, DA_ANA);
      expect(ligado.status).toBe(200);
      const texto = await ligado.text();
      expect(texto).not.toContain(DA_ANA);
      expect(JSON.parse(texto)).toMatchObject({ id: conector.id, credentialState: "ok" });
      expect((await meus(t, ana))[0]?.credentialState).toBe("ok");
      // A dela é só dela.
      expect((await meus(t, bruno))[0]?.credentialState).toBe("off");
      expect(JSON.stringify(await meus(t, ana))).not.toContain(DA_ANA);

      expect((await t.as(ana).delete(`/api/me/connectors/${conector.id}/credential`)).status).toBe(204);
      expect((await meus(t, ana))[0]?.credentialState).toBe("off");

      // Ligar um Conector do Workspace (ou um que não existe) pelo Perfil não vale.
      const erp = ((await (await t.as(juliana).get("/api/connectors")).json()) as ConnectorDto[]).find(
        (c) => c.name === "ERP",
      )!;
      expect((await ligar(t, ana, erp.id, "erp-token")).status).toBe(404);
      // No modo de cada Membro, não há credencial do Workspace para trocar.
      expect((await t.as(juliana).put(`/api/connectors/${conector.id}/credential`, { token: DA_JULIANA })).status).toBe(
        409,
      );

      // As Ferramentas dizem de quem é a credencial, e a descrição pública não ganha a linha do Workspace.
      for (const f of conector.tools) await t.as(juliana).put(`/api/agents/${faro.id}/tools/${f.id}`);
      const agente = ((await (await t.as(bruno).get("/api/agents")).json()) as AgentDto[]).find(
        (a) => a.id === faro.id,
      )!;
      expect(agente.tools[0]).toMatchObject({ connector: { id: conector.id, name: "CRM", credential: "member" } });
      expect(agente.reach).toEqual([]);
    },
    LONGO,
  );
});

async function enviar(t: TestApp, channelId: string, body: string, who: typeof ana): Promise<MessageDto> {
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

describe("a resposta usa a credencial do autor", () => {
  test(
    'Ana ligou a dela: a chamada sai com o token dela, e o Andamento mostra "usou o CRM de Ana" a todos',
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmDeCadaMembro(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      expect((await ligar(t, ana, conector.id, DA_ANA)).status).toBe(200);
      const abaDoBruno = await t.socket(bruno);

      t.anthropic.reply(
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "A Acme é cliente Ouro." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?", ana);

      const usando = await andamento(abaDoBruno, origem, (e) => e.step === "tool");
      expect(usando.tools.at(-1)?.label).toBe("usando buscar cliente no CRM de Ana");
      const usou = await andamento(abaDoBruno, origem, (e) => e.tools.some((f) => f.state === "done"));
      expect(usou.tools.at(-1)).toMatchObject({ state: "done", used: "usou o CRM de Ana" });
      expect((await respostaA(t, geral.id, origem)).body).toBe("A Acme é cliente Ouro.");

      expect(crm.calls).toEqual([{ name: "buscar_cliente", arguments: { nome: "Acme" }, token: DA_ANA }]);
    },
    LONGO,
  );

  test(
    'o autor não ligou: a Ferramenta responde "indisponível" e a resposta segue; todos veem que estava indisponível, e só o autor vê "Ligar CRM"',
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmDeCadaMembro(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      const abaDoBruno = await t.socket(bruno);
      const abaDaAna = await t.socket(ana);

      t.anthropic.reply(
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "Não consegui ver no CRM." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?", bruno);
      const falhou = (e: ExecutionDto) => e.tools.some((f) => f.state === "failed");

      const doAutor = await andamento(abaDoBruno, origem, falhou);
      expect(doAutor.tools.at(-1)).toMatchObject({
        title: "buscar cliente",
        state: "failed",
        reason: "indisponível: o autor não ligou o CRM",
        connect: { connectorId: conector.id, name: "CRM" },
      });
      const deOutro = await andamento(abaDaAna, origem, falhou);
      expect(deOutro.tools.at(-1)).toMatchObject({ state: "failed", reason: "indisponível: o autor não ligou o CRM" });
      expect(deOutro.tools.at(-1)?.connect).toBeUndefined();

      expect((await respostaA(t, geral.id, origem)).body).toBe("Não consegui ver no CRM.");
      const [resultado] = toolResults(respostas(t)[1]!.body);
      expect(resultado).toMatchObject({
        is_error: true,
        content: "A Ferramenta buscar cliente falhou: indisponível: o autor não ligou o CRM.",
      });
      // Nada chegou ao servidor (nem com a credencial de outro Membro).
      expect(crm.calls).toEqual([]);
    },
    LONGO,
  );
});

describe("credencial recusada", () => {
  test(
    "o servidor recusa a de Ana (401): a Ferramenta falha com motivo, a credencial fica recusada no Perfil dela e ela é avisada",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmDeCadaMembro(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      expect((await ligar(t, ana, conector.id, DA_ANA)).status).toBe(200);
      const aparelho = await t.pushDevice(ana);
      const abaDaAna = await t.socket(ana);
      crm.revoke(DA_ANA);

      t.anthropic.reply(
        { toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] },
        { text: "O CRM recusou." },
      );
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?", ana);
      const falhou = await andamento(abaDaAna, origem, (e) => e.tools.some((f) => f.state === "failed"));
      expect(falhou.tools.at(-1)).toMatchObject({
        state: "failed",
        reason: "o CRM recusou a credencial de Ana",
        connect: { connectorId: conector.id, name: "CRM" },
      });
      expect((await respostaA(t, geral.id, origem)).body).toBe("O CRM recusou.");

      // O Perfil dela acompanha, e o push leva a Perfil › Conectores.
      const { connector } = await abaDaAna.next("my_connector.updated", { timeoutMs: 10_000 });
      expect(connector).toMatchObject({ id: conector.id, credentialState: "refused" });
      expect((await meus(t, ana))[0]).toMatchObject({
        credentialState: "refused",
        refusedAt: t.clock.now().toISOString(),
      });
      const push = await aparelho.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({
        title: "O CRM recusou a sua credencial",
        navigate: expect.stringContaining("/perfil/conectores"),
      });

      // Recusada, a próxima resposta já nem chama o servidor: indisponível, com o atalho para ela.
      const antes = crm.calls.length;
      t.anthropic.reply({ toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] }, { text: "Sem o CRM." });
      const outra = await enviar(t, geral.id, "@Faro e agora?", ana);
      const indisponivel = await andamento(abaDaAna, outra, (e) => e.tools.some((f) => f.state === "failed"));
      expect(indisponivel.tools.at(-1)).toMatchObject({
        reason: "indisponível: o CRM recusou a credencial do autor",
        connect: { connectorId: conector.id, name: "CRM" },
      });
      await respostaA(t, geral.id, outra);
      expect(crm.calls.length).toBe(antes);

      // Ligar de novo com um token que vale tira a recusa.
      crm.allow("crm-token-novo-da-ana");
      expect((await ligar(t, ana, conector.id, "crm-token-novo-da-ana")).status).toBe(200);
      expect((await meus(t, ana))[0]).toMatchObject({ credentialState: "ok", refusedAt: null });
    },
    LONGO,
  );
});

describe("escrita com a credencial do autor", () => {
  test(
    "o Pedido diz de quem é a credencial, e a ação aprovada sai com o token do autor; sem credencial, nem há Pedido",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { crm, conector, id } = await crmDeCadaMembro(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("criar-oportunidade")}`);
      expect((await ligar(t, ana, conector.id, DA_ANA)).status).toBe(200);

      t.anthropic.reply(
        { toolUse: [{ name: id("criar-oportunidade"), input: { titulo: "Acme 2027" } }] },
        { text: "Criei a #77." },
      );
      const origem = await enviar(t, geral.id, "@Faro cria a oportunidade Acme 2027", ana);
      const pedido = await eventually(
        "o Pedido aparecer",
        async () =>
          ((await (await t.as(ana).get(`/api/conversations/${geral.id}/approvals`)).json()) as { id: string }[])[0],
        10_000,
      );
      expect(pedido).toMatchObject({
        summary: 'Usar “criar-oportunidade” no CRM, com a credencial de Ana: {"titulo":"Acme 2027"}',
      });
      const aprovado = await t.as(ana).post(`/api/conversations/${geral.id}/approvals/${pedido.id}/approve`);
      expect(await aprovado.json()).toMatchObject({
        state: "approved",
        result: 'Oportunidade "Acme 2027" criada: #77.',
      });
      expect(crm.calls).toEqual([{ name: "criar-oportunidade", arguments: { titulo: "Acme 2027" }, token: DA_ANA }]);
      await respostaA(t, geral.id, origem);

      // Bruno não ligou: a escrita fica indisponível, sem Pedido.
      const abaDoBruno = await t.socket(bruno);
      t.anthropic.reply(
        { toolUse: [{ name: id("criar-oportunidade"), input: { titulo: "Beta" } }] },
        { text: "Não deu." },
      );
      const doBruno = await enviar(t, geral.id, "@Faro cria a Beta", bruno);
      const falhou = await andamento(abaDoBruno, doBruno, (e) => e.tools.some((f) => f.state === "failed"));
      expect(falhou.tools.at(-1)).toMatchObject({ reason: "indisponível: o autor não ligou o CRM" });
      expect((await respostaA(t, geral.id, doBruno)).body).toBe("Não deu.");
      expect(
        ((await (await t.as(bruno).get(`/api/conversations/${geral.id}/approvals`)).json()) as unknown[]).length,
      ).toBe(1);
    },
    LONGO,
  );
});

describe("Membro removido", () => {
  test(
    "perde as credenciais: quem volta encontra o Conector desligado, e a resposta dele não usa o token antigo",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const { conector } = await crmDeCadaMembro(t);
      expect((await ligar(t, ana, conector.id, DA_ANA)).status).toBe(200);
      const anaMe = (await (await t.as(ana).get("/api/me")).json()) as { id: string };

      expect((await t.as(juliana).delete(`/api/members/${anaMe.id}`)).status).toBe(204);
      await t.addMember(ana, { by: juliana });
      await t.as(ana).post(`/api/channels/${geral.id}/join`);
      expect((await meus(t, ana))[0]?.credentialState).toBe("off");
    },
    LONGO,
  );
});

describe("listar Agentes", () => {
  test(
    "o Conector de cada Membro não ganha a linha de alcance do Workspace",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const { id } = await crmDeCadaMembro(t);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/listar_agentes`);

      t.anthropic.reply({ toolUse: [{ name: "listar_agentes" }] }, { text: "Pronto." });
      await respostaA(t, geral.id, await enviar(t, geral.id, "@Faro quem faz o quê?", ana));
      const [resultado] = toolResults(respostas(t)[1]!.body);
      expect(resultado?.content).toContain("- Faro (@faro): Comercial: preços e propostas.\n");
      expect(resultado?.content).not.toContain("credencial do Workspace");
    },
    LONGO,
  );
});
