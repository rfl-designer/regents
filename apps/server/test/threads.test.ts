import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, FollowedThreadDto, MessageDto, UnreadDto } from "@regents/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

/** Estes testes passam por várias execuções em série; com a máquina carregada, levam tempo. */
const LENTO = 90_000;

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };

/** Juliana abre o Workspace (Admin, já no #geral); Bruno vira Membro e entra no #geral. */
async function geralComBruno(t: TestApp) {
  await t.addMember(bruno, { by: juliana });
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return geral!;
}

/** O que o roteamento da Articuladora devolve (o contrato de roteamento, em JSON). */
function desfecho(decisao: "responder" | "delegar" | "nenhum", motivo: string, agentes: [string, string][] = []) {
  return { json: { decisao, agentes: agentes.map(([agente, cobrir]) => ({ agente, cobrir })), motivo } };
}

/** Juliana grava a Chave e põe Faro e Prisma no #geral. */
async function geralComAgentes(t: TestApp) {
  const geral = await geralComBruno(t);
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-chave" });
  const agentes: AgentDto[] = [];
  for (const [name, description] of [
    ["Faro", "Comercial: propostas e preços."],
    ["Prisma", "Dados: relatórios."],
  ] as const) {
    const res = await t.as(juliana).post("/api/agents", { name, description, model: "claude-sonnet-5-5" });
    const agente: AgentDto = await res.json();
    await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: agente.id });
    agentes.push(agente);
  }
  return { geral, faro: agentes[0]!, prisma: agentes[1]! };
}

/** O `system` e a conversa da chamada `n` (a partir de 1) que chegou à Messages API falsa. */
async function chamada(t: TestApp, n: number) {
  const body = (await t.anthropic.waitForRequests(n))[n - 1]!.body;
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n");
  const conversa = body.messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")))
    .join("\n");
  return { body, system, conversa };
}

async function mensagens(t: TestApp, conversationId: string): Promise<MessageDto[]> {
  return (await t.as(juliana).get(`/api/conversations/${conversationId}/messages`)).json();
}

async function seguidas(t: TestApp, who: Person): Promise<FollowedThreadDto[]> {
  const res = await t.as(who).get("/api/threads/followed");
  expect(res.status).toBe(200);
  return res.json();
}

async function enviar(
  t: TestApp,
  who: Person,
  conversationId: string,
  body: string,
  threadRootId?: string,
): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body, threadRootId });
  expect(res.status).toBe(201);
  return res.json();
}

describe("Threads", () => {
  test(
    "um Membro abre uma Thread respondendo a uma mensagem: a resposta fica pendurada na raiz, fora do fluxo principal",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      const aba = await t.socket(juliana);
      const raiz = await enviar(t, juliana, geral.id, "Vamos fechar a proposta da Acme?");
      expect(raiz.threadRootId).toBeNull();
      await aba.next("message.created");

      const resposta = await enviar(t, bruno, geral.id, "Eu reviso o preço.", raiz.id);

      expect(resposta).toMatchObject({ channelId: geral.id, threadRootId: raiz.id, originMessageId: null });
      expect((await aba.next("message.created")).message).toEqual(resposta);
      const lista: MessageDto[] = await (await t.as(juliana).get(`/api/conversations/${geral.id}/messages`)).json();
      expect(lista).toEqual([raiz, resposta]);
    },
    LENTO,
  );

  test(
    "a Thread pendura numa mensagem do fluxo principal da mesma conversa",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      const raiz = await enviar(t, juliana, geral.id, "Raiz");
      const naThread = await enviar(t, bruno, geral.id, "Na Thread", raiz.id);
      const outro: ChannelDto = await (
        await t.as(juliana).post("/api/channels", { name: "vendas", kind: "public" })
      ).json();

      const recusas = [
        // Não há Thread dentro de Thread.
        await t.as(juliana).post(`/api/conversations/${geral.id}/messages`, { body: "x", threadRootId: naThread.id }),
        // A raiz é de outra conversa.
        await t.as(juliana).post(`/api/conversations/${outro.id}/messages`, { body: "x", threadRootId: raiz.id }),
        // A raiz não existe.
        await t
          .as(juliana)
          .post(`/api/conversations/${geral.id}/messages`, { body: "x", threadRootId: crypto.randomUUID() }),
        await t.as(juliana).post(`/api/conversations/${geral.id}/messages`, { body: "x", threadRootId: "nada" }),
      ];

      for (const res of recusas) {
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_input" });
      }
    },
    LENTO,
  );
});

describe("Thread seguida", () => {
  test(
    "seguem a Thread, sozinhos, o autor da raiz e quem respondeu nela; quem não participou, não",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      await t.addMember(carla, { by: juliana });
      const raiz = await enviar(t, juliana, geral.id, "Vamos fechar a proposta da Acme?");
      expect(await seguidas(t, juliana)).toEqual([]);

      t.clock.advance(60_000);
      const resposta = await enviar(t, bruno, geral.id, "Eu reviso o preço.", raiz.id);

      const seguida: FollowedThreadDto = {
        conversationId: geral.id,
        rootMessageId: raiz.id,
        since: resposta.createdAt,
      };
      expect(await seguidas(t, juliana)).toEqual([seguida]);
      expect(await seguidas(t, bruno)).toEqual([seguida]);
      expect(await seguidas(t, carla)).toEqual([]);
    },
    LENTO,
  );

  test(
    "quem é mencionado na Thread (ou na raiz) passa a segui-la, e cada um fica sabendo na hora",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      await t.addMember(carla, { by: juliana });
      const daCarla = await t.socket(carla, "aba da Carla");
      const doBruno = await t.socket(bruno, "aba do Bruno");
      const raiz = await enviar(t, juliana, geral.id, "@bruno, a Acme respondeu?");

      const resposta = await enviar(t, juliana, geral.id, "@carla, você viu?", raiz.id);

      const seguida = { conversationId: geral.id, rootMessageId: raiz.id, since: resposta.createdAt };
      expect((await daCarla.next("thread.followed")).thread).toEqual(seguida);
      expect((await doBruno.next("thread.followed")).thread).toEqual(seguida);
      expect(await seguidas(t, carla)).toEqual([seguida]);
      expect(await seguidas(t, bruno)).toEqual([seguida]);
    },
    LENTO,
  );

  test(
    "seguir é uma vez só: responder de novo não muda desde quando",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      const raiz = await enviar(t, juliana, geral.id, "Raiz");
      const primeira = await enviar(t, bruno, geral.id, "Um", raiz.id);
      t.clock.advance(60_000);
      await enviar(t, bruno, geral.id, "Dois", raiz.id);
      await enviar(t, juliana, geral.id, "Três", raiz.id);

      expect(await seguidas(t, bruno)).toEqual([
        { conversationId: geral.id, rootMessageId: raiz.id, since: primeira.createdAt },
      ]);
      expect(await seguidas(t, juliana)).toEqual([
        { conversationId: geral.id, rootMessageId: raiz.id, since: primeira.createdAt },
      ]);
    },
    LENTO,
  );
});

describe("Desfecho numa Thread", () => {
  test(
    "cada mensagem de pessoa na Thread recebe Desfecho, e a resposta ancorada fica na Thread",
    async () => {
      const t = await testApp();
      const { geral, faro } = await geralComAgentes(t);
      const aba = await t.socket(juliana);
      t.anthropic.reply(desfecho("nenhum", "Recado."));
      const raiz = await enviar(t, juliana, geral.id, "Chegou a proposta da Acme.");
      await t.anthropic.waitForRequests(1);
      t.anthropic.reply(desfecho("delegar", "É preço.", [["faro", "O desconto possível."]]), { text: "Até 10%." });

      const naThread = await enviar(t, bruno, geral.id, "Qual desconto dá para dar?", raiz.id);

      const espera = { timeoutMs: 10_000 };
      const outcomes = [
        (await aba.next("outcome.created", espera)).outcome,
        (await aba.next("outcome.created", espera)).outcome,
      ];
      expect(outcomes.map((o) => [o.messageId, o.decision])).toEqual([
        [raiz.id, "none"],
        [naThread.id, "delegate"],
      ]);
      const resposta = await eventually(
        "o Faro responder na Thread",
        async () => (await mensagens(t, geral.id)).find((m) => m.author.id === faro.id),
        10_000,
      );
      expect(resposta).toMatchObject({ originMessageId: naThread.id, threadRootId: raiz.id, body: "Até 10%." });
    },
    LENTO,
  );

  test(
    "o roteamento recebe a raiz e a Thread (não o fluxo principal) e prefere os Agentes que já falaram ali",
    async () => {
      const t = await testApp();
      const { geral, faro } = await geralComAgentes(t);
      t.anthropic.reply(desfecho("nenhum", "Recado."), desfecho("nenhum", "Recado."));
      const raiz = await enviar(t, juliana, geral.id, "Chegou a proposta da Acme.");
      await t.anthropic.waitForRequests(1);
      await enviar(t, juliana, geral.id, "Outro assunto no Canal.");
      await t.anthropic.waitForRequests(2);
      t.anthropic.reply(desfecho("delegar", "É preço.", [["faro", "O desconto."]]), { text: "Até 10%." });
      const primeira = await enviar(t, bruno, geral.id, "Qual desconto dá para dar?", raiz.id);
      await t.anthropic.waitForRequests(4);
      await eventually(
        "o Faro responder",
        async () => (await mensagens(t, geral.id)).find((m) => m.author.id === faro.id),
        10_000,
      );
      t.anthropic.reply(desfecho("nenhum", "Ok."));

      await enviar(t, bruno, geral.id, "E o prazo?", raiz.id);

      const { system, conversa } = await chamada(t, 5);
      expect(system).toContain("numa Thread do Canal #geral");
      expect(system).toContain("## Já falaram nesta Thread\n\n- @faro (Faro)");
      expect(system).toContain("Prefira, entre os Agentes do Canal, os que já falaram nesta Thread");
      expect(conversa).toContain("Juliana (pessoa): Chegou a proposta da Acme.");
      expect(conversa).toContain(`Bruno (pessoa): ${primeira.body}`);
      expect(conversa).toContain("Faro (Agente): Até 10%.");
      expect(conversa).toContain("Bruno (pessoa): E o prazo?");
      expect(conversa).not.toContain("Outro assunto no Canal.");
      // O roteamento no fluxo principal não conhece a Thread.
      const { conversa: noCanal } = await chamada(t, 2);
      expect(noCanal).not.toContain("Thread");
    },
    LENTO,
  );
});

/** As chamadas a Agentes (não ao roteamento) que chegaram à Messages API falsa, como texto. */
async function chamadasAAgentes(t: TestApp, n: number) {
  const pedidos = await eventually(
    `${n} chamada(s) a Agente`,
    async () => {
      const lista = t.anthropic.requests.filter((r) => !r.body.output_config);
      return lista.length >= n ? lista : undefined;
    },
    10_000,
  );
  return pedidos.map(({ body }) => ({
    system: typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("\n"),
    conversa: body.messages
      .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")))
      .join("\n"),
  }));
}

describe("contexto numa Thread", () => {
  test(
    "o Agente recebe a raiz sempre, mais as últimas N da Thread, e sabe que está numa Thread",
    async () => {
      const t = await testApp();
      const { geral } = await geralComAgentes(t);
      await t.as(juliana).patch(`/api/channel-settings/${geral.id}`, { recentMessages: 1 });
      const raiz = await enviar(t, juliana, geral.id, "Chegou a proposta da Acme.");
      await enviar(t, bruno, geral.id, "Primeira da Thread.", raiz.id);
      await enviar(t, juliana, geral.id, "Segunda da Thread.", raiz.id);
      await enviar(t, juliana, geral.id, "Depois, no Canal.");

      await enviar(t, bruno, geral.id, "@faro, qual desconto dá?", raiz.id);

      const [{ system, conversa }] = (await chamadasAAgentes(t, 1)) as [{ system: string; conversa: string }];
      expect(system).toContain("chamou você com uma Menção numa Thread do Canal #geral");
      expect(conversa).toContain(
        [
          "Juliana (pessoa): Chegou a proposta da Acme.",
          "Juliana (pessoa): Segunda da Thread.",
          "Bruno (pessoa): @faro, qual desconto dá?",
        ].join("\n\n"),
      );
      expect(conversa).not.toContain("Primeira da Thread.");
      expect(conversa).not.toContain("Depois, no Canal.");
    },
    LENTO,
  );

  test(
    "com N = 0, numa Thread vão a raiz e a mensagem; no fluxo principal, as mensagens de Thread não entram",
    async () => {
      const t = await testApp();
      const { geral } = await geralComAgentes(t);
      const raiz = await enviar(t, juliana, geral.id, "Chegou a proposta da Acme.");
      await enviar(t, bruno, geral.id, "Conversa na Thread.", raiz.id);

      await enviar(t, bruno, geral.id, "@faro, resume o Canal?");
      const [noCanal] = await chamadasAAgentes(t, 1);
      expect(noCanal!.conversa).toContain("Juliana (pessoa): Chegou a proposta da Acme.");
      expect(noCanal!.conversa).not.toContain("Conversa na Thread.");

      await t.as(juliana).patch(`/api/channel-settings/${geral.id}`, { recentMessages: 0 });
      await enviar(t, bruno, geral.id, "@prisma, e os números?", raiz.id);
      const [, naThread] = await chamadasAAgentes(t, 2);
      expect(naThread!.conversa).toContain(
        ["Juliana (pessoa): Chegou a proposta da Acme.", "Bruno (pessoa): @prisma, e os números?"].join("\n\n"),
      );
      expect(naThread!.conversa).not.toContain("Conversa na Thread.");
    },
    LENTO,
  );
});

async function naoLidas(t: TestApp, who: Person): Promise<UnreadDto> {
  return (await t.as(who).get("/api/unread")).json();
}

describe("não-lido numa Thread", () => {
  test(
    "a mensagem de Thread conta como não-lida só para quem segue a Thread, e só a partir de quando segue",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      await t.addMember(carla, { by: juliana });
      await t.as(carla).post(`/api/channels/${geral.id}/join`);
      const raiz = await enviar(t, juliana, geral.id, "Chegou a proposta da Acme.");
      await t.as(bruno).post(`/api/conversations/${geral.id}/reads`, { messageIds: [raiz.id] });
      await t.as(carla).post(`/api/conversations/${geral.id}/reads`, { messageIds: [raiz.id] });

      const primeira = await enviar(t, bruno, geral.id, "Eu reviso o preço.", raiz.id);

      expect((await naoLidas(t, juliana)).conversations).toEqual([
        { conversationId: geral.id, count: 1, mentions: 0, firstUnreadId: primeira.id },
      ]);
      expect(await naoLidas(t, carla)).toEqual({ conversations: [], total: 0, mentions: 0, dms: 0 });

      t.clock.advance(60_000);
      const comMencao = await enviar(t, bruno, geral.id, "@carla, confere?", raiz.id);

      expect(await naoLidas(t, carla)).toEqual({
        conversations: [{ conversationId: geral.id, count: 1, mentions: 1, firstUnreadId: comMencao.id }],
        total: 1,
        mentions: 1,
        dms: 0,
      });
    },
    LENTO,
  );

  test(
    "na ordem de exibição, a Thread vem logo depois da raiz e das respostas ancoradas a ela",
    async () => {
      const t = await testApp();
      const geral = await geralComBruno(t);
      await t.addMember(carla, { by: juliana });
      await t.as(carla).post(`/api/channels/${geral.id}/join`);
      const raiz = await enviar(t, bruno, geral.id, "Chegou a proposta da Acme.");
      const depois = await enviar(t, bruno, geral.id, "Outro assunto.");
      const naThread = await enviar(t, carla, geral.id, "@juliana, olha isto.", raiz.id);
      const outra = await enviar(t, bruno, geral.id, "Visto.", raiz.id);

      const { messageIds } = await (await t.as(juliana).get(`/api/conversations/${geral.id}/unread`)).json();

      expect(messageIds).toEqual([raiz.id, naThread.id, outra.id, depois.id]);
      expect((await naoLidas(t, juliana)).conversations[0]).toMatchObject({ count: 4, firstUnreadId: raiz.id });
    },
    LENTO,
  );
});
