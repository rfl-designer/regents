/**
 * Login OAuth dos Conectores (#56, Spec #44), pela borda do servidor, com um servidor MCP remoto
 * falso que também é o servidor de autorização dele (o login do MCP).
 *
 * - Quando o servidor oferece login, "Ligar" devolve o endereço do login dele; o navegador de quem
 *   liga volta ao endereço da Instalação na tailnet, e o retorno grava a credencial (do Workspace,
 *   ao adicionar ou religar, ou a do Membro, no Perfil).
 * - A credencial se renova sozinha antes de vencer; a renovação recusada segue o caminho da
 *   credencial recusada (o Admin vê no Conector; o Membro é avisado).
 * - Sem login no servidor, "Ligar" diz para colar um token, e o token colado continua valendo.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentDto,
  ChannelDto,
  ConnectorDto,
  ConnectorLoginDto,
  ExecutionDto,
  MessageDto,
  MyConnectorDto,
} from "@shearim/contracts";
import type { FakeRemoteMcp, FakeRemoteTool } from "./fakes/remote-mcp";
import { type EventSocket, eventually, type Person, remoteMcp, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const ana = { id: "1002", login: "ana@exemplo.com", name: "Ana" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
/** O endereço da Instalação na tailnet, de onde o PWA abre o login. */
const INSTALACAO = "https://shearim.time-exemplo.ts.net";
const LONGO = 120_000;
const MIN = 60_000;

const CRM_TOOLS: FakeRemoteTool[] = [
  {
    name: "buscar_cliente",
    title: "buscar cliente",
    description: "Busca um cliente pelo nome.",
    inputSchema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
    readOnlyHint: true,
    handler: (args) => `Cliente ${String(args.nome)}: plano Ouro, desde 2021.`,
  },
];

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral; Ana entra. */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial.",
      instructions: "Você é o Faro.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  await t.addMember(ana, { by: juliana });
  await t.as(ana).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral! };
}

/**
 * O navegador de `who` segue o login: abre o endereço do servidor de autorização, que faz o login e
 * volta ao `redirect_uri` (o endereço da Instalação); o retorno chega ao Shearim com a identidade
 * dele. Devolve para onde o Shearim mandou o navegador depois (a tela do PWA, com o desfecho).
 */
async function seguirLogin(t: TestApp, who: Person, authorizationUrl: string) {
  const login = await fetch(authorizationUrl, { redirect: "manual" });
  expect(login.status).toBe(302);
  const back = new URL(login.headers.get("location")!);
  expect(back.origin).toBe(INSTALACAO);
  expect(back.pathname).toBe("/api/connector-login/callback");
  const res = await t.as(who).get(`${back.pathname}${back.search}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!, INSTALACAO);
}

async function enviar(t: TestApp, channelId: string, body: string, who: Person = juliana): Promise<MessageDto> {
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

async function conectores(t: TestApp): Promise<ConnectorDto[]> {
  return (await t.as(juliana).get("/api/connectors")).json();
}

/** Juliana adiciona o CRM pelo login dele, com a credencial `credential`. */
async function adicionarPeloLogin(t: TestApp, crm: FakeRemoteMcp, credential: "workspace" | "member" = "workspace") {
  const res = await t
    .as(juliana)
    .post("/api/connectors/login", { name: "CRM", url: crm.url, credential, origin: INSTALACAO });
  expect(res.status).toBe(200);
  const { authorizationUrl } = (await res.json()) as ConnectorLoginDto;
  const destino = await seguirLogin(t, juliana, authorizationUrl);
  expect(`${destino.pathname}${destino.search}`).toBe("/conectores?conector=ligado");
  const conector = (await conectores(t)).find((c) => c.name === "CRM")!;
  return { conector, id: (title: string) => conector.tools.find((f) => f.title === title)!.id };
}

/** Uma pergunta ao Faro que usa o "buscar cliente"; devolve a resposta. */
async function perguntar(t: TestApp, geral: ChannelDto, id: string, who: Person = juliana) {
  t.anthropic.reply({ toolUse: [{ name: id, input: { nome: "Acme" } }] }, { text: "A Acme é Ouro." });
  const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?", who);
  return { origem, resposta: await respostaA(t, geral.id, origem) };
}

describe("ligar pelo login do servidor", () => {
  test(
    "o Admin adiciona o CRM pelo login: o login dele volta ao endereço da Instalação na tailnet, e a credencial do Workspace fica gravada (sem voltar)",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
      crm.oauth.loginAs("time-no-crm");

      const res = await t.as(juliana).post("/api/connectors/login", { name: "CRM", url: crm.url, origin: INSTALACAO });
      expect(res.status).toBe(200);
      const { authorizationUrl } = (await res.json()) as ConnectorLoginDto;
      expect(authorizationUrl.startsWith(`${new URL(crm.url).origin}/authorize?`)).toBe(true);
      // Nada é gravado antes do retorno.
      expect(await conectores(t)).toEqual([]);

      const destino = await seguirLogin(t, juliana, authorizationUrl);
      expect(`${destino.pathname}${destino.search}`).toBe("/conectores?conector=ligado");
      expect(crm.oauth.registeredRedirects()).toEqual([`${INSTALACAO}/api/connector-login/callback`]);

      const lista = await (await t.as(juliana).get("/api/connectors")).text();
      expect(lista).not.toContain(crm.oauth.tokenOf("time-no-crm")!);
      const [conector] = JSON.parse(lista) as ConnectorDto[];
      expect(conector).toMatchObject({ name: "CRM", credential: "workspace", credentialState: "ok" });
      expect(conector!.tools.map((f) => f.title)).toEqual(["buscar cliente"]);

      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${conector!.tools[0]!.id}`);
      const { resposta } = await perguntar(t, geral, conector!.tools[0]!.id);
      expect(resposta.body).toBe("A Acme é Ouro.");
      expect(crm.calls).toEqual([
        { name: "buscar_cliente", arguments: { nome: "Acme" }, token: crm.oauth.tokenOf("time-no-crm")! },
      ]);
    },
    LONGO,
  );

  test(
    "o token de acesso deixa de valer antes do prazo: um 401 renova uma vez e repete, sem marcar a credencial como recusada",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
      crm.oauth.loginAs("time-no-crm");
      const { conector, id } = await adicionarPeloLogin(t, crm);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);

      crm.revoke(crm.oauth.tokenOf("time-no-crm")!);
      const { resposta } = await perguntar(t, geral, id("buscar cliente"));
      expect(resposta.body).toBe("A Acme é Ouro.");
      expect(crm.oauth.renewals()).toBe(1);
      expect(crm.calls.at(-1)).toMatchObject({ token: crm.oauth.tokenOf("time-no-crm")! });
      const relido = (await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json()) as ConnectorDto;
      expect(relido.credentialState).toBe("ok");
    },
    LONGO,
  );

  /**
   * O Admin troca a credencial enquanto uma renovação está no meio: a renovação parada no servidor
   * de login volta depois. Devolve o que a resposta usou e o Conector como ficou.
   */
  async function trocarNoMeioDaRenovacao(recusar: boolean) {
    const t = await testApp();
    const { faro, geral } = await workspace(t);
    const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
    crm.oauth.loginAs("time-no-crm");
    const { conector, id } = await adicionarPeloLogin(t, crm);
    await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);

    const renovacao = crm.oauth.holdRenewal();
    if (recusar) crm.oauth.refuseRenewal();
    crm.revoke(crm.oauth.tokenOf("time-no-crm")!);
    t.anthropic.reply({ toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] }, { text: "Pronto." });
    const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");
    await renovacao.arrived;

    crm.allow("token-colado");
    const trocado = await t.as(juliana).put(`/api/connectors/${conector.id}/credential`, { token: "token-colado" });
    expect(trocado.status).toBe(200);
    renovacao.release();
    await respostaA(t, geral.id, origem);

    await perguntar(t, geral, id("buscar cliente"));
    const [depois] = await conectores(t);
    return { crm, depois: depois! };
  }

  test(
    "a renovação que volta depois de o Admin colar um token novo não grava o login antigo por cima",
    async () => {
      const { crm, depois } = await trocarNoMeioDaRenovacao(false);
      expect(crm.calls.at(-1)).toMatchObject({ token: "token-colado" });
      expect(depois.credentialState).toBe("ok");
    },
    LONGO,
  );

  test(
    "a renovação recusada que volta depois de o Admin colar um token novo não marca o novo como recusado",
    async () => {
      const { crm, depois } = await trocarNoMeioDaRenovacao(true);
      expect(depois).toMatchObject({ credentialState: "ok", refusedAt: null });
      expect(crm.calls.map((c) => c.token)).toEqual(["token-colado", "token-colado"]);
    },
    LONGO,
  );
});

describe("a credencial de cada Membro pelo login", () => {
  test(
    "no modo de cada Membro, o login do Admin vira a dele; Ana liga a dela pelo login em Perfil › Conectores, e a resposta usa a dela",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
      crm.oauth.loginAs("juliana-no-crm");
      const { conector, id } = await adicionarPeloLogin(t, crm, "member");
      expect(conector).toMatchObject({ credential: "member" });
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      const meusDaAna = async (): Promise<MyConnectorDto[]> => (await t.as(ana).get("/api/me/connectors")).json();
      expect((await meusDaAna())[0]?.credentialState).toBe("off");

      const abaDaAna = await t.socket(ana);
      crm.oauth.loginAs("ana-no-crm");
      const res = await t.as(ana).post(`/api/me/connectors/${conector.id}/credential/login`, { origin: INSTALACAO });
      expect(res.status).toBe(200);
      const { authorizationUrl } = (await res.json()) as ConnectorLoginDto;
      const destino = await seguirLogin(t, ana, authorizationUrl);
      expect(`${destino.pathname}${destino.search}`).toBe("/perfil/conectores?conector=ligado");
      const { connector } = await abaDaAna.next("my_connector.updated");
      expect(connector).toMatchObject({ id: conector.id, credentialState: "ok" });
      expect((await meusDaAna())[0]?.credentialState).toBe("ok");

      await perguntar(t, geral, id("buscar cliente"), ana);
      await perguntar(t, geral, id("buscar cliente"), juliana);
      expect(crm.calls.map((c) => c.token)).toEqual([
        crm.oauth.tokenOf("ana-no-crm")!,
        crm.oauth.tokenOf("juliana-no-crm")!,
      ]);
    },
    LONGO,
  );
});

describe("o retorno do login", () => {
  test(
    "só quem começou termina, o retorno vale uma vez, e o login negado ou atrasado volta com o motivo, sem gravar nada",
    async () => {
      const t = await testApp();
      await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
      const comecar = async () => {
        const res = await t
          .as(juliana)
          .post("/api/connectors/login", { name: "CRM", url: crm.url, origin: INSTALACAO });
        expect(res.status).toBe(200);
        const { authorizationUrl } = (await res.json()) as ConnectorLoginDto;
        const login = await fetch(authorizationUrl, { redirect: "manual" });
        const back = new URL(login.headers.get("location")!);
        return `${back.pathname}${back.search}`;
      };
      const destinoDe = async (who: Person, retorno: string) => {
        const res = await t.as(who).get(retorno, { redirect: "manual" });
        expect(res.status).toBe(302);
        const to = new URL(res.headers.get("location")!, INSTALACAO);
        return { path: to.pathname, ok: to.searchParams.get("conector"), erro: to.searchParams.get("erro") };
      };

      // O retorno de outra pessoa não vale (nem gasta o fluxo de quem começou).
      const retorno = await comecar();
      expect(await destinoDe(ana, retorno)).toMatchObject({
        path: "/perfil/conectores",
        erro: expect.stringContaining("Ligue de novo"),
      });
      expect(await destinoDe(juliana, retorno)).toMatchObject({ path: "/conectores", ok: "ligado" });
      // De novo, o mesmo retorno já não vale.
      expect((await destinoDe(juliana, retorno)).erro).toContain("não é de um login em andamento");
      expect((await conectores(t)).length).toBe(1);
      await t.as(juliana).delete(`/api/connectors/${(await conectores(t))[0]!.id}`);

      // Negado no servidor: volta com o motivo.
      crm.oauth.denyNext();
      expect((await destinoDe(juliana, await comecar())).erro).toBe(
        "O login no CRM não foi concluído (access_denied).",
      );

      // Depois de 15 min, o fluxo venceu.
      const atrasado = await comecar();
      t.clock.advance(16 * MIN);
      expect((await destinoDe(juliana, atrasado)).erro).toBe("O login no CRM demorou demais. Ligue de novo.");
      expect(await conectores(t)).toEqual([]);
    },
    LONGO,
  );

  test(
    "o Admin religa pelo login a credencial do Workspace recusada",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: {} });
      crm.oauth.loginAs("time-no-crm");
      const { conector, id } = await adicionarPeloLogin(t, crm);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      // O token e a renovação deixam de valer: o 401 tenta renovar, e a renovação é recusada.
      crm.revoke(crm.oauth.tokenOf("time-no-crm")!);
      crm.oauth.refuseRenewal();
      await perguntar(t, geral, id("buscar cliente"));
      expect((await conectores(t))[0]).toMatchObject({ credentialState: "refused" });

      crm.oauth.loginAs("time-de-novo");
      const res = await t.as(juliana).post(`/api/connectors/${conector.id}/credential/login`, { origin: INSTALACAO });
      expect(res.status).toBe(200);
      const destino = await seguirLogin(t, juliana, ((await res.json()) as ConnectorLoginDto).authorizationUrl);
      expect(`${destino.pathname}${destino.search}`).toBe("/conectores?conector=ligado");
      expect((await conectores(t))[0]).toMatchObject({ credentialState: "ok", refusedAt: null });
      await perguntar(t, geral, id("buscar cliente"));
      expect(crm.calls.at(-1)?.token).toBe(crm.oauth.tokenOf("time-de-novo")!);
      // Só o Admin começa.
      expect(
        (await t.as(ana).post(`/api/connectors/${conector.id}/credential/login`, { origin: INSTALACAO })).status,
      ).toBe(403);
    },
    LONGO,
  );
});

describe("renovação", () => {
  test(
    "a credencial do Workspace se renova sozinha antes de vencer: a chamada depois sai com o token novo (o velho já não vale)",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: { expiresIn: 3600 } });
      crm.oauth.loginAs("time-no-crm");
      const { id } = await adicionarPeloLogin(t, crm);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      const primeiro = crm.oauth.tokenOf("time-no-crm")!;

      // Longe do vencimento, nada se renova. O reinício é o ponto de sincronização: parar espera a
      // volta da vigia que o relógio disparou terminar (e a da subida também não renova).
      t.clock.advance(30 * MIN);
      await t.restart();
      expect(crm.oauth.renewals()).toBe(0);

      // A 5 min de vencer, a vigia renova, sem ninguém usar: a volta que o relógio dispara ou, se ela
      // ainda não se rearmou, a da subida (o reinício espera a volta em curso e faz uma).
      t.clock.advance(25 * MIN);
      await t.restart();
      await eventually("a credencial ser renovada", async () => crm.oauth.renewals() === 1);
      const novo = crm.oauth.tokenOf("time-no-crm")!;
      expect(novo).not.toBe(primeiro);
      expect((await conectores(t))[0]).toMatchObject({ credentialState: "ok" });

      const { resposta } = await perguntar(t, geral, id("buscar cliente"));
      expect(resposta.body).toBe("A Acme é Ouro.");
      expect(crm.calls.map((c) => c.token)).toEqual([novo]);
    },
    LONGO,
  );

  test(
    "um token que vence logo se renova no uso, antes de a chamada sair",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: { expiresIn: 60 } });
      crm.oauth.loginAs("time-no-crm");
      const { id } = await adicionarPeloLogin(t, crm);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      const primeiro = crm.oauth.tokenOf("time-no-crm")!;

      await perguntar(t, geral, id("buscar cliente"));
      expect(crm.oauth.renewals()).toBe(1);
      expect(crm.calls.map((c) => c.token)).toEqual([crm.oauth.tokenOf("time-no-crm")!]);
      expect(crm.calls[0]!.token).not.toBe(primeiro);
    },
    LONGO,
  );

  test(
    "renovação recusada na do Workspace: a credencial fica recusada (o Admin vê no Conector) e a Ferramenta falha com o motivo",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: { expiresIn: 3600 } });
      const { id } = await adicionarPeloLogin(t, crm);
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      crm.oauth.refuseRenewal();

      t.clock.advance(55 * MIN);
      const recusado = await eventually("a recusa aparecer no Conector", async () => {
        const [c] = await conectores(t);
        return c?.credentialState === "refused" ? c : undefined;
      });
      expect(recusado.refusedAt).toBe(t.clock.now().toISOString());

      const aba = await t.socket(juliana);
      t.anthropic.reply({ toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] }, { text: "Sem o CRM." });
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");
      const falhou = await andamento(aba, origem, (e) => e.tools.some((f) => f.state === "failed"));
      expect(falhou.tools.at(-1)).toMatchObject({ state: "failed", reason: "o CRM recusou a credencial do Workspace" });
      await respostaA(t, geral.id, origem);
    },
    LONGO,
  );

  test(
    "renovação recusada na de um Membro: a credencial dele fica recusada no Perfil e ele é avisado por push",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const crm = remoteMcp({ tools: CRM_TOOLS, oauth: { expiresIn: 3600 } });
      const { conector, id } = await adicionarPeloLogin(t, crm, "member");
      await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id("buscar cliente")}`);
      const aparelho = await t.pushDevice(juliana);
      const aba = await t.socket(juliana);
      crm.oauth.refuseRenewal();

      t.clock.advance(55 * MIN);
      const { connector } = await aba.next("my_connector.updated", { timeoutMs: 10_000 });
      expect(connector).toMatchObject({ id: conector.id, credentialState: "refused" });
      const push = await aparelho.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({
        title: "O CRM recusou a sua credencial",
        navigate: expect.stringContaining("/perfil/conectores"),
      });

      // Recusada, a Ferramenta fica indisponível, com o atalho para ligar de novo.
      t.anthropic.reply({ toolUse: [{ name: id("buscar cliente"), input: { nome: "Acme" } }] }, { text: "Sem o CRM." });
      const origem = await enviar(t, geral.id, "@Faro a Acme é cliente?");
      const falhou = await andamento(aba, origem, (e) => e.tools.some((f) => f.state === "failed"));
      expect(falhou.tools.at(-1)).toMatchObject({
        reason: "indisponível: o CRM recusou a credencial do autor",
        connect: { connectorId: conector.id, name: "CRM" },
      });
      await respostaA(t, geral.id, origem);
      expect(crm.calls).toEqual([]);
    },
    LONGO,
  );
});

describe("sem login no servidor", () => {
  test("o servidor anuncia o recurso de outro sistema: não há login (o token iria para ele)", async () => {
    const t = await testApp();
    await workspace(t);
    const crm = remoteMcp({ tools: CRM_TOOLS, oauth: { resource: "https://graph.exemplo.com/" } });

    const res = await t.as(juliana).post("/api/connectors/login", { name: "CRM", url: crm.url, origin: INSTALACAO });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "oauth_unavailable",
      message: expect.stringContaining("outro endereço"),
    });
    expect(await conectores(t)).toEqual([]);
  });

  test(
    'o servidor não oferece login: "Ligar" diz para colar um token, e o token colado continua valendo',
    async () => {
      const t = await testApp();
      await workspace(t);
      const crm = remoteMcp({ token: "token-colado", tools: CRM_TOOLS });

      const res = await t.as(juliana).post("/api/connectors/login", { name: "CRM", url: crm.url, origin: INSTALACAO });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: "oauth_unavailable",
        message: expect.stringContaining("cole um token"),
      });
      expect(await conectores(t)).toEqual([]);

      const colado = await t.as(juliana).post("/api/connectors", {
        name: "CRM",
        url: crm.url,
        token: "token-colado",
        credential: "member",
      });
      expect(colado.status).toBe(201);
      const conector = (await colado.json()) as ConnectorDto;
      const doMembro = await t
        .as(ana)
        .post(`/api/me/connectors/${conector.id}/credential/login`, { origin: INSTALACAO });
      expect(doMembro.status).toBe(422);
      expect(await doMembro.json()).toMatchObject({ error: "oauth_unavailable" });

      // O token colado não vence: o tempo passa e nada tenta renová-lo.
      t.clock.advance(24 * 60 * MIN);
      // Parar espera a volta da vigia que o relógio disparou terminar.
      await t.restart();
      const relido = (await (await t.as(juliana).get(`/api/connectors/${conector.id}`)).json()) as ConnectorDto;
      expect(relido).toMatchObject({
        catalogError: null,
      });
    },
    LONGO,
  );

  test(
    "um endereço que não responde: o login não começa, com o motivo",
    async () => {
      const t = await testApp();
      await workspace(t);
      const res = await t
        .as(juliana)
        .post("/api/connectors/login", { name: "CRM", url: "http://127.0.0.1:1/mcp", origin: INSTALACAO });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "connector_unreachable" });
    },
    LONGO,
  );
});
