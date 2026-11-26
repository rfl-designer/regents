import { describe, expect, test } from "bun:test";
import {
  type AccountDto,
  type ServerEvent,
  type WikiDto,
  type WikiPageDto,
  type WikiSyncDto,
  wikiSyncPayerText,
} from "@shearim/contracts";
import { RETRY_DELAY_MS } from "../src/executions";
import { STALL_MS } from "../src/model/call";
import type { FakeClaudeCall, FakeRun } from "./fake-claude";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type TestApp, testApp } from "./harness";

// A Sincronização pela Conta do Admin (#80; spec #74, ADR 0015 e ADR 0006): a Conta de quem apertou
// "Sincronizar" paga, com a Chave do Workspace como reserva, pela mesma tabela de quem paga das
// execuções, decidida a cada chamada. Pela Conta, as Ferramentas internas do rascunho chegam ao
// `claude -p` por uma sessão do endpoint MCP do Shearim, que só vale enquanto a chamada roda.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

async function criarWiki(t: TestApp): Promise<WikiDto> {
  const res = await t
    .as(juliana)
    .post("/api/wikis", { name: "Curso de Redes Sociais", description: "O curso transcrito, aula por aula." });
  expect(res.status).toBe(201);
  return res.json();
}

const AULA_1 = new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");
const AULA_2 = new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");

/** Juliana vira Admin, liga a Conta (e grava a Chave, se `chave`), cria a Wiki e sobe as Fontes. */
async function wikiComFontes(t: TestApp, opts: { chave: boolean; fontes?: File[] }) {
  await t.as(juliana).get("/api/me");
  if (opts.chave) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.linkAccount(juliana);
  const wiki = await criarWiki(t);
  const form = new FormData();
  for (const file of opts.fontes ?? [AULA_1]) form.append("files", file);
  const res = await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return wiki;
}

const sincronizar = (t: TestApp, wiki: WikiDto) => t.as(juliana).post(`/api/wikis/${wiki.id}/sync`);

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

/** Espera a Sincronização da Wiki terminar (bem ou não) e devolve como ela ficou. */
const terminada = (t: TestApp, wiki: WikiDto) =>
  eventually(
    "a Sincronização terminar",
    async () => {
      const sync = (await naAdministracao(t, wiki)).lastSync;
      return sync && !["queued", "running"].includes(sync.state) ? sync : undefined;
    },
    20_000,
  );

/** Um `-p` da Sincronização que escreve a página `slug` (da Fonte `fonte`) pelo endpoint MCP. */
const escreve = (slug: string, fonte: string): FakeRun => ({
  kind: "steps",
  steps: [
    {
      tool: {
        name: "escrever_pagina",
        input: { slug, titulo: slug, corpo: `Sobre ${slug}.`, fontes: [fonte] },
      },
    },
    { text: "Pronto." },
  ],
});

const flag = (c: FakeClaudeCall, name: string) =>
  c.argv.includes(name) ? c.argv[c.argv.indexOf(name) + 1] : undefined;

describe("a Conta do Admin paga a Sincronização", () => {
  test(
    "sem Chave do Workspace, as chamadas rodam pela Conta de quem clicou, as Ferramentas internas passam pela sessão MCP, e a versão é publicada",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { chave: false });
      const contradicao = { paginas: ["ganchos"], descricao: "Diz 3 e 5 segundos." };
      const revisa: FakeRun = {
        kind: "steps",
        steps: [{ tool: { name: "apontar_contradicao", input: contradicao } }, { text: "Pronto." }],
      };
      t.claude.script({ syncRuns: [escreve("ganchos", "aula-01.md"), revisa] });

      expect((await sincronizar(t, wiki)).status).toBe(202);
      const sync = await terminada(t, wiki);
      expect(sync).toMatchObject({ state: "done", version: 1, payer: "account" });
      expect(sync.report!.contradictions).toEqual([
        { pages: [{ slug: "ganchos", title: "ganchos" }], text: "Diz 3 e 5 segundos." },
      ]);

      // A Fonte e a revisão (#87), as duas pela Conta.
      const [chamada, revisao, ...outras] = t.claude.syncs();
      expect(outras).toEqual([]);
      // A pasta da Conta de quem clicou, e só o endpoint do Shearim como servidor MCP.
      expect(chamada!.env.CLAUDE_CONFIG_DIR).toBeTruthy();
      expect(chamada!.argv).toContain("--strict-mcp-config");
      expect(flag(chamada!, "--allowedTools")).toBe("mcp__shearim");
      const mcp = t.claude.mcp().filter((e) => e.pid === chamada!.pid);
      expect(mcp[0]).toMatchObject({ listed: ["ler_pagina", "escrever_pagina", "remover_pagina"] });
      expect(mcp[1]).toMatchObject({ called: "escrever_pagina", result: { isError: false } });
      const daRevisao = t.claude.mcp().filter((e) => e.pid === revisao!.pid);
      expect(daRevisao[0]).toMatchObject({
        listed: ["ler_pagina", "escrever_pagina", "remover_pagina", "apontar_contradicao"],
      });
      expect(daRevisao[1]).toMatchObject({ called: "apontar_contradicao", result: { isError: false } });
      // Nada saiu pela Chave (não há Chave) nem pela fila das respostas.
      expect(t.anthropic.syncs).toHaveLength(0);
      expect(t.claude.callsOf("-p").filter((c) => c.stdin)).toHaveLength(0);

      const paginas = await paginasDe(t, wiki, 1);
      expect(paginas.map((p) => p.slug)).toEqual(["ganchos", "index", "log"]);
      expect(paginas[0]!.sources.map((s) => s.fileName)).toEqual(["aula-01.md"]);
    },
    LONGO,
  );
});

/** 15:45 de hoje (o relógio dos testes começa em 2026-11-24T12:00Z). */
const QUINZE_E_QUARENTA_E_CINCO = "2026-11-24T15:45:00.000Z";
/** Um `-p` da Sincronização que escreve um pedaço pela Conta e bate no limite até `iso`. */
const escreveEBateNoLimite = (iso: string): FakeRun => ({
  kind: "steps",
  steps: [
    {
      tool: {
        name: "escrever_pagina",
        input: { slug: "parcial", titulo: "Parcial", corpo: "x", fontes: ["aula-01.md"] },
      },
    },
    { rateLimit: { status: "rejected", resetsAt: Date.parse(iso) / 1000 } },
  ],
  end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
});

const syncsVistas = (eventos: ServerEvent[]) =>
  eventos.flatMap((e) => (e.type === "wiki_sync.updated" ? [e.sync] : ([] as WikiSyncDto[])));

describe("a Chave do Workspace é a reserva", () => {
  test(
    'a Conta bate no limite no meio: a chamada é refeita inteira pela Chave, sem o que a Conta escreveu, e o estado mostra "pela Chave do Workspace"',
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { chave: true });
      const aba = await t.socket(juliana);
      t.claude.script({ syncRuns: [escreveEBateNoLimite(QUINZE_E_QUARENTA_E_CINCO)] });
      t.anthropic.sync(
        {
          toolUse: [
            {
              name: "escrever_pagina",
              input: { slug: "ganchos", titulo: "Ganchos", corpo: "Os 3 segundos.", fontes: ["aula-01.md"] },
            },
          ],
        },
        { text: "Pronto." },
      );

      await sincronizar(t, wiki);
      expect(await terminada(t, wiki)).toMatchObject({ state: "done", version: 1, payer: "key" });

      expect(t.claude.syncs()).toHaveLength(1);
      // A Fonte (duas chamadas) e a revisão: a Conta segue no limite, e a Chave paga.
      expect(t.anthropic.syncs.map((r) => r.apiKey)).toEqual([CHAVE, CHAVE, CHAVE]);
      // O que a Conta escreveu antes do limite foi descartado: a versão tem só o que a Chave escreveu.
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["ganchos", "index", "log"]);
      // A Conta ficou "No limite até 15:45", como numa resposta.
      const conta: AccountDto = await (await t.as(juliana).get("/api/account")).json();
      expect(conta.status).toMatchObject({ state: "limited", until: QUINZE_E_QUARENTA_E_CINCO });

      // Na tela da Wiki: primeiro pela Conta (sem aviso), depois "pela Chave do Workspace".
      const vistas = await eventually("a conclusão chegar à aba", async () => {
        const todas = syncsVistas(aba.received());
        return todas.at(-1)?.state === "done" ? todas : undefined;
      });
      const emCurso = vistas.filter((s) => s.state === "running" && s.payer);
      expect(emCurso[0]).toMatchObject({ payer: "account" });
      expect(wikiSyncPayerText(emCurso[0]!)).toBeNull();
      expect(emCurso.at(-1)).toMatchObject({ payer: "key" });
      expect(wikiSyncPayerText(emCurso.at(-1)!)).toBe("pela Chave do Workspace");
    },
    LONGO,
  );
});

describe("sem quem pague", () => {
  test(
    'com a Conta no limite e sem Chave, a Sincronização falha com "sem quem pague" e o motivo, e a Wiki fica como estava',
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { chave: false });
      t.claude.script({ syncRuns: [escreveEBateNoLimite(QUINZE_E_QUARENTA_E_CINCO)] });

      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki);
      expect(sync.state).toBe("failed");
      expect(sync.reason).toBe(
        "sem quem pague: a Conta do Claude de Juliana está no limite, e o Workspace não tem Chave",
      );

      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: null, pending: 1 });
      expect(await (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json()).toEqual([]);
      expect(t.claude.syncs()).toHaveLength(1);
    },
    LONGO,
  );
});

const MEIO_DIA_E_UM = "2026-11-24T12:01:00.000Z";

describe("quem paga é decidido a cada chamada", () => {
  test(
    "a Conta volta às 12:01, no meio da Sincronização: a chamada seguinte já sai por ela",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t, { chave: true, fontes: [AULA_1, AULA_2] });
      t.claude.script({
        syncRuns: [escreveEBateNoLimite(MEIO_DIA_E_UM), escreve("carrossel", "aula-02.txt")],
      });

      await sincronizar(t, wiki);
      // A 1ª Fonte: a Conta bateu no limite, e a Chave refaz a chamada.
      const pelaChave = await cerebro.nextSync();
      expect((await naAdministracao(t, wiki)).lastSync).toMatchObject({
        payer: "key",
        step: { kind: "source", current: 1 },
      });
      // Um minuto depois (antes da vigia de 2 minutos), a Conta volta.
      t.clock.set(MEIO_DIA_E_UM);
      await pelaChave.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });

      // A 2ª Fonte já sai pela Conta, que voltou.
      expect(await terminada(t, wiki)).toMatchObject({ state: "done", payer: "account" });
      expect(cerebro.syncs).toHaveLength(1);
      // O limite, a 2ª Fonte e a revisão.
      expect(t.claude.syncs()).toHaveLength(3);
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["carrossel", "index", "log"]);
    },
    LONGO,
  );
});

/** O `--mcp-config` de um `-p`: o endereço e o token da sessão MCP dele. */
function sessaoDe(c: FakeClaudeCall) {
  const config = JSON.parse(flag(c, "--mcp-config")!) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const servidor = config.mcpServers.shearim!;
  return { url: servidor.url, token: servidor.headers.Authorization!.replace(/^Bearer /, "") };
}

/** Um `tools/list` direto no endpoint MCP, com o token da sessão: o status HTTP. */
async function listar({ url, token }: { url: string; token: string }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await res.body?.cancel();
  return res.status;
}

describe("o token da sessão MCP da Sincronização", () => {
  test(
    "cada chamada tem o seu, e ele deixa de valer quando a chamada acaba",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { chave: false, fontes: [AULA_1, AULA_2] });
      t.claude.script({ syncRuns: [escreve("ganchos", "aula-01.md"), { kind: "hang" }, { kind: "hang" }] });

      await sincronizar(t, wiki);
      const [primeira, segunda] = await eventually(
        "a 2ª chamada subir",
        async () => {
          const chamadas = t.claude.syncs();
          return chamadas.length === 2 ? chamadas.map(sessaoDe) : undefined;
        },
        20_000,
      );
      expect(primeira!.token).not.toBe(segunda!.token);
      // A 1ª acabou: o token dela não vale mais. A 2ª está rodando: o dela vale.
      expect(await listar(primeira!)).toBe(401);
      expect(await listar(segunda!)).toBe(200);

      // A 2ª fica muda até a vigia encerrá-la: o token dela também deixa de valer.
      t.clock.advance(STALL_MS);
      const caiu = await eventually("o token da 2ª cair", async () =>
        (await listar(segunda!)) === 401 ? true : undefined,
      );
      expect(caiu).toBe(true);
      // A nova tentativa (10 s depois) também fica muda: a vigia encerra a Sincronização.
      await eventually(
        "a nova tentativa à vista",
        async () => (await naAdministracao(t, wiki)).lastSync?.attempt === 2,
      );
      t.clock.advance(RETRY_DELAY_MS);
      await eventually("a nova tentativa subir", async () => t.claude.syncs().length === 3, 20_000);
      t.clock.advance(STALL_MS);
      expect(await terminada(t, wiki)).toMatchObject({ state: "failed" });
    },
    LONGO,
  );
});
