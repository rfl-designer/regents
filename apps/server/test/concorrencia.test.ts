/**
 * Concorrência e ordem das execuções (Spec, módulo 6, "Ordem", "Tetos" e "Prioridade"; histórias
 * 86 e 87), pela borda do servidor. O paralelismo e a série se provam sem `sleep`: o cérebro
 * roteirizado (e o `fake-claude` com `hang`) segura cada chamada até o teste soltar, e o que
 * ainda não começou aparece no Andamento ("esperando a vez").
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@regents/contracts";
import { configFrom } from "../src/config";
import { DEFAULT_LIMITS, limitsFromConfig } from "../src/executions";
import type { FakeClaudeCall } from "./fake-claude";
import { type ScriptedRun, scriptedBrain } from "./fakes/scripted-brain";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const ESPERA = { timeoutMs: 10_000 };

/** Juliana vira Admin, grava a Chave e põe no #geral um Agente para cada nome. */
async function workspace(t: TestApp, nomes: string[]) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  const agentes: AgentDto[] = [];
  for (const name of nomes) {
    const agente: AgentDto = await (
      await t.as(juliana).post("/api/agents", {
        name,
        photo: null,
        description: `${name}.`,
        instructions: `Você é ${name}.`,
        model: "claude-sonnet-5-5",
      })
    ).json();
    await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: agente.id });
    agentes.push(agente);
  }
  return { geral: geral!, agentes };
}

async function enviar(t: TestApp, channelId: string, body: string, who = juliana): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** O próximo Andamento que satisfaz `quando` (os anteriores são lidos e deixados para trás). */
async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (quando(execution)) return execution;
  }
}

/** As mensagens que a chamada levou no contexto (uma por parágrafo, a de origem por último). */
function contexto(run: ScriptedRun) {
  const content = run.request.messages.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function respostas(t: TestApp, channelId: string): Promise<MessageDto[]> {
  const lista: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${channelId}/messages`)).json();
  return lista.filter((m) => m.originMessageId);
}

/** Os `claude -p` das execuções (a validação do "Ligar minha Conta" não leva mensagens). */
const processos = (t: TestApp) => t.claude.callsOf("-p").filter((c) => c.stdin);
const doRoteamento = (c: FakeClaudeCall) => c.argv.includes("--json-schema");

async function cancelar(t: TestApp, channelId: string, origem: MessageDto) {
  const res = await t.as(juliana).post(`/api/conversations/${channelId}/messages/${origem.id}/cancel`);
  expect(res.status).toBe(200);
}

/** O roteamento da Articuladora: a chamada que pede saída estruturada. */
const roteamento = (run: ScriptedRun) => run.request.output !== undefined;

/** O Desfecho "delegar" ao Agente com esse identificador. */
const delegar = (agente: string) =>
  JSON.stringify({ decisao: "delegar", agentes: [{ agente, cobrir: "O prazo." }], motivo: "É com ele." });

async function responder(run: ScriptedRun, text: string) {
  await run.emit({ type: "text", text });
  await run.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
}

describe("Ordem", () => {
  test("Agentes diferentes respondem em paralelo", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia"]);

    await enviar(t, geral.id, "@Faro @Lia qual o prazo?");

    // As duas chamadas chegam ao cérebro sem que nenhuma tenha terminado.
    const primeira = await cerebro.nextRun();
    const segunda = await cerebro.nextRun();
    expect([primeira, segunda].every((r) => !r.signal.aborted)).toBe(true);
    await responder(primeira, "Sexta.");
    await responder(segunda, "Segunda.");
    await eventually("as duas respostas saírem", async () => (await respostas(t, geral.id)).length === 2);
  });

  test("as respostas de um mesmo Agente numa conversa saem em série, na ordem das mensagens", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro"]);
    const aba = await t.socket(juliana);

    const um = await enviar(t, geral.id, "@Faro primeira pergunta");
    const primeira = await cerebro.nextRun();
    const dois = await enviar(t, geral.id, "@Faro segunda pergunta");

    // A segunda espera a vez: o Faro ainda responde à primeira.
    const esperando = await andamento(aba, (e) => e.originMessageId === dois.id && e.waitingTurn);
    expect(esperando).toMatchObject({ state: "queued", held: false, attempt: 0 });
    expect(cerebro.runs).toHaveLength(1);

    await responder(primeira, "Resposta à primeira.");
    const segunda = await cerebro.nextRun();
    // Ela só começa depois que a resposta à primeira saiu.
    expect(contexto(segunda)).toContain("@Faro segunda pergunta");
    expect((await respostas(t, geral.id)).map((m) => m.body)).toEqual(["Resposta à primeira."]);
    const rodando = await andamento(aba, (e) => e.originMessageId === dois.id && e.state === "running");
    expect(rodando.waitingTurn).toBe(false);
    await responder(segunda, "Resposta à segunda.");
    const saiu = await eventually("as duas saírem", async () => {
      const r = await respostas(t, geral.id);
      return r.length === 2 && r;
    });
    expect(saiu.map((m) => [m.originMessageId, m.body])).toEqual([
      [um.id, "Resposta à primeira."],
      [dois.id, "Resposta à segunda."],
    ]);
  });

  test("o fluxo principal e cada Thread são conversas separadas: o mesmo Agente responde nas duas ao mesmo tempo", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro"]);
    const raiz = await enviar(t, geral.id, "@Faro proposta da Acme");
    await responder(await cerebro.nextRun(), "Vou ver.");
    await enviar(t, geral.id, "@Faro no fluxo principal");
    const noFluxo = await cerebro.nextRun();

    const res = await t
      .as(juliana)
      .post(`/api/conversations/${geral.id}/messages`, { body: "@Faro na Thread", threadRootId: raiz.id });
    expect(res.status).toBe(201);

    const naThread = await cerebro.nextRun();
    expect(contexto(naThread)).toContain("@Faro na Thread");
    expect(noFluxo.signal.aborted).toBe(false);
  });

  test("a resposta espera o roteamento de uma mensagem anterior da mesma conversa: a delegada sai antes", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro"]);
    const aba = await t.socket(juliana);

    const um = await enviar(t, geral.id, "Qual o prazo da Acme?");
    const decidindo = await cerebro.nextRun();
    expect(roteamento(decidindo)).toBe(true);
    const dois = await enviar(t, geral.id, "@Faro e o da Beta?");

    // O Faro de "dois" espera: o roteamento de "um" ainda pode chamar o Faro antes dele.
    await andamento(aba, (e) => e.originMessageId === dois.id && e.waitingTurn);
    expect(cerebro.runs).toHaveLength(1);

    await responder(decidindo, delegar("faro"));
    // Primeiro o delegado (que leva o que cobrir), depois a Menção.
    const primeira = await cerebro.nextRun();
    expect(primeira.request.system).toContain("O prazo.");
    await responder(primeira, "Sexta.");
    const segunda = await cerebro.nextRun();
    expect(segunda.request.system).not.toContain("O prazo.");
    await responder(segunda, "Segunda.");
    const saiu = await eventually("as duas saírem", async () => {
      const r = await respostas(t, geral.id);
      return r.length === 2 && r;
    });
    expect(saiu.map((m) => m.originMessageId)).toEqual([um.id, dois.id]);
  });
});

describe("Prioridade", () => {
  test("o roteamento passa na frente das respostas que chegaram antes dele", async () => {
    const cerebro = scriptedBrain();
    // Um lugar só na Chave: a fila anda uma de cada vez e a ordem fica à vista.
    const t = await testApp({ keyBrain: cerebro.brain, limits: { key: 1 } });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    const aba = await t.socket(juliana);

    await enviar(t, geral.id, "@Faro primeira");
    const ocupando = await cerebro.nextRun();
    const lia = await enviar(t, geral.id, "@Lia segunda");
    await andamento(aba, (e) => e.originMessageId === lia.id && e.waitingTurn);
    const conversa = await enviar(t, geral.id, "Bom dia, pessoal");
    await andamento(aba, (e) => e.originMessageId === conversa.id && e.waitingTurn);

    await responder(ocupando, "Feito.");
    const depois = await cerebro.nextRun();
    expect(roteamento(depois)).toBe(true);
    await responder(depois, JSON.stringify({ decisao: "nenhum", agentes: [], motivo: "Conversa." }));
    const ultima = await cerebro.nextRun();
    expect(contexto(ultima)).toContain("@Lia segunda");
  });
});

describe("Tetos", () => {
  test("os tetos vêm do .env, com os da Spec por padrão; valor inválido não sobe", () => {
    expect(DEFAULT_LIMITS).toEqual({ perAccount: 2, key: 4, processes: 8 });
    expect(limitsFromConfig(configFrom({}))).toEqual({});
    expect(
      limitsFromConfig(
        configFrom({ SHEARIM_MAX_PER_ACCOUNT: "3", SHEARIM_MAX_ON_KEY: "6", SHEARIM_MAX_PROCESSES: "12" }),
      ),
    ).toEqual({ perAccount: 3, key: 6, processes: 12 });
    expect(limitsFromConfig(configFrom({ SHEARIM_MAX_ON_KEY: "" }))).toEqual({});
    expect(() => limitsFromConfig(configFrom({ SHEARIM_MAX_PROCESSES: "0" }))).toThrow(
      "SHEARIM_MAX_PROCESSES=0 não é um número inteiro maior que zero.",
    );
    expect(() => limitsFromConfig(configFrom({ SHEARIM_MAX_PER_ACCOUNT: "dois" }))).toThrow(
      "SHEARIM_MAX_PER_ACCOUNT=dois não é um número inteiro maior que zero.",
    );
  });

  test("até 4 execuções na Chave: a quinta espera a vez e sai quando uma termina", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Ana", "Bia", "Caio", "Davi", "Eva"]);
    const aba = await t.socket(juliana);

    await enviar(t, geral.id, "@Ana @Bia @Caio @Davi @Eva qual o prazo?");

    const rodando = [
      await cerebro.nextRun(),
      await cerebro.nextRun(),
      await cerebro.nextRun(),
      await cerebro.nextRun(),
    ];
    const quinta = await andamento(aba, (e) => e.waitingTurn);
    expect(quinta).toMatchObject({ state: "queued", agent: { displayName: "Eva" } });
    expect(cerebro.runs).toHaveLength(4);
    const [aberta] = (await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()).filter(
      (e: ExecutionDto) => e.waitingTurn,
    );
    expect(aberta).toMatchObject({ id: quinta.id, waitingTurn: true });

    await responder(rodando[0]!, "Sexta.");
    const ultima = await cerebro.nextRun();
    expect(ultima.request.system).toContain("Você é Eva.");
    const saiu = await andamento(aba, (e) => e.id === quinta.id && e.state === "running");
    expect(saiu.waitingTurn).toBe(false);
  });

  test("até 2 respostas por Conta, com o roteamento fora dessa conta", async () => {
    const t = await testApp();
    const { geral } = await workspace(t, ["Faro", "Lia", "Rui"]);
    await t.linkAccount(juliana);
    t.claude.script({ run: { kind: "hang" } });
    const aba = await t.socket(juliana);

    const um = await enviar(t, geral.id, "@Faro um");
    await enviar(t, geral.id, "@Lia dois");
    const tres = await enviar(t, geral.id, "@Rui três");

    const esperando = await andamento(aba, (e) => e.originMessageId === tres.id && e.waitingTurn);
    expect(esperando.state).toBe("queued");
    await eventually("as duas primeiras subirem", async () => processos(t).length === 2, 10_000);
    expect(processos(t).map((c) => c.stdin?.includes("@Rui três"))).toEqual([false, false]);

    // A autora cancela a primeira: abre lugar na Conta, e a terceira sobe.
    await cancelar(t, geral.id, um);
    await eventually("a terceira subir", async () => processos(t).length === 3, 10_000);
    expect(processos(t)[2]!.stdin).toContain("@Rui três");

    // Com duas respostas rodando pela Conta, o roteamento ainda sai por ela.
    await enviar(t, geral.id, "Bom dia, pessoal");
    await eventually("o roteamento subir", async () => processos(t).length === 4, 10_000);
    expect(doRoteamento(processos(t)[3]!)).toBe(true);
  }, 60_000);

  test("o teto de processos no host vale para todas as execuções pela Conta, roteamento incluso", async () => {
    const t = await testApp({ limits: { processes: 2 } });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    await t.linkAccount(juliana);
    t.claude.script({ run: { kind: "hang" } });
    const aba = await t.socket(juliana);

    const um = await enviar(t, geral.id, "@Faro um");
    await enviar(t, geral.id, "@Lia dois");
    await eventually("as duas subirem", async () => processos(t).length === 2, 10_000);
    const conversa = await enviar(t, geral.id, "Bom dia, pessoal");

    const esperando = await andamento(aba, (e) => e.originMessageId === conversa.id && e.waitingTurn);
    expect(esperando).toMatchObject({ kind: "route", state: "queued" });
    expect(processos(t)).toHaveLength(2);

    await cancelar(t, geral.id, um);
    await eventually("o roteamento subir", async () => processos(t).length === 3, 10_000);
    expect(doRoteamento(processos(t)[2]!)).toBe(true);
  }, 60_000);

  test("a troca no meio refaz pela Chave respeitando o teto dela, mantendo a hora de chegada", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain, limits: { key: 1 } });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    await t.addMember(bruno, { by: juliana });
    await t.as(bruno).post(`/api/channels/${geral.id}/join`);
    await t.linkAccount(juliana);
    t.claude.script({ run: { kind: "error", error: "rate_limit", apiErrorStatus: 429 } });
    const aba = await t.socket(juliana);

    // O Bruno, sem Conta, ocupa o único lugar da Chave.
    await enviar(t, geral.id, "@Lia do Bruno", bruno);
    const doBruno = await cerebro.nextRun();
    const daJuliana = await enviar(t, geral.id, "@Faro da Juliana");

    // A Conta dela bate no limite: a resposta troca para a fila da Chave, que está cheia.
    const esperando = await andamento(aba, (e) => e.originMessageId === daJuliana.id && e.waitingTurn);
    expect(esperando).toMatchObject({ state: "queued", attempt: 0, payer: null, held: false });
    expect(cerebro.runs).toHaveLength(1);

    await responder(doBruno, "Feito.");
    const pelaChave = await cerebro.nextRun();
    expect(pelaChave.request.system).toContain("Você é Faro.");
    const trocada = await andamento(aba, (e) => e.originMessageId === daJuliana.id && e.payer === "key");
    expect(trocada).toMatchObject({ state: "running", attempt: 1 });
    expect(processos(t)).toHaveLength(1);
  }, 60_000);
});

describe("Várias ao mesmo tempo", () => {
  test("cada uma tem a sua vigia: a que fica muda falha, a que anda segue", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    const aba = await t.socket(juliana);
    await enviar(t, geral.id, "@Faro @Lia qual o prazo?");
    const [a, b] = [await cerebro.nextRun(), await cerebro.nextRun()];

    t.clock.advance(90_000);
    await a.emit({ type: "text", text: "Pensando no prazo" });
    t.clock.advance(30_000);

    const muda = await andamento(aba, (e) => e.state === "retrying");
    expect(muda.reason).toBe("ficou 2 minutos sem escrever nada");
    expect(b.signal.reason).toBe("stalled");
    expect(a.signal.aborted).toBe(false);
    await responder(a, ", é sexta.");
    await eventually("a que andou responder", async () => (await respostas(t, geral.id)).length === 1);
  });

  test("cancelar uma mensagem interrompe só as execuções dela", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    const um = await enviar(t, geral.id, "@Faro um");
    const a = await cerebro.nextRun();
    const dois = await enviar(t, geral.id, "@Lia dois");
    const b = await cerebro.nextRun();

    await cancelar(t, geral.id, um);

    expect(a.signal.reason).toBe("cancelled");
    expect(b.signal.aborted).toBe(false);
    await responder(b, "Feito.");
    const saiu = await eventually("a outra responder", async () => (await respostas(t, geral.id))[0]);
    expect(saiu.originMessageId).toBe(dois.id);
  });

  test("o dreno espera todas as que estão rodando e não pega mais nenhuma", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia", "Rui"]);
    await enviar(t, geral.id, "@Faro @Lia qual o prazo?");
    const [a, b] = [await cerebro.nextRun(), await cerebro.nextRun()];

    let drenou = false;
    const dreno = t.drain().then(() => {
      drenou = true;
    });
    await enviar(t, geral.id, "@Rui chegou durante o dreno");
    await responder(a, "Uma.");
    await eventually("a primeira responder", async () => (await respostas(t, geral.id)).length === 1);
    expect(drenou).toBe(false);
    await responder(b, "Outra.");
    await dreno;

    expect((await respostas(t, geral.id)).map((m) => m.body).sort()).toEqual(["Outra.", "Uma."]);
    expect(cerebro.runs).toHaveLength(2);
  });

  test('a parada interrompe todas; na subida, cada uma vira "o servidor reiniciou"', async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    await enviar(t, geral.id, "@Faro @Lia qual o prazo?");
    const [a, b] = [await cerebro.nextRun(), await cerebro.nextRun()];

    await t.restart();

    expect([a.signal.reason, b.signal.reason]).toEqual(["shutdown", "shutdown"]);
    const abertas = await eventually("a subida passar pelas duas", async () => {
      const lista: ExecutionDto[] = await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json();
      return lista.every((e) => e.state !== "running") && lista;
    });
    expect(abertas.map((e) => [e.state, e.reason])).toEqual([
      ["retrying", "o servidor reiniciou"],
      ["retrying", "o servidor reiniciou"],
    ]);
  });

  test("a chamada que já rodava quando a Chave foi recusada não encerra o incidente; a que começa depois, sim", async () => {
    const cerebro = scriptedBrain();
    const t = await testApp({ keyBrain: cerebro.brain });
    const { geral } = await workspace(t, ["Faro", "Lia"]);
    await enviar(t, geral.id, "@Faro @Lia qual o prazo?");
    const [antes, recusada] = [await cerebro.nextRun(), await cerebro.nextRun()];
    const chave = async () => (await (await t.as(juliana).get("/api/workspace-key")).json()).incident;

    t.clock.advance(1_000);
    await recusada.emit({ type: "auth_failed" });
    const aberto = await eventually("o incidente abrir", chave);

    await responder(antes, "Sexta.");
    await eventually("a resposta de antes sair", async () => (await respostas(t, geral.id)).length === 1);
    expect(await chave()).toEqual(aberto);

    await enviar(t, geral.id, "@Faro e agora?");
    await responder(await cerebro.nextRun(), "Agora sim.");
    await eventually("o incidente fechar", async () => (await chave()) === null);
  });

  test("dois trabalhadores no mesmo banco nunca pegam a mesma execução nem andam a série em dobro", async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const um = await testApp({ masterKey });
    const outro = await testApp({ masterKey, db: um.db });
    const { geral } = await workspace(um, ["Faro", "Lia", "Rui"]);

    // Cada app acorda o seu trabalhador: as mensagens vão uma por cada, e os dois olham a fila juntos.
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => enviar(i % 2 ? um : outro, geral.id, `@Faro @Lia @Rui pergunta ${i}`)),
    );
    const conversa: MessageDto[] = await (await um.as(juliana).get(`/api/channels/${geral.id}/messages`)).json();
    const enviadas = conversa.filter((m) => m.author.kind === "member");

    const saiu = await eventually(
      "as dezoito respostas saírem",
      async () => {
        const r = await respostas(um, geral.id);
        return r.length >= 18 && r;
      },
      20_000,
    );
    expect(saiu).toHaveLength(18);
    expect(um.anthropic.requests.length + outro.anthropic.requests.length).toBe(18);
    // Cada Agente respondeu a todas, na ordem das mensagens.
    const ordem = enviadas.map((m) => m.id);
    for (const nome of ["Faro", "Lia", "Rui"]) {
      expect(saiu.filter((m) => m.author.displayName === nome).map((m) => m.originMessageId)).toEqual(ordem);
    }
  });
});
