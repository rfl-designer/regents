/**
 * O GitHub, o Conector embutido (#57, Spec #44; ADR 0010), pela borda do servidor, com a API do
 * GitHub falsa (`fakeGitHub`) no lugar do GitHub:
 *
 * - O Admin cria o GitHub App da Instalação pelo fluxo de manifest: o navegador dele leva o
 *   formulário ao GitHub e volta ao Shearim com o código. A chave privada e os segredos ficam
 *   cifrados no banco.
 * - O Admin instala o App na conta do time e escolhe os repositórios no GitHub; o retorno liga a
 *   instalação ao Workspace (uma por Workspace).
 * - As leituras (listar repositórios, ler arquivo, listar e ler issues e pull requests) funcionam
 *   pelos dois cérebros, cada chamada com um token de instalação limitado ao repositório e às
 *   permissões da Ferramenta.
 * - Uma instalação removida no GitHub vira falha da Ferramenta com motivo, e o Admin a vê.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, AgentGitHubDto, ChannelDto, ExecutionDto, GitHubDto, MessageDto } from "@shearim/contracts";
import { schema } from "../src/db/client";
import type { FakeGitHub } from "./fakes/github-api";
import { toolResults } from "./fakes/messages-api";
import { type EventSocket, eventually, fakeGitHub, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
/** O endereço da Instalação na tailnet, de onde o PWA do Admin começa o fluxo. */
const ORIGEM = "https://shearim.time.ts.net";
const LONGO = 120_000;

async function github(t: TestApp, who: Person = juliana): Promise<GitHubDto> {
  const res = await t.as(who).get("/api/github");
  expect(res.status).toBe(200);
  return res.json();
}

/** O navegador do Admin segue um redirecionamento de volta ao Shearim (o endereço na tailnet). */
async function voltarAoShearim(t: TestApp, location: string | null, who: Person = juliana) {
  const url = new URL(location!);
  expect(url.origin).toBe(ORIGEM);
  return t.as(who).get(url.pathname + url.search, { redirect: "manual" });
}

/** Juliana cria o App: o PWA pede o manifest, o navegador o envia ao GitHub e volta ao Shearim. */
async function criarApp(t: TestApp, opts: { organization?: string } = {}) {
  const res = await t.as(juliana).post("/api/github/manifest", { origin: ORIGEM, ...opts });
  expect(res.status).toBe(200);
  const { action, manifest } = (await res.json()) as { action: string; manifest: string };
  const ida = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
  expect(ida.status).toBe(302);
  return voltarAoShearim(t, ida.headers.get("location"));
}

/** Juliana instala o App na conta do time, escolhendo os repositórios na página do GitHub. */
async function instalar(t: TestApp, gh: FakeGitHub, escolha: { account?: string; repositories?: string[] } = {}) {
  gh.willInstall(escolha);
  const res = await t.as(juliana).post("/api/github/installation");
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const ida = await fetch(url, { redirect: "manual" });
  expect(ida.status).toBe(302);
  return voltarAoShearim(t, ida.headers.get("location"));
}

async function semGitHub() {
  const gh = await fakeGitHub();
  const t = await testApp({ github: gh.config });
  await t.as(juliana).get("/api/me");
  return { t, gh };
}

describe("criar o GitHub App pelo manifest", () => {
  test("o Admin cria o App da Instalação: o manifest pede só o necessário e o retorno guarda o App", async () => {
    const { t, gh } = await semGitHub();
    expect(await github(t)).toMatchObject({ state: "none", app: null, installation: null, failure: null });

    const volta = await criarApp(t, { organization: "time" });

    // O navegador volta ao PWA, na tela do GitHub.
    expect(volta.status).toBe(302);
    expect(volta.headers.get("location")).toStartWith("/github");
    // O manifest: App privado, retornos no endereço da Instalação, as permissões das Ferramentas.
    const manifest = gh.app!.manifest;
    expect(manifest).toMatchObject({
      public: false,
      redirect_url: `${ORIGEM}/api/github/manifest/callback`,
      setup_url: `${ORIGEM}/api/github/installation/callback`,
      default_permissions: { metadata: "read", contents: "read", issues: "write", pull_requests: "write" },
    });
    expect(await github(t)).toMatchObject({
      state: "created",
      app: { slug: gh.app!.slug, owner: "time" },
      installation: null,
    });
  });

  test("a chave privada e os segredos do App ficam cifrados, nunca em texto puro no banco nem na API", async () => {
    const { t } = await semGitHub();
    await criarApp(t);

    // Propriedade que não se vê pela borda: o que fica guardado não contém os segredos.
    const guardado = JSON.stringify(await t.db.select().from(schema.githubApp));
    expect(guardado).not.toContain("PRIVATE KEY");
    expect(guardado).not.toContain("segredo-do-webhook");
    expect(guardado).not.toContain("segredo-do-cliente");
    const dto = JSON.stringify(await github(t));
    expect(dto).not.toContain("PRIVATE KEY");
    expect(dto).not.toContain("segredo");
  });

  test("um retorno sem o state do fluxo em andamento é recusado e nada é guardado", async () => {
    const { t } = await semGitHub();
    await t.as(juliana).post("/api/github/manifest", { origin: ORIGEM });

    const volta = await t.as(juliana).get("/api/github/manifest/callback?code=codigo-1&state=outro", {
      redirect: "manual",
    });

    expect(volta.status).toBe(302);
    expect(decodeURIComponent(volta.headers.get("location")!)).toContain("erro=");
    expect((await github(t)).state).toBe("none");
  });

  test("só o Admin vê ou mexe no GitHub", async () => {
    const { t } = await semGitHub();
    await t.addMember(bruno, { by: juliana });

    expect((await t.as(bruno).get("/api/github")).status).toBe(403);
    expect((await t.as(bruno).post("/api/github/manifest", { origin: ORIGEM })).status).toBe(403);
    expect((await t.as(bruno).post("/api/github/installation")).status).toBe(403);
    expect((await t.as(bruno).get("/api/github/manifest/callback?code=x&state=y")).status).toBe(403);
  });
});

describe("instalar o App na conta do time", () => {
  test("o Admin instala o App e escolhe os repositórios no GitHub; o retorno liga a instalação ao Workspace", async () => {
    const { t, gh } = await semGitHub();
    gh.repo({ fullName: "time/site" });
    await criarApp(t, { organization: "time" });

    const volta = await instalar(t, gh, { repositories: ["time/site"] });

    expect(volta.status).toBe(302);
    expect(volta.headers.get("location")).toBe("/github?github=installed");
    const estado = await github(t);
    expect(estado).toMatchObject({
      state: "installed",
      installation: { account: "time", installedAt: "2026-11-24T12:00:00.000Z" },
      failure: null,
    });
  });

  test("há uma instalação por Workspace: instalar de novo substitui a anterior", async () => {
    const { t, gh } = await semGitHub();
    await criarApp(t, { organization: "time" });
    await instalar(t, gh);
    const primeira = (await github(t)).installation!.id;

    await instalar(t, gh);

    const segunda = (await github(t)).installation!.id;
    expect(segunda).not.toBe(primeira);
  });

  test("uma instalação que o GitHub não confirma como deste App não é ligada", async () => {
    const { t } = await semGitHub();
    await criarApp(t, { organization: "time" });
    const { url } = (await (await t.as(juliana).post("/api/github/installation")).json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;

    const volta = await t
      .as(juliana)
      .get(`/api/github/installation/callback?installation_id=999&setup_action=install&state=${state}`, {
        redirect: "manual",
      });

    expect(decodeURIComponent(volta.headers.get("location")!)).toContain("erro=");
    expect((await github(t)).state).toBe("created");
  });

  test("sem App criado, não há onde instalar", async () => {
    const { t } = await semGitHub();
    expect((await t.as(juliana).post("/api/github/installation")).status).toBe(409);
  });
});

const LEITURAS = [
  "github_listar_repositorios",
  "github_ler_arquivo",
  "github_listar_issues",
  "github_ler_issue",
  "github_listar_pull_requests",
  "github_ler_pull_request",
];

/**
 * O GitHub ligado: dois repositórios na conta do time, o App criado e instalado só no `time/site`,
 * a Chave gravada e o Faro, com as leituras do GitHub, no #geral.
 */
async function comGitHub(opts: { repositories?: string[] } = {}) {
  const gh = await fakeGitHub();
  gh.repo({
    fullName: "time/site",
    description: "O site do time",
    files: { "README.md": "# Site\nPara rodar: bun dev" },
    issues: [
      {
        number: 214,
        title: "Checkout quebra no Safari",
        body: "O botão de pagar não responde.",
        author: "ana",
        comments: [{ author: "bruno", body: "Reproduzi no iOS 19." }],
      },
      { number: 215, title: "Corrige o checkout", author: "ana", pull: { head: "fix/checkout", base: "main" } },
    ],
  });
  gh.repo({ fullName: "time/infra", files: { "segredo.tf": "senha" } });
  gh.repo({ fullName: "time/docs" });
  const t = await testApp({ github: gh.config });
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await criarApp(t, { organization: "time" });
  await instalar(t, gh, { repositories: opts.repositories ?? ["time/site"] });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Engenharia: o site.",
      instructions: "Você é o Faro, da engenharia.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  for (const id of LEITURAS) expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${id}`)).status).toBe(200);
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  return { t, gh, faro, geral: geral! };
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

/** Os `tool_result` que voltaram ao modelo na segunda chamada da resposta, por id do `tool_use`. */
function resultados(t: TestApp) {
  const volta = t.anthropic.requests.at(-1)!;
  return new Map(toolResults(volta.body).map((r) => [r.tool_use_id, r]));
}

/** Todos os Andamentos da execução de `origem` que chegaram à aba até a resposta terminar. */
async function andamentos(aba: EventSocket, origem: MessageDto) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.originMessageId === origem.id && execution.state === "done") break;
  }
  return aba
    .received()
    .flatMap((e) => (e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : []))
    .filter((e): e is ExecutionDto => Boolean(e));
}

describe("as leituras do GitHub", () => {
  test(
    "o Admin vê as Ferramentas do GitHub na tela do Agente, de origem GitHub e só leitura",
    async () => {
      const { t, faro } = await comGitHub();
      const lista = (await (await t.as(juliana).get(`/api/agents/${faro.id}/tools`)).json()) as {
        id: string;
        origin: string;
        access: string;
        granted: boolean;
      }[];
      const doGitHub = lista.filter((f) => f.origin === "github");
      expect(doGitHub.map((f) => f.id)).toEqual(LEITURAS);
      expect(doGitHub.every((f) => f.access === "read" && f.granted)).toBe(true);
    },
    LONGO,
  );

  test(
    "pela Chave, o Agente lista repositórios, lê arquivo, issues e pull requests, cada chamada com um token limitado ao repositório e às permissões da Ferramenta",
    async () => {
      const { t, gh, geral } = await comGitHub();
      const site = { repositorio: "time/site" };
      t.anthropic.reply(
        {
          toolUse: [
            { id: "t1", name: "github_listar_repositorios" },
            { id: "t2", name: "github_ler_arquivo", input: { ...site, caminho: "README.md" } },
            { id: "t3", name: "github_listar_issues", input: site },
            { id: "t4", name: "github_ler_issue", input: { ...site, numero: 214 } },
            { id: "t5", name: "github_listar_pull_requests", input: site },
            { id: "t6", name: "github_ler_pull_request", input: { ...site, numero: 215 } },
          ],
        },
        { text: "O checkout tem conserto a caminho." },
      );

      const origem = await enviar(t, geral.id, "@Faro como está o checkout?");
      expect((await respostaA(t, geral.id, origem)).body).toBe("O checkout tem conserto a caminho.");

      const r = resultados(t);
      expect(r.get("t1")!.content).toContain("time/site (privado, branch main): O site do time");
      // A instalação só alcança o que o Admin escolheu no GitHub.
      expect(r.get("t1")!.content).not.toContain("time/infra");
      expect(r.get("t2")!.content).toContain("Para rodar: bun dev");
      expect(r.get("t3")!.content).toContain("#214 [aberta] Checkout quebra no Safari (por ana)");
      expect(r.get("t3")!.content).not.toContain("#215");
      expect(r.get("t4")!.content).toContain("O botão de pagar não responde.");
      expect(r.get("t4")!.content).toContain("bruno: Reproduzi no iOS 19.");
      expect(r.get("t5")!.content).toContain("#215 [aberto] Corrige o checkout (fix/checkout → main, por ana)");
      expect(r.get("t6")!.content).toContain("Pull request #215 de time/site [aberto]: Corrige o checkout");
      for (const res of r.values()) expect(res.is_error).toBeFalsy();

      // Um token por chamada de Ferramenta, limitado ao repositório e às permissões dela.
      expect(gh.tokens.map(({ repositories, permissions }) => ({ repositories, permissions }))).toEqual([
        { repositories: null, permissions: { metadata: "read" } },
        { repositories: ["site"], permissions: { contents: "read" } },
        { repositories: ["site"], permissions: { issues: "read" } },
        { repositories: ["site"], permissions: { issues: "read" } },
        { repositories: ["site"], permissions: { pull_requests: "read" } },
        { repositories: ["site"], permissions: { pull_requests: "read" } },
      ]);
      // E nenhuma chamada à API saiu sem token de instalação.
      expect(gh.calls.length).toBeGreaterThanOrEqual(6);
      expect(gh.calls.every((c) => c.token !== null && c.status === 200)).toBe(true);
    },
    LONGO,
  );

  test(
    "um repositório que a instalação não alcança vira falha da Ferramenta com motivo, e a resposta segue",
    async () => {
      const { t, geral } = await comGitHub();
      t.anthropic.reply(
        {
          toolUse: [
            { id: "t1", name: "github_ler_arquivo", input: { repositorio: "time/infra", caminho: "segredo.tf" } },
            { id: "t2", name: "github_ler_issue", input: { repositorio: "time/site", numero: 999 } },
          ],
        },
        { text: "Não consegui ler." },
      );

      const origem = await enviar(t, geral.id, "@Faro lê o segredo.tf da infra?");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Não consegui ler.");

      const r = resultados(t);
      expect(r.get("t1")).toMatchObject({ is_error: true });
      expect(r.get("t1")!.content).toContain("o repositório time/infra não está entre os que o GitHub App alcança");
      expect(r.get("t1")!.content).not.toContain("senha");
      expect(r.get("t2")!.content).toContain("não achei a issue 999 em time/site");
    },
    LONGO,
  );
});

describe("pela Conta e no Andamento", () => {
  test(
    "pela Conta, o claude -p lê a issue pelo endpoint MCP do Shearim, e o Andamento mostra o passo da Ferramenta",
    async () => {
      const { t, gh, geral } = await comGitHub();
      await t.linkAccount(juliana);
      const aba = await t.socket(juliana);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [
            { tool: { name: "github_ler_issue", input: { repositorio: "time/site", numero: 214 } } },
            { text: "{resultado}" },
          ],
        },
      });

      const origem = await enviar(t, geral.id, "@Faro o que diz a issue 214?");
      const resposta = await respostaA(t, geral.id, origem);

      expect(resposta.body).toContain("Issue #214 de time/site [aberta]: Checkout quebra no Safari");
      const vistos = await andamentos(aba, origem);
      // Pagou a Conta: o Andamento não marca a Chave.
      expect(vistos.at(-1)!.payer).toBeNull();
      expect(t.claude.mcp()).toContainEqual(expect.objectContaining({ called: "github_ler_issue" }));
      expect(vistos).toContainEqual(
        expect.objectContaining({
          step: "tool",
          tools: [
            expect.objectContaining({ tool: "github_ler_issue", label: "lendo uma issue do GitHub", state: "running" }),
          ],
        }),
      );
      expect(gh.tokens.map((k) => [k.repositories, k.permissions])).toEqual([[["site"], { issues: "read" }]]);
    },
    LONGO,
  );
});

describe("a instalação removida no GitHub", () => {
  test(
    "vira falha da Ferramenta com motivo no Andamento, o Admin vê a falha no GitHub, e instalar de novo a limpa",
    async () => {
      const { t, gh, geral } = await comGitHub();
      const aba = await t.socket(juliana);
      gh.uninstall();
      t.anthropic.reply({ toolUse: [{ id: "t1", name: "github_listar_repositorios" }] }, { text: "O GitHub falhou." });

      const origem = await enviar(t, geral.id, "@Faro quais repositórios temos?");
      expect((await respostaA(t, geral.id, origem)).body).toBe("O GitHub falhou.");

      const motivo =
        "a instalação do GitHub App foi removida ou suspensa no GitHub; o Admin precisa instalá-lo de novo";
      expect(resultados(t).get("t1")).toMatchObject({ is_error: true });
      expect(resultados(t).get("t1")!.content).toContain(motivo);
      const vistos = await andamentos(aba, origem);
      expect(vistos).toContainEqual(
        expect.objectContaining({
          tools: [expect.objectContaining({ tool: "github_listar_repositorios", state: "failed", reason: motivo })],
        }),
      );
      expect(await github(t)).toMatchObject({
        state: "installed",
        failure: { reason: motivo, at: "2026-11-24T12:00:00.000Z" },
      });

      await instalar(t, gh, { repositories: ["time/site"] });
      expect((await github(t)).failure).toBeNull();
    },
    LONGO,
  );
});

/** O que o Admin vê dos repositórios de um Agente na tela dele. */
async function repositoriosDo(t: TestApp, agentId: string): Promise<AgentGitHubDto> {
  const res = await t.as(juliana).get(`/api/agents/${agentId}/github`);
  expect(res.status).toBe(200);
  return res.json();
}

async function restringir(t: TestApp, agentId: string, repositories: string[] | null) {
  return t.as(juliana).put(`/api/agents/${agentId}/github`, { repositories });
}

async function agente(t: TestApp, id: string, who: Person = juliana): Promise<AgentDto> {
  const lista = (await (await t.as(who).get("/api/agents")).json()) as AgentDto[];
  return lista.find((a) => a.id === id)!;
}

describe("os repositórios do GitHub por Agente", () => {
  test(
    "na tela do Agente, o Admin vê os repositórios que a instalação alcança; sem lista, o Agente alcança todos",
    async () => {
      const { t, gh, faro, geral } = await comGitHub({ repositories: ["time/site", "time/infra"] });

      expect(await repositoriosDo(t, faro.id)).toEqual({
        repositories: null,
        available: ["time/infra", "time/site"],
        failure: null,
      });

      const antes = gh.tokens.length;
      t.anthropic.reply(
        {
          toolUse: [
            { id: "t1", name: "github_listar_repositorios" },
            { id: "t2", name: "github_ler_arquivo", input: { repositorio: "time/infra", caminho: "segredo.tf" } },
          ],
        },
        { text: "Pronto." },
      );
      const origem = await enviar(t, geral.id, "@Faro o que tem na infra?");
      await respostaA(t, geral.id, origem);

      const r = resultados(t);
      expect(r.get("t1")!.content).toContain("time/site");
      expect(r.get("t1")!.content).toContain("time/infra");
      expect(r.get("t2")!.is_error).toBeFalsy();
      expect(r.get("t2")!.content).toContain("senha");
      expect(gh.tokens.slice(antes).map((k) => k.repositories)).toEqual([null, ["infra"]]);
    },
    LONGO,
  );

  test(
    "com lista, as Ferramentas do GitHub desse Agente não veem nem alcançam os outros repositórios",
    async () => {
      const { t, gh, faro, geral } = await comGitHub({ repositories: ["time/site", "time/infra"] });
      const res = await restringir(t, faro.id, ["time/site"]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        repositories: ["time/site"],
        available: ["time/infra", "time/site"],
        failure: null,
      });
      expect((await repositoriosDo(t, faro.id)).repositories).toEqual(["time/site"]);

      const antes = gh.tokens.length;
      t.anthropic.reply(
        {
          toolUse: [
            { id: "t1", name: "github_listar_repositorios" },
            { id: "t2", name: "github_ler_arquivo", input: { repositorio: "time/infra", caminho: "segredo.tf" } },
            { id: "t3", name: "github_listar_issues", input: { repositorio: "Time/Infra" } },
            { id: "t4", name: "github_ler_arquivo", input: { repositorio: "time/site", caminho: "README.md" } },
          ],
        },
        { text: "Só o site." },
      );
      const origem = await enviar(t, geral.id, "@Faro o que tem na infra?");
      await respostaA(t, geral.id, origem);

      const r = resultados(t);
      // Não vê: a listagem só traz os da lista.
      expect(r.get("t1")!.content).toContain("time/site");
      expect(r.get("t1")!.content).not.toContain("time/infra");
      // Não alcança: falha com motivo, sem nenhum token para o outro repositório.
      for (const id of ["t2", "t3"]) {
        expect(r.get(id)).toMatchObject({ is_error: true });
        expect(r.get(id)!.content).toContain("não está entre os repositórios do GitHub que este Agente alcança");
      }
      expect(r.get("t2")!.content).not.toContain("senha");
      expect(r.get("t4")!.content).toContain("Para rodar: bun dev");
      expect(gh.tokens.slice(antes).map((k) => k.repositories)).toEqual([["site"], ["site"]]);
    },
    LONGO,
  );

  test(
    "tirar a lista devolve ao Agente tudo o que a instalação alcança",
    async () => {
      const { t, faro } = await comGitHub({ repositories: ["time/site", "time/infra"] });
      await restringir(t, faro.id, ["time/site"]);

      const res = await restringir(t, faro.id, null);

      expect(res.status).toBe(200);
      expect((await res.json()).repositories).toBeNull();
      expect((await repositoriosDo(t, faro.id)).repositories).toBeNull();
    },
    LONGO,
  );

  test(
    "a lista só aceita repositórios que a instalação alcança, nunca vazia, e só o Admin a mexe",
    async () => {
      const { t, faro } = await comGitHub();
      await t.addMember(bruno, { by: juliana });

      const fora = await restringir(t, faro.id, ["time/infra"]);
      expect(fora.status).toBe(400);
      expect((await fora.json()).message).toContain("time/infra não está entre os que a instalação do GitHub alcança");
      expect((await restringir(t, faro.id, [])).status).toBe(400);
      expect((await restringir(t, faro.id, "time/site" as unknown as string[])).status).toBe(400);
      expect((await repositoriosDo(t, faro.id)).repositories).toBeNull();

      expect((await t.as(bruno).get(`/api/agents/${faro.id}/github`)).status).toBe(403);
      expect((await t.as(bruno).put(`/api/agents/${faro.id}/github`, { repositories: ["time/site"] })).status).toBe(
        403,
      );
      expect((await t.as(juliana).get(`/api/agents/${crypto.randomUUID()}/github`)).status).toBe(404);
    },
    LONGO,
  );

  test(
    "sem o GitHub instalado, a tela do Agente diz por que não há repositórios para escolher",
    async () => {
      const { t } = await semGitHub();
      const faro: AgentDto = await (
        await t.as(juliana).post("/api/agents", { name: "Faro", photo: null, model: "claude-sonnet-5-5" })
      ).json();

      expect(await repositoriosDo(t, faro.id)).toEqual({
        repositories: null,
        available: [],
        failure: "o GitHub não está instalado no Workspace",
      });
      expect((await restringir(t, faro.id, ["time/site"])).status).toBe(409);
    },
    LONGO,
  );

  test(
    "a descrição do Agente diz que ele acessa o GitHub com a credencial do Workspace e, com lista, em quais repositórios",
    async () => {
      const { t, faro } = await comGitHub({ repositories: ["time/site", "time/infra", "time/docs"] });
      await t.addMember(bruno, { by: juliana });
      const linha = "acessa o GitHub com a credencial do Workspace";

      // Sem lista: tudo o que a instalação alcança. Todo Membro vê a linha.
      expect((await agente(t, faro.id, bruno)).reach).toEqual([linha]);
      expect((await agente(t, faro.id)).githubRepositories).toBeNull();

      expect((await restringir(t, faro.id, ["time/site", "time/docs"])).status).toBe(200);
      expect((await agente(t, faro.id, bruno)).reach).toEqual([`${linha}, só nos repositórios time/docs e time/site`]);
      // A lista em si é da configuração, só do Admin.
      expect((await agente(t, faro.id, bruno)).githubRepositories).toBeUndefined();
      expect((await agente(t, faro.id)).githubRepositories).toEqual(["time/docs", "time/site"]);

      await restringir(t, faro.id, ["time/site"]);
      expect((await agente(t, faro.id, bruno)).reach).toEqual([`${linha}, só no repositório time/site`]);

      // Sem Ferramenta do GitHub, a descrição não fala do GitHub, mesmo com lista.
      for (const id of LEITURAS) await t.as(juliana).delete(`/api/agents/${faro.id}/tools/${id}`);
      expect((await agente(t, faro.id, bruno)).reach).toEqual([]);
    },
    LONGO,
  );
});
