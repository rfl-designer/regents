/**
 * Push de resposta de Agente, de falha e de Thread seguida (Spec, histórias 94 e 95; módulo 12,
 * "Envio" e "Agrupamento"), pela borda do servidor e pelo coletor de push.
 *
 * - A resposta de um Agente à mensagem de uma pessoa num Canal avisa quem escreveu, com
 *   `Urgency: normal`.
 * - Mensagem numa Thread seguida avisa quem segue, com `Urgency: normal`.
 * - A falha de vez de uma execução avisa o autor da mensagem, com `Urgency: high`, e abre a
 *   mensagem (onde está o "Tentar de novo").
 * - "Na fila" e "Agentes não agem" não geram push.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@shearim/contracts";
import { PUSH_TTL_SECONDS } from "../src/push";
import type { FakeRun } from "./fake-claude";
import { type EventSocket, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "1003", login: "carla@exemplo.com", name: "Carla" };
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;
const CHAVE = "sk-ant-api03-chave-do-workspace";

/** Juliana vira Admin, grava a Chave (se `chave`), cria o Faro e o põe no #geral; Bruno e Carla entram. */
async function workspace(t: TestApp, opts: { chave?: boolean } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const criado = await t.as(juliana).post("/api/agents", {
    name: "Faro",
    photo: null,
    description: "Comercial.",
    instructions: "Você é o Faro, do comercial.",
    model: "claude-sonnet-5-5",
  });
  expect(criado.status).toBe(201);
  const faro: AgentDto = await criado.json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  const me = { Bruno: await t.addMember(bruno, { by: juliana }), Carla: await t.addMember(carla, { by: juliana }) };
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  await t.as(carla).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral!, me };
}

async function enviar(
  t: TestApp,
  channelId: string,
  body: string,
  who: Person = bruno,
  threadRootId?: string,
): Promise<MessageDto> {
  const res = await t
    .as(who)
    .post(`/api/conversations/${channelId}/messages`, { body, ...(threadRootId ? { threadRootId } : {}) });
  expect(res.status).toBe(201);
  return res.json();
}

/** O fim (resposta, falha ou "Agentes não agem") da execução desta origem, visto nesta aba. */
async function fim(aba: EventSocket, origem: MessageDto): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated", ESPERA);
    if (execution.originMessageId === origem.id && ["done", "failed", "not_acting"].includes(execution.state)) {
      return execution;
    }
  }
}

/** Uma DM de `de` para `para`: o push dela é o sentinela de que nada saiu antes (os pushes saem em fila). */
async function dm(t: TestApp, de: Person, para: Person, body: string) {
  const destino = await (await t.as(para).get("/api/me")).json();
  const conversa = await (await t.as(de).post("/api/dms", { memberIds: [destino.id] })).json();
  await t.as(de).post(`/api/conversations/${conversa.id}/messages`, { body });
}

const topicOf = (id: string) => id.replaceAll("-", "");

describe("push da resposta de Agente", () => {
  test(
    "a resposta do Faro à mensagem do Bruno num Canal avisa o Bruno, com Urgency normal",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      t.anthropic.reply({ text: "O preço é R$ 10." });

      await enviar(t, geral.id, "@Faro qual o preço?");

      const push = await doBruno.next(ESPERA);
      expect(push.payload).toEqual({
        web_push: 8030,
        notification: {
          title: "#geral · Faro",
          body: "O preço é R$ 10.",
          navigate: expect.stringMatching(new RegExp(`/c/${geral.id}$`)),
          tag: geral.id,
          lang: "pt-BR",
        },
        app_badge: 1,
      });
      expect(push.urgency).toBe("normal");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect(push.topic).toBe(topicOf(geral.id));
    },
    LONGO,
  );
});

describe("push da resposta de Agente, em outros lugares", () => {
  test(
    "numa DM com o Faro, a resposta dele é mensagem de DM: chega com Urgency high",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      t.anthropic.reply({ text: "Pode falar." });
      const comFaro = await (await t.as(bruno).post("/api/dms", { memberIds: [], agentId: faro.id })).json();

      await enviar(t, comFaro.id, "Faro, uma dúvida");

      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({ title: "Faro", body: "Pode falar.", tag: comFaro.id });
      expect(push.urgency).toBe("high");
    },
    LONGO,
  );

  test(
    "a resposta do Faro numa Thread avisa quem escreveu e quem segue; com a conversa à vista, cala",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const daCarla = await t.pushDevice(carla);
      const aba = await t.socket(carla);
      t.anthropic.reply(
        // A raiz não menciona ninguém: a Articuladora decide antes ("nenhum").
        { json: { decisao: "nenhum", agentes: [], motivo: "É um aviso." } },
        { text: "Sobe para R$ 12." },
        { text: "Fechado." },
      );

      const raiz = await enviar(t, geral.id, "o preço mudou", carla);
      const pergunta = await enviar(t, geral.id, "@Faro quanto fica?", bruno, raiz.id);
      expect((await daCarla.next(ESPERA)).payload.notification.body).toBe("@Faro quanto fica?");
      expect((await fim(aba, pergunta)).state).toBe("done");

      const [paraBruno, paraCarla] = [await doBruno.next(ESPERA), await daCarla.next(ESPERA)];
      expect(paraBruno.payload.notification).toMatchObject({ title: "#geral · Faro", body: "Sobe para R$ 12." });
      expect(paraBruno.urgency).toBe("normal");
      expect(paraCarla.payload.notification).toMatchObject({
        title: "2 novas em #geral",
        body: "Faro: Sobe para R$ 12.",
      });
      expect(paraCarla.urgency).toBe("normal");

      // O Bruno com o #geral à vista: a próxima resposta não sai para ele.
      const notebook = await t.socket(bruno);
      expect(
        (await t.as(bruno).put("/api/presence", { connectionId: notebook.connectionId, conversationId: geral.id }))
          .status,
      ).toBe(204);
      const outra = await enviar(t, geral.id, "@Faro e com desconto?", bruno, raiz.id);
      expect((await fim(aba, outra)).state).toBe("done");
      await t.as(bruno).put("/api/presence", { connectionId: notebook.connectionId, conversationId: null });
      await dm(t, juliana, bruno, "depois");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("depois");
    },
    LONGO,
  );
});

describe("push de Thread seguida", () => {
  test(
    "a mensagem numa Thread avisa quem a segue, com Urgency normal; quem não segue não recebe",
    async () => {
      const t = await testApp();
      const { geral, me } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const daCarla = await t.pushDevice(carla);
      const daJuliana = await t.pushDevice(juliana);

      const raiz = await enviar(t, geral.id, "proposta nova no drive", bruno);
      // A Carla responde: o Bruno (autor da raiz) segue; a Carla passa a seguir.
      await enviar(t, geral.id, "eu vejo hoje", carla, raiz.id);
      const primeiro = await doBruno.next(ESPERA);
      expect(primeiro.payload.notification).toMatchObject({
        title: "#geral · Carla",
        body: "eu vejo hoje",
        tag: geral.id,
      });
      expect(primeiro.urgency).toBe("normal");
      expect(primeiro.ttl).toBe(PUSH_TTL_SECONDS);
      expect(primeiro.topic).toBe(topicOf(geral.id));

      // A Juliana responde mencionando a Carla: a Carla recebe um push só, o da Menção (high).
      await enviar(t, geral.id, `@${me.Carla.handle} manda o resumo`, juliana, raiz.id);
      const daMencao = await daCarla.next(ESPERA);
      expect(daMencao.payload.notification.body).toBe(`@${me.Carla.handle} manda o resumo`);
      expect(daMencao.urgency).toBe("high");
      const segundo = await doBruno.next(ESPERA);
      expect(segundo.payload.notification).toMatchObject({ title: "2 novas em #geral" });
      expect(segundo.urgency).toBe("normal");

      // A Juliana não seguia antes da própria resposta: o primeiro push dela é a DM sentinela.
      await dm(t, bruno, juliana, "viu a Thread?");
      expect((await daJuliana.next(ESPERA)).payload.notification.body).toBe("viu a Thread?");
      await dm(t, bruno, carla, "e você?");
      expect((await daCarla.next(ESPERA)).payload.notification.body).toBe("e você?");
    },
    LONGO,
  );
});

describe("push da falha", () => {
  test(
    'a falha de vez avisa quem escreveu, com Urgency high, e abre a mensagem com o "Tentar de novo"',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const daJuliana = await t.pushDevice(juliana);
      const aba = await t.socket(bruno);
      // A falha que não vale nova tentativa aparece na hora.
      t.anthropic.reply({ status: 404, errorType: "not_found_error" });

      const origem = await enviar(t, geral.id, "@Faro e esse modelo?");
      const falha = await fim(aba, origem);
      expect(falha.state).toBe("failed");

      const push = await doBruno.next(ESPERA);
      expect(push.payload).toEqual({
        web_push: 8030,
        notification: {
          title: "#geral · Faro não respondeu",
          body: "O modelo do Agente não existe na Anthropic.",
          navigate: expect.stringMatching(new RegExp(`/c/${geral.id}\\?m=${origem.id}$`)),
          tag: `falha-${falha.id}`,
          lang: "pt-BR",
        },
        app_badge: 0,
      });
      expect(push.urgency).toBe("high");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect(push.topic).toBe(topicOf(falha.id));

      // Só o autor é avisado da falha.
      await dm(t, bruno, juliana, "o Faro falhou");
      expect((await daJuliana.next(ESPERA)).payload.notification.body).toBe("o Faro falhou");
    },
    LONGO,
  );
});

const limiteAte = (iso: string): FakeRun => ({
  kind: "steps",
  steps: [{ rateLimit: { status: "rejected", resetsAt: Date.parse(iso) / 1000 } }],
  end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
});

describe("o que não gera push", () => {
  test(
    '"Agentes não agem" não gera push: o primeiro que chega ao Bruno é a DM depois',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      const doBruno = await t.pushDevice(bruno);
      const aba = await t.socket(bruno);

      const origem = await enviar(t, geral.id, "@Faro tá aí?");
      expect((await fim(aba, origem)).state).toBe("not_acting");

      await dm(t, juliana, bruno, "depois do aviso");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("depois do aviso");
    },
    LONGO,
  );

  test(
    '"⏸ na fila" não gera push: chega só o da Conta no limite e, depois, a DM',
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      const aba = await t.socket(bruno);
      t.claude.script({ runs: [limiteAte("2026-11-24T15:45:00.000Z")] });

      await enviar(t, geral.id, "@Faro qual o prazo?");
      for (;;) {
        const { execution } = await aba.next("execution.updated", ESPERA);
        if (execution.held) break;
      }

      expect((await doBruno.next(ESPERA)).payload.notification.tag).toBe("conta");
      await dm(t, juliana, bruno, "na fila?");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("na fila?");
    },
    LONGO,
  );

  test(
    "a falha que a nova tentativa conserta não gera push de falha: chega só o da resposta",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const aba = await t.socket(bruno);
      t.anthropic.reply({ status: 529, errorType: "overloaded_error" }, { text: "Agora foi." });

      await enviar(t, geral.id, "@Faro tá aí?");
      for (;;) {
        const { execution } = await aba.next("execution.updated", ESPERA);
        if (execution.state === "retrying") break;
      }
      t.clock.advance(10_000);

      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({ title: "#geral · Faro", body: "Agora foi." });
    },
    LONGO,
  );
});
