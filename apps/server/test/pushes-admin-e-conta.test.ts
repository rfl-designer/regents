/**
 * Pushes do Admin e da Conta (Spec, módulo 12, "Gatilhos"; histórias 20, 41, 43, 47 e 52), pela
 * borda do servidor e pelo coletor de push (payload, `tag`, `Topic`, `Urgency` e TTL).
 *
 * - Todo Admin ativo recebe um push a cada Pedido de entrada, a cada incidente da Chave e, no
 *   máximo uma vez por Agente por mês, no estouro do orçamento. Quem não é Admin, nada.
 * - A Conta é só do Membro: quando ela cai ("No limite" ou "Precisa ligar de novo"), ele recebe um
 *   único push; quando outra pessoa liga a mesma assinatura, o primeiro dono fica sabendo. O Admin
 *   nunca recebe nada da Conta de outro.
 * - Os pushes de backup e da chave do nó são do #38 (`backup.test.ts`); o aviso de vencimento da
 *   Conta é do #35.
 */
import { describe, expect, test } from "bun:test";
import type { AccountDto, AgentDto, ChannelDto, ExecutionDto, MessageDto } from "@regents/contracts";
import { PUSH_TTL_SECONDS } from "../src/push";
import { FAKE_LOGIN_CODE, type FakeRun } from "./fake-claude";
import { type EventSocket, eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "1003", login: "carla@exemplo.com", name: "Carla" };
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;
const CHAVE = "sk-ant-api03-chave-do-workspace";
/** No Sonnet (US$ 2 / US$ 10 por milhão), US$ 2,00 exatos. */
const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };

/** Juliana vira Admin, grava a Chave (se `chave`), cria o Faro (com `orcamento`) e o põe no #geral; Bruno entra. */
async function workspace(t: TestApp, opts: { chave?: boolean; orcamento?: number } = {}) {
  await t.as(juliana).get("/api/me");
  if (opts.chave !== false) await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const criado = await t.as(juliana).post("/api/agents", {
    name: "Faro",
    photo: null,
    description: "Comercial.",
    instructions: "Você é o Faro, do comercial.",
    model: "claude-sonnet-5-5",
    ...(opts.orcamento !== undefined ? { monthlyBudgetUsd: opts.orcamento } : {}),
  });
  expect(criado.status).toBe(201);
  const faro: AgentDto = await criado.json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  const brunoMembro = await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral!, brunoMembro };
}

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
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

/**
 * A aba do Bruno, com o #geral aberto e visível: a resposta do Faro e a falha (#32) calam, e os
 * pushes do teste são só os do Admin e da Conta (e as DMs sentinela).
 */
async function comOGeralAVista(t: TestApp, geral: ChannelDto) {
  const aba = await t.socket(bruno);
  const res = await t.as(bruno).put("/api/presence", { connectionId: aba.connectionId, conversationId: geral.id });
  expect(res.status).toBe(204);
  return aba;
}

/** Nenhum push chegou a este aparelho (os pushes saem em fila: chame depois de ler um posterior). */
function nadaPara(t: TestApp, aparelho: { subscription: { endpoint: string } }) {
  expect(t.push.deliveries.filter((d) => d.endpoint === aparelho.subscription.endpoint)).toEqual([]);
}

describe("pushes do Admin", () => {
  test(
    "Pedido de entrada: todo Admin ativo recebe um push com nome, foto, login, aparelho e a marca de outra tailnet",
    async () => {
      const t = await testApp();
      await t.as(juliana).get("/api/me");
      const brunoMembro = await t.addMember(bruno, { by: juliana });
      await t.as(juliana).patch(`/api/members/${brunoMembro.id}`, { role: "admin" });
      await t.addMember(carla, { by: juliana });
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);
      const daCarla = await t.pushDevice(carla);

      const lucas = {
        id: "2001",
        login: "lucas@outra.com",
        name: "Lucas",
        sharee: true,
        device: "macbook-do-lucas",
        profilePicUrl: "https://exemplo.com/lucas.png",
      };
      const res = await t.as(lucas).post("/api/join-request");
      expect(res.status).toBe(201);
      const pedido = await res.json();

      const topicos: (string | null)[] = [];
      for (const aparelho of [daJuliana, doBruno]) {
        const push = await aparelho.next(ESPERA);
        topicos.push(push.topic);
        expect(push.payload).toMatchObject({
          web_push: 8030,
          notification: {
            title: "Lucas pede para entrar no Shearim",
            body: "lucas@outra.com · macbook-do-lucas · de outra tailnet",
            icon: "https://exemplo.com/lucas.png",
            navigate: expect.stringMatching(/\/membros$/),
            tag: `pedido-${pedido.id}`,
            lang: "pt-BR",
          },
        });
        expect(push.urgency).toBe("high");
        expect(push.ttl).toBe(PUSH_TTL_SECONDS);
        // `Topic` é base64url de até 32 caracteres (RFC 8030), um por pedido.
        expect(push.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      }
      nadaPara(t, daCarla);

      // Pedir de novo enquanto espera não é um pedido novo: nenhum push.
      await t.as(lucas).post("/api/join-request");
      // Outro pedido, da mesma tailnet e sem aparelho informado: a linha sem a marca.
      await t.as({ id: "2002", login: "maria@exemplo.com", name: "Maria" }).post("/api/join-request");
      const segundo = await daJuliana.next(ESPERA);
      expect(segundo.payload.notification).toMatchObject({
        title: "Maria pede para entrar no Shearim",
        body: "maria@exemplo.com",
      });
      expect(segundo.payload.notification).not.toHaveProperty("icon");
      expect(segundo.topic).not.toBe(topicos[0]);
    },
    LONGO,
  );

  test(
    "incidente da Chave: um push a cada Admin por incidente, e um novo depois que a Chave voltou",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);
      const aba = await comOGeralAVista(t, geral);
      t.anthropic.reply(
        // A Chave recusada não tem nova tentativa: uma chamada por mensagem.
        { status: 401, errorType: "authentication_error", errorMessage: "invalid x-api-key" },
        { status: 401, errorType: "authentication_error", errorMessage: "invalid x-api-key" },
        { text: "Voltei." },
        { status: 402, errorType: "billing_error", errorMessage: "credit balance too low" },
      );

      const primeira = await enviar(t, geral.id, "@Faro um");
      const push = await daJuliana.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "A Chave do Workspace foi recusada",
        body: "A Anthropic não aceitou a Chave. Os Agentes não respondem por ela até você trocá-la.",
        navigate: expect.stringMatching(/\/chave$/),
        tag: "chave-incidente",
      });
      expect(push.urgency).toBe("high");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect(push.topic).toBe("chave-incidente");
      expect((await fim(aba, primeira)).state).toBe("failed");

      // Outra recusa com o incidente aberto: nenhum push novo.
      expect((await fim(aba, await enviar(t, geral.id, "@Faro dois"))).state).toBe("failed");
      // A Chave volta, e o "sem crédito" depois é outro incidente: o próximo push da Juliana é ele.
      expect((await fim(aba, await enviar(t, geral.id, "@Faro três"))).state).toBe("done");
      await enviar(t, geral.id, "@Faro quatro");
      const novo = await daJuliana.next(ESPERA);
      expect(novo.payload.notification).toMatchObject({
        title: "A Chave do Workspace está sem crédito",
        body: "Os Agentes não respondem pela Chave até a conta da Anthropic ter crédito de novo.",
        tag: "chave-incidente",
      });
      nadaPara(t, doBruno);
    },
    LONGO,
  );

  test(
    "estouro de orçamento: um push a cada Admin, no máximo um por Agente no mês",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t, { orcamento: 3 });
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);
      const aba = await comOGeralAVista(t, geral);
      t.anthropic.reply({ text: "Um.", usage: DOIS_DOLARES }, { text: "Dois.", usage: DOIS_DOLARES });

      expect((await fim(aba, await enviar(t, geral.id, "@Faro um"))).state).toBe("done");
      expect((await fim(aba, await enviar(t, geral.id, "@Faro dois"))).state).toBe("done");

      const push = await daJuliana.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Faro estourou o orçamento do mês",
        body: "Gastou US$ 4,00 de US$ 3,00 na Chave. Até o mês virar ou o orçamento subir, Faro não usa a Chave.",
        navigate: expect.stringMatching(/\/agentes$/),
        tag: `orcamento-${faro.id}`,
      });
      expect(push.urgency).toBe("normal");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect(push.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);

      // O Admin sobe o teto, o Faro gasta e estoura de novo no mesmo mês: nenhum push novo.
      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 10 });
      t.anthropic.reply({ text: "Três.", usage: DOIS_DOLARES });
      expect((await fim(aba, await enviar(t, geral.id, "@Faro três"))).state).toBe("done");
      await t.as(juliana).patch(`/api/agents/${faro.id}`, { monthlyBudgetUsd: 5 });
      expect((await fim(aba, await enviar(t, geral.id, "@Faro quatro"))).state).toBe("not_acting");
      await dm(t, bruno, juliana, "viu o orçamento?");
      expect((await daJuliana.next(ESPERA)).payload.notification.body).toBe("viu o orçamento?");
      nadaPara(t, doBruno);
    },
    LONGO,
  );
});

/** 15:45 de hoje (o relógio dos testes começa em 2026-11-24T12:00Z). */
const QUINZE_E_QUARENTA_E_CINCO = "2026-11-24T15:45:00.000Z";
/** "15:45" na hora local do servidor (`TZ`), como "Minha Conta" mostra. */
const horaLocal = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const limiteAte = (iso: string): FakeRun => ({
  kind: "steps",
  steps: [{ text: "Parcial pela Conta" }, { rateLimit: { status: "rejected", resetsAt: Date.parse(iso) / 1000 } }],
  end: { result: "error", error: "rate_limit", apiErrorStatus: 429 },
});
const loginCaiu: FakeRun = { kind: "error", error: "authentication_failed", apiErrorStatus: 401 };

async function conta(t: TestApp, who = bruno): Promise<AccountDto> {
  return (await t.as(who).get("/api/account")).json();
}

describe("pushes da Conta", () => {
  test(
    "a Conta do Bruno chega ao limite: só ele recebe um único push, e as mensagens seguem pela Chave",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      await t.linkAccount(bruno);
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);
      const aba = await comOGeralAVista(t, geral);
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)] });
      t.anthropic.reply({ text: "Pela Chave." }, { text: "De novo pela Chave." });

      const primeira = await fim(aba, await enviar(t, geral.id, "@Faro um"));
      expect(primeira).toMatchObject({ state: "done", payer: "key" });
      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Sua Conta do Claude chegou ao limite",
        body: `Ela volta às ${horaLocal(QUINZE_E_QUARENTA_E_CINCO)}. Até lá, suas mensagens seguem pela Chave do Workspace.`,
        navigate: expect.stringMatching(/\/conta$/),
        tag: "conta",
      });
      expect(push.urgency).toBe("normal");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect(push.topic).toBe("conta");

      // Ainda no limite: a próxima nem tenta pela Conta, e nenhum push novo.
      expect((await fim(aba, await enviar(t, geral.id, "@Faro dois"))).payer).toBe("key");
      await dm(t, juliana, bruno, "oi");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("oi");
      // A Admin não recebe nada da Conta de outra pessoa.
      nadaPara(t, daJuliana);
    },
    LONGO,
  );

  test(
    "sem Chave, o login da Conta cai: um único push, e as mensagens esperam na fila até ligar de novo",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { chave: false });
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      const aba = await comOGeralAVista(t, geral);
      t.claude.script({ runs: [loginCaiu] });

      await enviar(t, geral.id, "@Faro um");
      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Sua Conta do Claude precisa ser ligada de novo",
        body: "Suas mensagens com Agentes esperam na fila até você ligar de novo em Minha Conta.",
        navigate: expect.stringMatching(/\/conta$/),
        tag: "conta",
      });
      expect((await conta(t)).status.state).toBe("needs_relink");

      // A segunda espera na fila também, sem push novo: o próximo do Bruno é o da DM.
      await enviar(t, geral.id, "@Faro dois");
      for (;;) {
        const { execution } = await aba.next("execution.updated", ESPERA);
        if (execution.held && execution.yourAccount?.state === "needs_relink") break;
      }
      await dm(t, juliana, bruno, "oi");
      expect((await doBruno.next(ESPERA)).payload.notification.body).toBe("oi");
    },
    LONGO,
  );

  test(
    "com a Chave, mas o Faro sem orçamento no mês: o push da queda não promete a Chave",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { orcamento: 0 });
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      await comOGeralAVista(t, geral);
      t.claude.script({ runs: [limiteAte(QUINZE_E_QUARENTA_E_CINCO)] });

      await enviar(t, geral.id, "@Faro um");
      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Sua Conta do Claude chegou ao limite",
        body: `Ela volta às ${horaLocal(QUINZE_E_QUARENTA_E_CINCO)}. Até lá, suas mensagens seguem pela Chave do Workspace; as para Agente sem orçamento no mês esperam na fila.`,
      });
    },
    LONGO,
  );

  test(
    "com a Chave, mas nenhum Agente com orçamento no mês: o push da queda diz que as mensagens esperam na fila",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t, { orcamento: 0 });
      const sophya = ((await (await t.as(juliana).get("/api/agents")).json()) as AgentDto[]).find((a) => a.builtin)!;
      await t.as(juliana).patch(`/api/agents/${sophya.id}`, { monthlyBudgetUsd: 0 });
      await t.linkAccount(bruno);
      const doBruno = await t.pushDevice(bruno);
      await comOGeralAVista(t, geral);
      t.claude.script({ runs: [loginCaiu] });

      await enviar(t, geral.id, "@Faro um");
      const push = await doBruno.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Sua Conta do Claude precisa ser ligada de novo",
        body: "Suas mensagens com Agentes esperam na fila até você ligar de novo em Minha Conta.",
      });
    },
    LONGO,
  );

  test(
    'outra pessoa liga a mesma assinatura: o primeiro dono recebe "Bruno também ligou a sua Conta do Claude"',
    async () => {
      const t = await testApp();
      await workspace(t);
      await t.linkAccount(juliana);
      const daJuliana = await t.pushDevice(juliana);
      const doBruno = await t.pushDevice(bruno);

      // Bruno liga a mesma assinatura (o mesmo e-mail), vê o aviso e escolhe "Ligar mesmo assim".
      expect((await t.as(bruno).post("/api/account/linking")).status).toBe(202);
      await eventually("o login mostrar a URL", async () => (await conta(t)).linking?.state === "waiting_code", 15_000);
      await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
      await eventually(
        "o aviso de assinatura repetida",
        async () => (await conta(t)).linking?.state === "duplicate",
        15_000,
      );
      expect((await t.as(bruno).post("/api/account/linking/confirm")).status).toBe(202);

      const push = await daJuliana.next(ESPERA);
      expect(push.payload.notification).toMatchObject({
        title: "Bruno também ligou a sua Conta do Claude",
        body: "A assinatura é pessoal: daqui em diante, vocês dividem o limite dela.",
        navigate: expect.stringMatching(/\/conta$/),
        tag: "conta-assinatura",
      });
      expect(push.urgency).toBe("normal");
      expect(push.ttl).toBe(PUSH_TTL_SECONDS);
      expect((await conta(t)).status.state).toBe("linked");
      // Quem ligou por último não recebe nada (e não fica sabendo quem é o outro dono).
      nadaPara(t, doBruno);
    },
    LONGO,
  );
});
