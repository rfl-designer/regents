import { describe, expect, test } from "bun:test";
import type { AgentDto, WikiDto, WikiPageDto, WikiSourceDto } from "@shearim/contracts";
import { RETRY_DELAY_MS } from "../src/executions";
import { STALL_MS } from "../src/model/call";
import { scriptedBrain } from "./fakes/scripted-brain";
import { eventually, type Person, type PushDevice, type TestApp, testApp } from "./harness";

// Falhas, cancelamento e reinício da Sincronização (#86; spec #74, ADR 0003 e ADR 0015): a
// Sincronização nunca fica no limbo e nunca deixa a Wiki pela metade. Cada falha, cancelamento ou
// reinício termina à vista, com o motivo, e a Wiki fica como estava.

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" }; // Admin (chega primeiro)
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 30_000;
const SOBRECARGA = { status: 529, errorType: "overloaded_error", errorMessage: "Overloaded" };

const AULA_1 = new File(["# Aula 1\n\nO gancho vem nos 3 primeiros segundos.\n"], "aula-01.md");
const AULA_2 = new File(["Aula 2. Carrossel: uma ideia por cartão."], "aula-02.txt");

/** Juliana Admin (com a Chave, se `chave`), o Bruno Membro, a Wiki e as Fontes pendentes. */
async function wikiComFontes(t: TestApp, opts: { chave?: boolean; fontes?: File[] } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  await t.addMember(bruno, { by: juliana });
  const res = await t
    .as(juliana)
    .post("/api/wikis", { name: "Curso de Redes Sociais", description: "O curso transcrito, aula por aula." });
  expect(res.status).toBe(201);
  const wiki: WikiDto = await res.json();
  const form = new FormData();
  for (const file of opts.fontes ?? [AULA_1, AULA_2]) form.append("files", file);
  expect((await t.as(juliana).request(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form })).status).toBe(
    201,
  );
  return wiki;
}

const sincronizar = (t: TestApp, wiki: WikiDto, who: Person = juliana) => t.as(who).post(`/api/wikis/${wiki.id}/sync`);

const naAdministracao = async (t: TestApp, wiki: WikiDto): Promise<WikiDto> => {
  const lista: WikiDto[] = await (await t.as(juliana).get("/api/wiki-settings")).json();
  return lista.find((w) => w.id === wiki.id)!;
};

const fontesDe = async (t: TestApp, wiki: WikiDto): Promise<WikiSourceDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/sources`)).json();

const paginasDe = async (t: TestApp, wiki: WikiDto, versao: number): Promise<WikiPageDto[]> =>
  (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions/${versao}/pages`)).json();

/**
 * Espera a Sincronização terminar e devolve como ela ficou. Com `andando`, a nova tentativa sai: o
 * relógio anda os 10 s uma vez, quando a tela mostra a 2ª tentativa (e só uma vez, para a vigia da
 * nova tentativa não vencer).
 */
const terminada = (t: TestApp, wiki: WikiDto, opts: { andando?: boolean } = {}) => {
  let andou = false;
  return eventually(
    "a Sincronização terminar",
    async () => {
      const sync = (await naAdministracao(t, wiki)).lastSync;
      if (sync && !["queued", "running"].includes(sync.state)) return sync;
      if (opts.andando && !andou && sync?.attempt === 2) {
        andou = true;
        t.clock.advance(RETRY_DELAY_MS);
      }
      return undefined;
    },
    20_000,
  );
};

/** A Wiki ficou como estava antes: nenhuma versão, e as duas Fontes ainda pendentes. */
async function comoEstava(t: TestApp, wiki: WikiDto) {
  expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: null, pending: 2 });
  expect(await (await t.as(juliana).get(`/api/wikis/${wiki.id}/versions`)).json()).toEqual([]);
  expect((await fontesDe(t, wiki)).map((f) => f.pending)).toEqual(["new", "new"]);
}

const escritaDaAula1 = {
  toolUse: [
    {
      name: "escrever_pagina",
      input: { slug: "ganchos", titulo: "Ganchos", corpo: "Os 3 primeiros segundos.", fontes: ["aula-01.md"] },
    },
  ],
};

const escritaDaAula2 = {
  toolUse: [
    {
      name: "escrever_pagina",
      input: { slug: "carrossel", titulo: "Carrossel", corpo: "Uma ideia por cartão.", fontes: ["aula-02.txt"] },
    },
  ],
};

describe("uma chamada que falha no meio", () => {
  test(
    "é tentada de novo uma vez sozinha, sem o que a primeira escreveu, e a Sincronização conclui",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t);
      t.anthropic.sync(
        { text: "Pronto." },
        // A 2ª Fonte escreve uma página e cai no meio; a nova tentativa a refaz inteira.
        escritaDaAula2,
        SOBRECARGA,
        { text: "Pronto." },
      );

      await sincronizar(t, wiki);
      expect(await terminada(t, wiki, { andando: true })).toMatchObject({ state: "done", reason: null, version: 1 });
      // As duas Fontes (a 2ª em duas tentativas) e a revisão.
      expect(t.anthropic.syncs).toHaveLength(5);
      // O que a 1ª tentativa escreveu foi descartado: a nova tentativa não escreveu nada.
      expect((await paginasDe(t, wiki, 1)).map((p) => p.slug)).toEqual(["index", "log"]);
    },
    LONGO,
  );

  test(
    'se a segunda também falha, ela termina em "falhou: <motivo>", o rascunho é descartado e a Wiki fica como estava',
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t);
      t.anthropic.sync({ text: "Pronto." }, escritaDaAula2, SOBRECARGA, escritaDaAula2, SOBRECARGA);

      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki, { andando: true });
      expect(sync.state).toBe("failed");
      expect(sync.reason).toContain("nas duas tentativas");
      expect(t.anthropic.syncs).toHaveLength(5);
      await comoEstava(t, wiki);
    },
    LONGO,
  );
});

describe("uma chamada que não responde", () => {
  test(
    "falha depois do prazo da vigia, com o motivo, nas duas tentativas",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      await sincronizar(t, wiki);

      // A 1ª chamada fica muda: a vigia de 2 minutos a encerra, e a nova tentativa sai 10 s depois.
      const primeira = await cerebro.nextSync();
      t.clock.advance(STALL_MS);
      const emEspera = await eventually("a nova tentativa à vista", async () => {
        const sync = (await naAdministracao(t, wiki)).lastSync!;
        return sync.attempt === 2 ? sync : undefined;
      });
      expect(primeira.signal.aborted).toBe(true);
      expect(emEspera).toMatchObject({ state: "running", reason: "a Articuladora ficou 2 minutos sem responder" });
      t.clock.advance(RETRY_DELAY_MS);

      // A nova tentativa também fica muda.
      const segunda = await cerebro.nextSync();
      t.clock.advance(STALL_MS);
      const sync = await terminada(t, wiki);
      expect(segunda.signal.aborted).toBe(true);
      expect(sync).toMatchObject({
        state: "failed",
        reason: "a Articuladora ficou 2 minutos sem responder, nas duas tentativas",
      });
      expect(cerebro.syncs).toHaveLength(2);
      await comoEstava(t, wiki);
    },
    LONGO,
  );
});

const cancelar = (t: TestApp, wiki: WikiDto, who: Person = juliana) =>
  t.as(who).post(`/api/wikis/${wiki.id}/sync/cancel`);

describe("o Admin cancela uma Sincronização em curso", () => {
  test(
    'a chamada em curso é interrompida, ela termina em "cancelada", e a Wiki fica como estava',
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      const doBruno = await t.socket(bruno);
      await sincronizar(t, wiki);
      const primeira = await cerebro.nextSync();
      await primeira.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
      // A 2ª Fonte já escreveu no rascunho quando o Admin cancela.
      const segunda = await cerebro.nextSync();
      const escrita = await segunda.request.tools!.call(
        "escrever_pagina",
        escritaDaAula2.toolUse[0]!.input,
        segunda.signal,
      );
      expect(escrita.isError).toBe(false);

      const res = await cancelar(t, wiki);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: "canceled", step: null });
      expect(segunda.signal.aborted).toBe(true);

      expect((await naAdministracao(t, wiki)).lastSync).toMatchObject({ state: "canceled", reason: null });
      await comoEstava(t, wiki);
      // Quem vê a Wiki vê o fim em tempo real.
      const visto = await eventually("o cancelamento chegar ao Bruno", async () =>
        doBruno.received().find((e) => e.type === "wiki_sync.updated" && e.sync.state === "canceled"),
      );
      expect(visto).toBeTruthy();
      // Nenhuma chamada nova sai depois do cancelamento, nem a nova tentativa.
      t.clock.advance(RETRY_DELAY_MS);
      expect(cerebro.syncs).toHaveLength(2);

      // Cancelada, ela não segura a Wiki: o Admin sincroniza de novo.
      expect((await sincronizar(t, wiki)).status).toBe(202);
    },
    LONGO,
  );

  test(
    "pela Conta, o `claude -p` em curso recebe SIGINT e, se não sai, SIGTERM",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { chave: false, fontes: [AULA_1] });
      await t.linkAccount(juliana);
      // O `claude -p` não sai no SIGINT: o Shearim escala para o SIGTERM.
      t.claude.script({ syncRuns: [{ kind: "hang", onSigint: "ignore" }] });
      await sincronizar(t, wiki);
      const [chamada] = await eventually("o `claude -p` subir", async () => {
        const chamadas = t.claude.syncs();
        return chamadas.length ? chamadas : undefined;
      });

      expect((await cancelar(t, wiki)).status).toBe(200);
      const sinais = await eventually(
        "o SIGTERM chegar",
        async () => {
          const vistos = t.claude.signals(chamada!.pid).map((s) => s.signal);
          return vistos.includes("SIGTERM") ? vistos : undefined;
        },
        10_000,
      );
      expect(sinais).toEqual(["SIGINT", "SIGTERM"]);
      expect((await naAdministracao(t, wiki)).lastSync).toMatchObject({ state: "canceled", payer: "account" });
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: null, pending: 1 });
    },
    LONGO,
  );

  test("sem Sincronização em curso, não há o que cancelar (409)", async () => {
    const t = await testApp();
    const wiki = await wikiComFontes(t);
    const res = await cancelar(t, wiki);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_cancel");
  });

  test(
    "só o Admin cancela: um Membro recebe 403, e a Sincronização segue",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      await sincronizar(t, wiki);
      const chamada = await cerebro.nextSync();

      const res = await cancelar(t, wiki, bruno);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("not_admin");
      expect(chamada.signal.aborted).toBe(false);
      expect((await naAdministracao(t, wiki)).lastSync).toMatchObject({ state: "running" });
    },
    LONGO,
  );
});

describe("o servidor reinicia no meio", () => {
  test(
    'ao subir, a Sincronização que ficou em curso termina em "falhou: o servidor reiniciou", e a Wiki fica como estava',
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      await sincronizar(t, wiki);
      const primeira = await cerebro.nextSync();
      await primeira.request.tools!.call("escrever_pagina", escritaDaAula1.toolUse[0]!.input, primeira.signal);

      await t.restart();

      const sync = (await naAdministracao(t, wiki)).lastSync!;
      expect(sync).toMatchObject({ state: "failed", reason: "o servidor reiniciou", step: null });
      expect(sync.finishedAt).not.toBeNull();
      await comoEstava(t, wiki);
      // Nada ficou pela metade: o Admin sincroniza de novo.
      expect((await sincronizar(t, wiki)).status).toBe(202);
    },
    LONGO,
  );
});

/** O que chegou a este aparelho até agora. */
const entregasPara = (t: TestApp, aparelho: PushDevice) =>
  t.push.deliveries.filter((d) => d.endpoint === aparelho.subscription.endpoint);

describe("o push para o Admin que iniciou", () => {
  test(
    'sai quando ela termina em "concluída", com a versão, e leva à tela das Wikis; o Membro não recebe',
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t);
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);
      t.anthropic.sync(escritaDaAula1, { text: "Pronto." }, escritaDaAula2, { text: "Pronto." });

      await sincronizar(t, wiki);
      const push = await daJuliana.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({
        title: "Sincronização concluída: Curso de Redes Sociais",
        body: "Versão 1 publicada: 2 páginas criadas.",
        navigate: expect.stringMatching(/\/wikis$/),
      });
      expect(push.urgency).toBe("normal");
      expect(entregasPara(t, doBruno)).toEqual([]);
    },
    LONGO,
  );

  test(
    'sai quando ela termina em "falhou", com o motivo',
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t);
      const daJuliana = await t.pushDevice(juliana);
      t.anthropic.sync(SOBRECARGA, SOBRECARGA);

      await sincronizar(t, wiki);
      await terminada(t, wiki, { andando: true });
      const push = await daJuliana.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({
        title: "A Sincronização de Curso de Redes Sociais falhou",
        body: "a Anthropic está sobrecarregada, nas duas tentativas",
      });
      expect(push.urgency).toBe("high");
    },
    LONGO,
  );

  test(
    "sai também quando ela falha porque o servidor reiniciou",
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      const daJuliana = await t.pushDevice(juliana);
      await sincronizar(t, wiki);
      await cerebro.nextSync();

      await t.restart();
      const push = await daJuliana.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({
        title: "A Sincronização de Curso de Redes Sociais falhou",
        body: "o servidor reiniciou",
      });
    },
    LONGO,
  );

  test(
    'não sai quando ela termina em "cancelada": foi o próprio Admin',
    async () => {
      const cerebro = scriptedBrain({ scriptSyncs: true });
      const t = await testApp({ keyBrain: cerebro.brain });
      const wiki = await wikiComFontes(t);
      const daJuliana = await t.pushDevice(juliana);
      await sincronizar(t, wiki);
      await cerebro.nextSync();

      expect((await cancelar(t, wiki)).status).toBe(200);
      // Uma Sincronização depois, que falha: o primeiro push que chega é o dela, e não um da cancelada.
      await sincronizar(t, wiki);
      const outra = await cerebro.nextSync();
      await outra.emit({ type: "failed", reason: "o pedido não passou", retryable: false });
      const push = await daJuliana.next({ timeoutMs: 10_000 });
      expect(push.payload.notification).toMatchObject({ body: "o pedido não passou" });
      expect(entregasPara(t, daJuliana)).toHaveLength(1);
    },
    LONGO,
  );
});

describe("o orçamento da Articuladora", () => {
  test(
    "estourado no meio, a Sincronização falha com o motivo, sem nova tentativa, e a Wiki fica como estava",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t);
      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      const sophya = agentes.find((a) => a.builtin)!;
      const editada = await t.as(juliana).patch(`/api/agents/${sophya.id}`, {
        model: "claude-opus-5-5",
        monthlyBudgetUsd: 1,
      });
      expect(editada.status).toBe(200);
      // Opus: US$ 4 por milhão de tokens de entrada. A 1ª Fonte gasta US$ 2, e o orçamento é US$ 1.
      t.anthropic.sync({ text: "Pronto.", usage: { input_tokens: 500_000, output_tokens: 0 } });

      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki, { andando: true });
      expect(sync).toMatchObject({ state: "failed", attempt: 1 });
      expect(sync.reason).toBe(
        `sem quem pague: a Conta do Claude de Juliana não está ligada, e ${sophya.name} estourou o orçamento do mês na Chave`,
      );
      // A 2ª Fonte nem saiu.
      expect(t.anthropic.syncs).toHaveLength(1);
      await comoEstava(t, wiki);
    },
    LONGO,
  );

  test(
    "uma falha que estoura o orçamento não ganha nova tentativa: ninguém pagaria por ela",
    async () => {
      const t = await testApp();
      const wiki = await wikiComFontes(t, { fontes: [AULA_1] });
      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      const sophya = agentes.find((a) => a.builtin)!;
      await t.as(juliana).patch(`/api/agents/${sophya.id}`, { model: "claude-opus-5-5", monthlyBudgetUsd: 1 });
      // A chamada gasta US$ 2 num turno e cai no seguinte.
      t.anthropic.sync({ ...escritaDaAula1, usage: { input_tokens: 500_000, output_tokens: 0 } }, SOBRECARGA);

      await sincronizar(t, wiki);
      const sync = await terminada(t, wiki, { andando: true });
      expect(sync.state).toBe("failed");
      expect(sync.reason).toContain("sem quem pague");
      expect(t.anthropic.syncs).toHaveLength(2);
      expect(await naAdministracao(t, wiki)).toMatchObject({ currentVersion: null, pending: 1 });
    },
    LONGO,
  );
});
