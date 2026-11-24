/**
 * Menção escrita por Agente a uma pessoa (Spec, histórias 62, 91 e 94): a resposta do Agente que
 * cita `@Carla` registra a Menção como a de uma pessoa registraria. A Carla recebe o push de
 * Menção (`Urgency: high`), a Menção conta nas não-lidas dela, a mensagem sai com a Menção (o
 * destaque "menciona você" no PWA) e, numa Thread, ela passa a seguir a Thread.
 *
 * Menção de Agente a Agente continua sem disparar nada: o Agente citado na resposta não responde.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, FollowedThreadDto, MessageDto, UnreadDto } from "@shearim/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "1003", login: "carla@exemplo.com", name: "Carla" };
const ESPERA = { timeoutMs: 10_000 };
const LONGO = 120_000;
const CHAVE = "sk-ant-api03-chave-do-workspace";

async function criarAgente(t: TestApp, name: string): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description: "Comercial.",
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Juliana vira Admin, grava a Chave, cria o Faro e o põe no #geral; Bruno e Carla entram. */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const faro = await criarAgente(t, "Faro");
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  const ids = { bruno: await t.addMember(bruno, { by: juliana }), carla: await t.addMember(carla, { by: juliana }) };
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  await t.as(carla).post(`/api/channels/${geral!.id}/join`);
  return { faro, geral: geral!, ids };
}

async function enviar(t: TestApp, who: Person, channelId: string, body: string, threadRootId?: string) {
  const res = await t
    .as(who)
    .post(`/api/conversations/${channelId}/messages`, { body, ...(threadRootId ? { threadRootId } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

async function naoLidas(t: TestApp, who: Person): Promise<UnreadDto> {
  return (await t.as(who).get("/api/unread")).json();
}

describe("Menção escrita por Agente a uma pessoa", () => {
  test(
    "a resposta do Faro que cita @Carla sai com a Menção, avisa a Carla com Urgency high e conta nas não-lidas dela",
    async () => {
      const t = await testApp();
      const { faro, geral, ids } = await workspace(t);
      const daCarla = await t.pushDevice(carla);
      const abaDaCarla = await t.socket(carla);
      t.anthropic.reply({ text: "@Carla pode confirmar o preço?" });

      const origem = await enviar(t, bruno, geral.id, "@Faro qual o preço?");

      let resposta: MessageDto;
      for (;;) {
        const { message } = await abaDaCarla.next("message.created", ESPERA);
        if (message.originMessageId === origem.id) {
          resposta = message;
          break;
        }
      }
      expect(resposta.author).toMatchObject({ kind: "agent", id: faro.id });
      expect(resposta.mentions).toEqual([{ kind: "member", id: ids.carla.id }]);

      const push = await daCarla.next(ESPERA);
      expect(push.urgency).toBe("high");
      expect(push.payload).toMatchObject({
        notification: { title: "#geral · Faro", body: "@Carla pode confirmar o preço?", tag: geral.id },
      });

      const unread = await naoLidas(t, carla);
      expect(unread.mentions).toBe(1);
      expect(unread.conversations).toEqual([expect.objectContaining({ conversationId: geral.id, mentions: 1 })]);

      const lista: MessageDto[] = await (await t.as(carla).get(`/api/conversations/${geral.id}/messages`)).json();
      expect(lista.find((m) => m.id === resposta.id)?.mentions).toEqual([{ kind: "member", id: ids.carla.id }]);
    },
    LONGO,
  );

  test(
    "numa Thread, a Carla citada pelo Faro passa a seguir a Thread",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const aba = await t.socket(bruno);
      t.anthropic.reply({ text: "Oi." }, { text: "@Carla segue aqui comigo." });

      const raiz = await enviar(t, bruno, geral.id, "@Faro oi");
      for (;;) {
        const { message } = await aba.next("message.created", ESPERA);
        if (message.originMessageId === raiz.id) break;
      }
      const naThread = await enviar(t, bruno, geral.id, "@Faro chama alguém", raiz.id);
      for (;;) {
        const { message } = await aba.next("message.created", ESPERA);
        if (message.originMessageId === naThread.id) {
          expect(message.threadRootId).toBe(raiz.id);
          break;
        }
      }

      const seguidas: FollowedThreadDto[] = await (await t.as(carla).get("/api/threads/followed")).json();
      expect(seguidas.map((s) => s.rootMessageId)).toEqual([raiz.id]);
    },
    LONGO,
  );

  test(
    "a resposta do Faro que cita outro Agente não faz esse Agente responder",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const lince = await criarAgente(t, "Lince");
      await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: lince.id });
      const aba = await t.socket(bruno);
      t.anthropic.reply({ text: "@Lince você sabe?" });

      const origem = await enviar(t, bruno, geral.id, "@Faro qual o preço?");
      for (;;) {
        const { message } = await aba.next("message.created", ESPERA);
        if (message.originMessageId === origem.id) break;
      }
      await t.drain();

      const chamadas = t.anthropic.requests.filter((r) => !r.body.output_config);
      expect(chamadas).toHaveLength(1);
      const andamento = await (await t.as(bruno).get(`/api/conversations/${geral.id}/executions`)).json();
      expect(andamento).toEqual([]);
    },
    LONGO,
  );
});
