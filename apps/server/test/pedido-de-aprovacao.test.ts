/**
 * Pedido de aprovação pela Chave (#50, ADR 0011): a escrita "postar mensagem" e "responder em
 * Thread", pela borda do servidor.
 *
 * - Quando o modelo pede uma escrita, o Shearim cria o Pedido e a execução termina em "esperando
 *   aprovação", sem ocupar vaga; o texto parcial é descartado.
 * - O Pedido aparece para todos que veem a conversa, com o resumo exato; só o autor decide.
 * - Na aprovação, o Shearim posta como o Agente (sem Desfecho, sem acionar Agente) e a continuação
 *   termina a resposta; na recusa, a continuação recebe a recusa e o motivo.
 * - Escrita fora do alcance é falha da Ferramenta, sem Pedido; o alcance é conferido de novo na
 *   aprovação.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ApprovalRequestDto, ChannelDto, ExecutionDto, MessageDto, UnreadDto } from "@regents/contracts";
import { and, eq } from "drizzle-orm";
import { approvalTtlFromEnv } from "../src/approvals";
import { configFrom } from "../src/config";
import { schema } from "../src/db/client";
import { EXCERPT_MAX } from "../src/push";
import type { ToolDefinition, WriteTool } from "../src/tools/port";
import { WORKSPACE_TOOLS } from "../src/tools/workspace";
import { toolResults } from "./fakes/messages-api";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

/**
 * Juliana vira Admin, grava a Chave, cria o Faro (com "postar mensagem" e "responder em Thread") e
 * o põe no #geral e no #anuncios; Bruno entra nos dois (sem Conta: paga a Chave).
 */
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
  const anuncios = await canal(t, "anuncios", "public");
  for (const c of [geral!, anuncios]) await t.as(juliana).post(`/api/channels/${c.id}/agents`, { agentId: faro.id });
  await t.addMember(bruno, { by: juliana });
  for (const c of [geral!, anuncios]) await t.as(bruno).post(`/api/channels/${c.id}/join`);
  for (const tool of ["postar_mensagem", "responder_thread"]) {
    expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${tool}`)).status).toBe(200);
  }
  return { faro, geral: geral!, anuncios };
}

async function canal(t: TestApp, name: string, kind: "public" | "private", who = juliana): Promise<ChannelDto> {
  const res = await t.as(who).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return res.json();
}

async function enviar(t: TestApp, channelId: string, body: string, who = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function mensagens(t: TestApp, channelId: string, who = juliana): Promise<MessageDto[]> {
  return (await t.as(who).get(`/api/conversations/${channelId}/messages`)).json();
}

async function respostaA(t: TestApp, channelId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => (await mensagens(t, channelId)).find((m) => m.originMessageId === origem.id),
    10_000,
  );
}

async function pedidos(t: TestApp, channelId: string, who = juliana): Promise<ApprovalRequestDto[]> {
  const res = await t.as(who).get(`/api/conversations/${channelId}/approvals`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Espera o Pedido pendente de número `n` (1 é o primeiro) da conversa. */
async function pedidoPendente(t: TestApp, channelId: string, n = 1) {
  return eventually(
    "o Pedido aparecer",
    async () => {
      const lista = await pedidos(t, channelId);
      return lista.length >= n && lista[n - 1]!.state === "pending" && lista[n - 1];
    },
    10_000,
  );
}

const aprovar = (t: TestApp, p: ApprovalRequestDto, who = bruno) =>
  t.as(who).post(`/api/conversations/${p.channelId}/approvals/${p.id}/approve`);
const recusar = (t: TestApp, p: ApprovalRequestDto, body: unknown = {}, who = bruno) =>
  t.as(who).post(`/api/conversations/${p.channelId}/approvals/${p.id}/reject`, body);

async function andamento(aba: EventSocket, origem: MessageDto, ok: (e: ExecutionDto) => boolean) {
  for (;;) {
    const { execution } = await aba.next("execution.updated", { timeoutMs: 10_000 });
    if (execution.originMessageId === origem.id && ok(execution)) return execution;
  }
}

/** As chamadas de resposta (sem o roteamento da Articuladora) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
/** O texto inteiro que um pedido mandou como mensagens (para ver o que a continuação recebeu). */
const textoDe = (req: { body: { messages: { content: unknown }[] } }) => JSON.stringify(req.body.messages);

describe("a escrita vira Pedido de aprovação", () => {
  test(
    "o modelo pede para postar: a execução termina esperando aprovação, sem o texto parcial, e o Pedido aparece para todos com o resumo",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const abaDaJuliana = await t.socket(juliana);

      t.anthropic.reply({
        text: "Vou avisar lá.",
        toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou para 15h." } }],
      });
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou para 15h");

      const esperando = await andamento(abaDaJuliana, origem, (e) => e.state === "awaiting_approval");
      expect(esperando.step).toBeNull();
      const { approval } = await abaDaJuliana.next("approval.created", { timeoutMs: 10_000 });
      expect(approval).toMatchObject({
        channelId: geral.id,
        originMessageId: origem.id,
        executionId: esperando.id,
        agent: { displayName: "Faro" },
        author: { displayName: "Bruno" },
        tool: "postar_mensagem",
        toolTitle: "postar mensagem",
        summary: "Postar em #anuncios: “A reunião mudou para 15h.”",
        state: "pending",
      });
      expect(await pedidos(t, geral.id)).toEqual([approval]);

      // O texto parcial ("Vou avisar lá.") não vira resposta.
      expect((await mensagens(t, geral.id)).some((m) => m.originMessageId === origem.id)).toBe(false);
      // A execução continua à vista, esperando, e não ocupa a vez do Faro: a próxima mensagem sai.
      const [aberta] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ id: esperando.id, state: "awaiting_approval" });
      t.anthropic.reply({ text: "Bom dia, Bruno." });
      const outra = await enviar(t, geral.id, "@Faro bom dia");
      expect((await respostaA(t, geral.id, outra)).body).toBe("Bom dia, Bruno.");
    },
    LONGO,
  );
});

describe("a decisão do autor", () => {
  test(
    "só o autor aprova; na aprovação o Shearim posta como o Agente, sem Desfecho nem Agente acionado, e a continuação termina a resposta",
    async () => {
      const t = await testApp();
      const { faro, geral, anuncios } = await workspace(t);
      // Um segundo Agente no #anuncios: uma mensagem de pessoa ali iria ao roteamento da Articuladora.
      const prisma: AgentDto = await (
        await t.as(juliana).post("/api/agents", {
          name: "Prisma",
          photo: null,
          description: "Dados.",
          instructions: "Você é a Prisma.",
          model: "claude-sonnet-5-5",
        })
      ).json();
      await t.as(juliana).post(`/api/channels/${anuncios.id}/agents`, { agentId: prisma.id });
      const abaDaJuliana = await t.socket(juliana);

      t.anthropic.reply(
        {
          text: "Vou avisar lá.",
          toolUse: [
            {
              id: "toolu_1",
              name: "postar_mensagem",
              input: { conversa: "anuncios", texto: "@prisma a reunião mudou para 15h." },
            },
          ],
        },
        { text: "Pronto, avisei no #anuncios." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou");
      const pedido = await pedidoPendente(t, geral.id);
      await abaDaJuliana.next("approval.created", { timeoutMs: 10_000 });

      // Quem não é o autor vê, mas não decide.
      const alheio = await aprovar(t, pedido, juliana);
      expect(alheio.status).toBe(403);
      expect(await alheio.json()).toEqual({ error: "not_author" });
      expect((await recusar(t, pedido, {}, juliana)).status).toBe(403);

      const aprovado = await aprovar(t, pedido);
      expect(aprovado.status).toBe(200);
      expect(await aprovado.json()).toMatchObject({
        id: pedido.id,
        state: "approved",
        result: "mensagem postada em #anuncios",
        failure: null,
      });
      const { approval } = await abaDaJuliana.next("approval.updated", { timeoutMs: 10_000 });
      expect(approval).toMatchObject({ id: pedido.id, state: "approved" });

      // A mensagem sai como do Faro, exatamente o texto aprovado.
      const postada = (await mensagens(t, anuncios.id)).at(-1)!;
      expect(postada).toMatchObject({
        body: "@prisma a reunião mudou para 15h.",
        author: { kind: "agent", id: faro.id },
        originMessageId: null,
      });

      // A continuação termina a resposta, sabendo o que foi feito.
      expect((await respostaA(t, geral.id, origem)).body).toBe("Pronto, avisei no #anuncios.");
      const [, continuacao] = respostas(t);
      expect(textoDe(continuacao!)).toContain("Postar em #anuncios: “@prisma a reunião mudou para 15h.”");
      expect(textoDe(continuacao!)).toContain("Bruno aprovou, e o Shearim fez: mensagem postada em #anuncios");
      // A continuação não pediu de novo a escrita: só dois pedidos de resposta, nenhum roteamento.
      expect(t.anthropic.requests).toHaveLength(2);
      const noAnuncios = (await (
        await t.as(juliana).get(`/api/conversations/${anuncios.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(noAnuncios).toEqual([]);
      expect(await (await t.as(juliana).get(`/api/conversations/${anuncios.id}/outcomes`)).json()).toEqual([]);

      // Um Pedido decidido não se decide de novo.
      const deNovo = await aprovar(t, pedido);
      expect(deNovo.status).toBe(409);
      expect(await deNovo.json()).toEqual({ error: "not_pending" });
      expect((await recusar(t, pedido)).status).toBe(409);
    },
    LONGO,
  );

  test(
    "na recusa, com motivo, a continuação recebe a recusa e o motivo, e nada é postado",
    async () => {
      const t = await testApp();
      const { geral, anuncios } = await workspace(t);
      const abaDaJuliana = await t.socket(juliana);

      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "REUNIÃO MUDOU!!!" } }] },
        { text: "Tudo bem, não avisei." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios que a reunião mudou");
      const pedido = await pedidoPendente(t, geral.id);

      const recusado = await recusar(t, pedido, { reason: "  muda o tom  " });
      expect(recusado.status).toBe(200);
      expect(await recusado.json()).toMatchObject({ state: "rejected", rejectReason: "muda o tom", result: null });
      const { approval } = await andamentoDoPedido(abaDaJuliana, pedido.id);
      expect(approval.state).toBe("rejected");

      expect((await respostaA(t, geral.id, origem)).body).toBe("Tudo bem, não avisei.");
      const [, continuacao] = respostas(t);
      expect(textoDe(continuacao!)).toContain("Bruno recusou, com o motivo: muda o tom");
      expect((await mensagens(t, anuncios.id)).some((m) => m.author.kind === "agent")).toBe(false);
    },
    LONGO,
  );
});

/**
 * Juliana escreve em `channelId` (com outro Agente além da Articuladora, a mensagem vai ao
 * roteamento) e a Articuladora decide que ninguém precisa agir. Devolve a mensagem.
 */
async function semDesfecho(t: TestApp, channelId: string, body: string) {
  t.anthropic.reply({ json: { decisao: "nenhum", agentes: [], motivo: "Ninguém precisa agir." } });
  const mensagem = await enviar(t, channelId, body, juliana);
  await eventually(
    "o Desfecho sair",
    async () =>
      ((await (await t.as(juliana).get(`/api/conversations/${channelId}/outcomes`)).json()) as unknown[]).length > 0,
    10_000,
  );
  return mensagem;
}

/** O próximo `approval.updated` do Pedido `id`. */
async function andamentoDoPedido(aba: EventSocket, id: string) {
  for (;;) {
    const event = await aba.next("approval.updated", { timeoutMs: 10_000 });
    if (event.approval.id === id) return event;
  }
}

describe("o alcance da escrita", () => {
  test(
    "postar numa conversa de que o Agente não participa, ou em que o autor não pode escrever, é falha da Ferramenta com motivo, sem Pedido",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      // #vendas: público, sem o Faro. #diretoria: privado, com o Faro, sem o Bruno.
      await canal(t, "vendas", "public");
      const diretoria = await canal(t, "diretoria", "private");
      const faro = ((await (await t.as(juliana).get("/api/agents")).json()) as AgentDto[]).find(
        (a) => a.name === "Faro",
      )!;
      await t.as(juliana).post(`/api/channels/${diretoria.id}/agents`, { agentId: faro.id });
      const aba = await t.socket(bruno);

      t.anthropic.reply(
        {
          toolUse: [{ id: "toolu_1", name: "postar_mensagem", input: { conversa: "#vendas", texto: "Oi, vendas." } }],
        },
        {
          toolUse: [
            { id: "toolu_2", name: "postar_mensagem", input: { conversa: "#diretoria", texto: "Oi, diretoria." } },
          ],
        },
        { text: "Não consegui postar em nenhum dos dois." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa vendas e o outro Canal");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Não consegui postar em nenhum dos dois.");

      const [, segunda, terceira] = respostas(t);
      expect(toolResults(segunda!.body)[0]).toMatchObject({
        tool_use_id: "toolu_1",
        is_error: true,
        content: "A Ferramenta postar mensagem falhou: o Agente não participa dessa conversa.",
      });
      expect(toolResults(terceira!.body)[0]).toMatchObject({
        tool_use_id: "toolu_2",
        is_error: true,
        content: "A Ferramenta postar mensagem falhou: a conversa não existe ou quem escreveu não pode escrever nela.",
      });
      expect(await pedidos(t, geral.id)).toEqual([]);
      // O Andamento mostrou as duas falhas, sem o nome de #diretoria.
      const falhas = aba
        .received()
        .flatMap((e) => (e.type === "execution.updated" ? e.execution.tools : []))
        .filter((c) => c.state === "failed");
      expect(falhas.map((c) => c.reason)).toContain("o Agente não participa dessa conversa");
      expect(JSON.stringify(aba.received())).not.toContain("diretoria");
    },
    LONGO,
  );

  test(
    "de um Canal público, postar num Canal privado do autor é falha sem Pedido: a escrita não sai do alcance de leitura, e o nome não aparece",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      // #diretoria: privado, com o Faro e o Bruno. O Bruno pode escrever lá, mas o #geral é público.
      const diretoria = await canal(t, "diretoria", "private");
      await t.as(juliana).post(`/api/channels/${diretoria.id}/agents`, { agentId: faro.id });
      const brunoMe = (await (await t.as(bruno).get("/api/me")).json()) as { id: string };
      await t.as(juliana).post(`/api/channels/${diretoria.id}/participants`, { memberId: brunoMe.id });
      const aba = await t.socket(juliana);

      t.anthropic.reply(
        {
          toolUse: [
            {
              id: "toolu_1",
              name: "postar_mensagem",
              input: { conversa: "#diretoria", texto: "Fechamos o contrato." },
            },
          ],
        },
        { text: "Não consegui postar lá." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa a diretoria que fechamos");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Não consegui postar lá.");

      expect(toolResults(respostas(t)[1]!.body)[0]).toMatchObject({
        tool_use_id: "toolu_1",
        is_error: true,
        content: "A Ferramenta postar mensagem falhou: a conversa não existe ou quem escreveu não pode escrever nela.",
      });
      expect(await pedidos(t, geral.id)).toEqual([]);
      expect((await mensagens(t, diretoria.id)).some((m) => m.author.kind === "agent")).toBe(false);
      // Nem o Andamento nem um Pedido, que todos do #geral veem, dizem o nome do #diretoria.
      const visiveis = aba.received().filter((e) => e.type === "execution.updated" || e.type.startsWith("approval."));
      expect(visiveis.length).toBeGreaterThan(0);
      expect(JSON.stringify(visiveis)).not.toContain("diretoria");
    },
    LONGO,
  );

  test(
    "se o autor perdeu o acesso durante a espera, a ação aprovada falha com motivo e a continuação recebe a falha",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      // A mensagem sai do #time, privado, com Juliana e Bruno: o #diretoria, de que os dois
      // participam, está no alcance da resposta.
      const brunoMe = (await (await t.as(bruno).get("/api/me")).json()) as { id: string };
      const [time, diretoria] = [await canal(t, "time", "private"), await canal(t, "diretoria", "private")];
      for (const c of [time, diretoria]) {
        await t.as(juliana).post(`/api/channels/${c.id}/agents`, { agentId: faro.id });
        await t.as(juliana).post(`/api/channels/${c.id}/participants`, { memberId: brunoMe.id });
      }
      const geral = time;

      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#diretoria", texto: "Fechamos o contrato." } }] },
        { text: "Não deu para postar na diretoria." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa a diretoria que fechamos");
      const pedido = await pedidoPendente(t, geral.id);
      expect(pedido.summary).toBe("Postar em #diretoria: “Fechamos o contrato.”");

      // Bruno deixa de participar do #diretoria durante a espera. Não há rota para tirar alguém de
      // um Canal privado, e sair do Workspace cancela o Pedido (teste abaixo): a perda do acesso
      // é simulada no banco, para provar que a aprovação confere o alcance de novo na hora de agir.
      await t.db
        .delete(schema.channelParticipants)
        .where(
          and(
            eq(schema.channelParticipants.channelId, diretoria.id),
            eq(schema.channelParticipants.memberId, brunoMe.id),
          ),
        );

      const aprovado = await aprovar(t, pedido);
      expect(aprovado.status).toBe(200);
      expect(await aprovado.json()).toMatchObject({
        state: "approved",
        result: null,
        failure: "a conversa não existe ou quem escreveu não pode escrever nela",
      });
      expect((await mensagens(t, diretoria.id)).some((m) => m.author.kind === "agent")).toBe(false);
      expect((await respostaA(t, geral.id, origem)).body).toBe("Não deu para postar na diretoria.");
      expect(textoDe(respostas(t)[1]!)).toContain(
        "Bruno aprovou, mas a ação falhou: a conversa não existe ou quem escreveu não pode escrever nela",
      );
    },
    LONGO,
  );
});

describe("responder em Thread e duas escritas", () => {
  test(
    "duas escritas numa resposta geram dois Pedidos, um depois do outro, cada um decidido à parte",
    async () => {
      const t = await testApp();
      const { geral, anuncios } = await workspace(t);
      const raiz = await semDesfecho(t, anuncios.id, "Quem vai no evento de sexta?");

      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Evento confirmado." } }] },
        { toolUse: [{ name: "responder_thread", input: { mensagem: raiz.id, texto: "Eu vou, e o Bruno também." } }] },
        { text: "Postei o aviso; a resposta na Thread ficou de fora." },
      );
      const origem = await enviar(t, geral.id, "@Faro confirma o evento e responde a Juliana");

      const primeiro = await pedidoPendente(t, geral.id, 1);
      expect(await pedidos(t, geral.id)).toHaveLength(1);
      expect((await aprovar(t, primeiro)).status).toBe(200);

      const segundo = await pedidoPendente(t, geral.id, 2);
      expect(segundo.id).not.toBe(primeiro.id);
      expect(segundo).toMatchObject({
        tool: "responder_thread",
        toolTitle: "responder em Thread",
        summary:
          "Responder na Thread de Juliana em #anuncios (“Quem vai no evento de sexta?”): “Eu vou, e o Bruno também.”",
      });
      expect((await recusar(t, segundo)).status).toBe(200);

      expect((await respostaA(t, geral.id, origem)).body).toBe("Postei o aviso; a resposta na Thread ficou de fora.");
      const ultima = textoDe(respostas(t)[2]!);
      expect(ultima).toContain("Bruno aprovou, e o Shearim fez: mensagem postada em #anuncios");
      expect(ultima).toContain("Bruno recusou, sem dar motivo");
      expect((await pedidos(t, geral.id)).map((p) => p.state)).toEqual(["approved", "rejected"]);
      const doAnuncios = await mensagens(t, anuncios.id);
      expect(doAnuncios.filter((m) => m.author.kind === "agent").map((m) => m.body)).toEqual(["Evento confirmado."]);
    },
    LONGO,
  );

  test(
    "aprovada, a resposta na Thread sai na Thread da mensagem, como o Agente",
    async () => {
      const t = await testApp();
      const { faro, geral, anuncios } = await workspace(t);
      const raiz = await semDesfecho(t, anuncios.id, "Quem vai no evento de sexta?");

      t.anthropic.reply(
        { toolUse: [{ name: "responder_thread", input: { mensagem: raiz.id, texto: "O Bruno vai." } }] },
        { text: "Respondi na Thread." },
      );
      const origem = await enviar(t, geral.id, "@Faro diz para a Juliana que eu vou");
      const pedido = await pedidoPendente(t, geral.id);
      expect(await (await aprovar(t, pedido)).json()).toMatchObject({
        result: "resposta postada na Thread em #anuncios",
      });
      expect((await mensagens(t, anuncios.id)).at(-1)).toMatchObject({
        body: "O Bruno vai.",
        threadRootId: raiz.id,
        author: { kind: "agent", id: faro.id },
      });
      expect((await respostaA(t, geral.id, origem)).body).toBe("Respondi na Thread.");
    },
    LONGO,
  );
});

const HORA = 60 * 60_000;

describe("o Pedido que ninguém decide", () => {
  test(
    "pendente há 24 h, o Pedido expira: o Andamento termina em “a aprovação expirou”, sem continuação, e não se decide mais",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const abaDaJuliana = await t.socket(juliana);

      t.anthropic.reply({
        toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou." } }],
      });
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);
      expect(new Date(pedido.expiresAt).getTime() - new Date(pedido.createdAt).getTime()).toBe(24 * HORA);

      // Um minuto antes, nada muda.
      t.clock.advance(24 * HORA - 60_000);
      expect((await pedidos(t, geral.id))[0]!.state).toBe("pending");

      t.clock.advance(60_000);
      const { approval } = await andamentoDoPedido(abaDaJuliana, pedido.id);
      expect(approval).toMatchObject({ state: "expired", decidedAt: t.clock.now().toISOString() });
      const fim = await andamento(abaDaJuliana, origem, (e) => e.state === "cancelled");
      expect(fim).toMatchObject({ id: pedido.executionId, state: "cancelled", reason: "a aprovação expirou" });

      expect((await aprovar(t, pedido)).status).toBe(409);
      expect((await recusar(t, pedido)).status).toBe(409);
      // Sem continuação: só o pedido de resposta que pediu a escrita, e nenhuma resposta.
      expect(respostas(t)).toHaveLength(1);
      expect((await mensagens(t, geral.id)).some((m) => m.originMessageId === origem.id)).toBe(false);
      const [aberta] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(aberta).toMatchObject({ state: "cancelled", reason: "a aprovação expirou" });
    },
    LONGO,
  );

  test(
    "se a expiração de um Pedido falha no meio, o alarme se rearma e o próximo Pedido ainda expira",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Um." } }] },
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Dois." } }] },
      );
      await enviar(t, geral.id, "@Faro avisa um");
      await pedidoPendente(t, geral.id, 1);
      t.clock.advance(HORA);
      await enviar(t, geral.id, "@Faro avisa dois");
      await pedidoPendente(t, geral.id, 2);

      // O anúncio da primeira expiração falha (uma vez): a volta da expiração para no meio.
      const publish = t.events.publish;
      let falhou = false;
      t.events.publish = (to, event) => {
        if (!falhou && event.type === "execution.updated" && event.execution.reason === "a aprovação expirou") {
          falhou = true;
          throw new Error("o anúncio caiu");
        }
        publish.call(t.events, to, event);
      };
      t.clock.advance(23 * HORA);
      await eventually("o anúncio da expiração falhar", async () => falhou);
      expect((await pedidos(t, geral.id)).map((p) => p.state)).toEqual(["expired", "pending"]);

      // A nova tentativa, um minuto depois, arma o alarme do segundo.
      t.clock.advance(60_000);
      t.clock.advance(HORA - 60_000);
      await eventually("o segundo Pedido expirar", async () => {
        t.clock.advance(1);
        return (await pedidos(t, geral.id))[1]!.state === "expired";
      });
    },
    LONGO,
  );

  test(
    "o prazo é o da Instalação (SHEARIM_APPROVAL_TTL_H), e o Pedido vencido com o servidor parado expira ao subir",
    async () => {
      expect(approvalTtlFromEnv(configFrom({}))).toBeUndefined();
      expect(approvalTtlFromEnv(configFrom({ SHEARIM_APPROVAL_TTL_H: "2" }))).toBe(2 * HORA);
      expect(approvalTtlFromEnv(configFrom({ SHEARIM_APPROVAL_TTL_H: "0.5" }))).toBe(HORA / 2);
      expect(() => approvalTtlFromEnv(configFrom({ SHEARIM_APPROVAL_TTL_H: "0" }))).toThrow(
        "SHEARIM_APPROVAL_TTL_H=0 não é um número maior que zero.",
      );
      expect(() => approvalTtlFromEnv(configFrom({ SHEARIM_APPROVAL_TTL_H: "um dia" }))).toThrow();

      const t = await testApp({ approvals: { ttlMs: 2 * HORA } });
      const { geral } = await workspace(t);
      t.anthropic.reply({ toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Oi." } }] });
      await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);
      expect(new Date(pedido.expiresAt).getTime() - new Date(pedido.createdAt).getTime()).toBe(2 * HORA);

      // O servidor para antes de vencer e volta depois.
      await t.shutdown();
      t.clock.advance(3 * HORA);
      await t.restart();
      await eventually("o Pedido expirar", async () => (await pedidos(t, geral.id))[0]!.state === "expired", 10_000);
      const [execucao] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(execucao).toMatchObject({ id: pedido.executionId, state: "cancelled", reason: "a aprovação expirou" });
    },
    LONGO,
  );

  test(
    "cancelar a mensagem enquanto ela espera aprovação cancela o Pedido, que todos veem cancelado, sem continuação",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const abaDaJuliana = await t.socket(juliana);

      t.anthropic.reply({ toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Oi." } }] });
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      // Só o autor cancela (como antes); esperando aprovação, há o que cancelar.
      const cancelar = (who = bruno) => t.as(who).post(`/api/conversations/${geral.id}/messages/${origem.id}/cancel`);
      expect((await cancelar(juliana)).status).toBe(403);
      const cancelada = await cancelar();
      expect(cancelada.status).toBe(200);
      expect(await cancelada.json()).toMatchObject([{ id: pedido.executionId, state: "cancelled", reason: null }]);

      const { approval } = await andamentoDoPedido(abaDaJuliana, pedido.id);
      expect(approval).toMatchObject({ state: "cancelled", decidedAt: t.clock.now().toISOString() });
      expect((await pedidos(t, geral.id)).map((p) => p.state)).toEqual(["cancelled"]);
      expect((await aprovar(t, pedido)).status).toBe(409);
      expect((await cancelar()).status).toBe(409);
      // Cancelado não expira depois: o prazo passa e nada muda.
      t.clock.advance(25 * HORA);
      expect((await pedidos(t, geral.id))[0]!.state).toBe("cancelled");
      expect(respostas(t)).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "o autor removido do Workspace: o Pedido dele é cancelado junto com a resposta",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      t.anthropic.reply({ toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Oi." } }] });
      await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      const brunoMe = (await (await t.as(bruno).get("/api/me")).json()) as { id: string };
      expect((await t.as(juliana).delete(`/api/members/${brunoMe.id}`)).status).toBe(204);

      expect((await pedidos(t, geral.id))[0]!.state).toBe("cancelled");
      const [execucao] = (await (
        await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)
      ).json()) as ExecutionDto[];
      expect(execucao).toMatchObject({
        id: pedido.executionId,
        state: "cancelled",
        reason: "quem escreveu saiu do Workspace",
      });
    },
    LONGO,
  );

  test(
    "o autor recebe o push “<Agente> pede sua aprovação”, e o Pedido conta no badge até ser decidido",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const abaDoBruno = await t.socket(bruno);
      const badge = async () => ((await (await t.as(bruno).get("/api/unread")).json()) as UnreadDto).total;
      expect(await badge()).toBe(0);

      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou." } }] },
        { text: "Tudo bem, não avisei." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      const push = await doBruno.next({ timeoutMs: 10_000 });
      expect(push.payload).toEqual({
        web_push: 8030,
        notification: {
          title: "#geral · Faro pede sua aprovação",
          body: "Postar em #anuncios: “A reunião mudou.”",
          navigate: expect.stringMatching(new RegExp(`/c/${geral.id}\\?m=${origem.id}$`)),
          tag: `aprovacao-${pedido.id}`,
          lang: "pt-BR",
        },
        app_badge: 1,
      });
      expect(push.urgency).toBe("high");
      expect(await badge()).toBe(1);
      expect((await abaDoBruno.next("unread.updated", { timeoutMs: 10_000 })).unread.total).toBe(1);

      // Decidido, sai do badge (antes de a resposta da continuação chegar e contar como não-lida).
      // A recusa não posta nada no #anuncios, que também contaria para o Bruno.
      expect((await recusar(t, pedido)).status).toBe(200);
      expect((await abaDoBruno.next("unread.updated", { timeoutMs: 10_000 })).unread.total).toBe(0);
      await respostaA(t, geral.id, origem);
      // Ninguém mais recebeu o push do Pedido: só o autor decide.
      expect(t.push.deliveries.filter((d) => d.tag === `aprovacao-${pedido.id}`)).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "o push de um Pedido com texto longo leva só o começo do resumo (o push service recusa corpo grande)",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const doBruno = await t.pushDevice(bruno);
      const texto = "Atenção: ".repeat(400).trim();

      t.anthropic.reply({ toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto } }] });
      await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);
      expect(pedido.summary).toBe(`Postar em #anuncios: “${texto}”`);

      const push = await doBruno.next({ timeoutMs: 10_000 });
      const { body } = (push.payload as { notification: { body: string } }).notification;
      expect(body.length).toBeLessThanOrEqual(EXCERPT_MAX);
      expect(body.startsWith("Postar em #anuncios: “Atenção: Atenção:")).toBe(true);
      expect(body.endsWith("…")).toBe(true);
    },
    LONGO,
  );

  test(
    "o Pedido expirado ou cancelado sai do badge do autor",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const badge = async () => ((await (await t.as(bruno).get("/api/unread")).json()) as UnreadDto).total;
      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Um." } }] },
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Dois." } }] },
      );
      const primeira = await enviar(t, geral.id, "@Faro avisa um");
      await pedidoPendente(t, geral.id, 1);
      await enviar(t, geral.id, "@Faro avisa dois");
      await pedidoPendente(t, geral.id, 2);
      expect(await badge()).toBe(2);

      await t.as(bruno).post(`/api/conversations/${geral.id}/messages/${primeira.id}/cancel`);
      expect(await badge()).toBe(1);
      t.clock.advance(24 * HORA);
      await eventually("o Pedido expirar", async () => (await pedidos(t, geral.id))[1]!.state === "expired", 10_000);
      expect(await badge()).toBe(0);
    },
    LONGO,
  );
});

/**
 * Uma escrita de teste (do GitHub, para o "confira no GitHub") cujo `perform` não termina sozinho:
 * `comecou` resolve quando o Shearim começa a ação, e `soltar` a termina.
 */
function escritaLenta() {
  let comecar = () => {};
  const comecou = new Promise<void>((r) => {
    comecar = r;
  });
  let soltar = (_: string) => {};
  const definition: WriteTool = {
    id: "registrar_pedido",
    title: "registrar o pedido",
    label: "registrando o pedido",
    description: "Registra o pedido no sistema de fora.",
    origin: "github",
    access: "write",
    inputSchema: { type: "object", properties: {} },
    prepare: async () => ({ action: { pedido: 1 }, summary: "Registrar o pedido 1" }),
    perform: () => {
      comecar();
      return new Promise<string>((resolve) => {
        soltar = resolve;
      });
    },
  };
  return { definition, comecou, soltar: (texto: string) => soltar(texto) };
}

/** O Workspace com a escrita lenta concedida ao Faro, e o Pedido dela pendente no #geral. */
async function pedidoDaEscritaLenta(t: TestApp, faroId: string, geralId: string, continuacao: string) {
  expect((await t.as(juliana).put(`/api/agents/${faroId}/tools/registrar_pedido`)).status).toBe(200);
  t.anthropic.reply({ toolUse: [{ name: "registrar_pedido", input: {} }] }, { text: continuacao });
  const origem = await enviar(t, geralId, "@Faro registra o pedido 1");
  return { origem, pedido: await pedidoPendente(t, geralId) };
}

describe("a escrita aprovada que não termina", () => {
  test(
    "a escrita que estoura o prazo tem resultado incerto, no Pedido e na continuação, nunca uma falha seca",
    async () => {
      const lenta = escritaLenta();
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, lenta.definition] } });
      const { faro, geral } = await workspace(t);
      const { origem, pedido } = await pedidoDaEscritaLenta(t, faro.id, geral.id, "Pode ter saído; confira.");

      const aprovado = aprovar(t, pedido);
      await lenta.comecou;
      t.clock.advance(60_000);
      const res = await aprovado;
      expect(res.status).toBe(200);
      const incerto = "não terminou em 60 s; pode ter sido feita — confira no GitHub";
      expect(await res.json()).toMatchObject({ state: "approved", result: null, failure: incerto, uncertain: true });
      expect((await pedidos(t, geral.id))[0]).toMatchObject({ failure: incerto, uncertain: true });

      expect((await respostaA(t, geral.id, origem)).body).toBe("Pode ter saído; confira.");
      const continuacao = textoDe(respostas(t)[1]!);
      expect(continuacao).toContain(`Bruno aprovou, mas o resultado é incerto: ${incerto}`);
      expect(continuacao).not.toContain("a ação falhou");
    },
    LONGO,
  );

  test(
    "o servidor reinicia no meio da ação aprovada: ao subir, o Pedido fica com resultado incerto e a resposta continua, sem repetir a escrita",
    async () => {
      const lenta = escritaLenta();
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, lenta.definition] } });
      const { faro, geral } = await workspace(t);
      const { origem, pedido } = await pedidoDaEscritaLenta(t, faro.id, geral.id, "Pode ter saído; confira.");
      let acoes = 0;
      const perform = lenta.definition.perform;
      lenta.definition.perform = (...args) => {
        acoes++;
        return perform(...args);
      };

      // O servidor cai com a ação em curso: a aprovação já foi gravada, o resultado não.
      void aprovar(t, pedido).catch(() => {});
      await lenta.comecou;
      await t.restart();

      const incerto = "o servidor reiniciou durante a ação; pode ter sido feita — confira no GitHub";
      expect((await respostaA(t, geral.id, origem)).body).toBe("Pode ter saído; confira.");
      expect((await pedidos(t, geral.id))[0]).toMatchObject({
        state: "approved",
        result: null,
        failure: incerto,
        uncertain: true,
      });
      expect(textoDe(respostas(t)[1]!)).toContain(`Bruno aprovou, mas o resultado é incerto: ${incerto}`);
      // A escrita não foi repetida na subida.
      expect(acoes).toBe(1);
      expect(
        (await (await t.as(juliana).get(`/api/conversations/${geral.id}/executions`)).json()) as ExecutionDto[],
      ).toEqual([]);
    },
    LONGO,
  );

  test(
    "o servidor cai entre a decisão e a continuação: ao subir, a continuação sai (na recusa e na aprovação já feita)",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Um." } }] },
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "Dois." } }] },
      );
      const primeira = await enviar(t, geral.id, "@Faro avisa um");
      const recusado = await pedidoPendente(t, geral.id, 1);
      const segunda = await enviar(t, geral.id, "@Faro avisa dois");
      const aprovado = await pedidoPendente(t, geral.id, 2);

      // A queda entre gravar a decisão (e o resultado da ação) e enfileirar a continuação não tem
      // como ser provocada pela borda: a decisão gravada sem continuação é posta no banco.
      await t.shutdown();
      await t.db
        .update(schema.approvalRequests)
        .set({ state: "rejected", decidedAt: t.clock.now() })
        .where(eq(schema.approvalRequests.id, recusado.id));
      await t.db
        .update(schema.approvalRequests)
        .set({ state: "approved", decidedAt: t.clock.now(), result: "mensagem postada em #anuncios" })
        .where(eq(schema.approvalRequests.id, aprovado.id));
      t.anthropic.reply({ text: "Tudo bem, não avisei." }, { text: "Avisei." });
      await t.restart();

      const respostasNoGeral = [await respostaA(t, geral.id, primeira), await respostaA(t, geral.id, segunda)];
      expect(respostasNoGeral.map((m) => m.body).sort()).toEqual(["Avisei.", "Tudo bem, não avisei."]);
      const continuacoes = respostas(t).slice(2).map(textoDe).join("\n");
      expect(continuacoes).toContain("Bruno recusou, sem dar motivo");
      expect(continuacoes).toContain("Bruno aprovou, e o Shearim fez: mensagem postada em #anuncios");
    },
    LONGO,
  );
});

/**
 * Uma Ferramenta de leitura no catálogo cujo `id`, depois de `armar`, lança uma vez: a próxima
 * leitura do catálogo (a conferência do alcance na aprovação) cai, como num erro do banco.
 */
function catalogoQueCai() {
  let armada = false;
  const definition = {
    title: "consultar o arquivo",
    label: "consultando o arquivo",
    description: "Consulta o arquivo morto.",
    origin: "workspace",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    run: async () => "",
  } as unknown as ToolDefinition;
  Object.defineProperty(definition, "id", {
    get() {
      if (!armada) return "consultar_arquivo";
      armada = false;
      throw new Error("a conexão com o banco caiu");
    },
  });
  return {
    definition,
    armar: () => {
      armada = true;
    },
  };
}

describe("a decisão que não sai como o esperado", () => {
  test(
    "um erro inesperado depois de aprovar não prende o Pedido: ele fica com resultado incerto e a resposta continua",
    async () => {
      const queda = catalogoQueCai();
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, queda.definition] } });
      const { geral } = await workspace(t);
      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou." } }] },
        { text: "Pode ter saído; confira." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      queda.armar();
      const aprovado = await aprovar(t, pedido);
      expect(aprovado.status).toBe(200);
      const incerto = "erro inesperado ao executar a ação; pode ter sido feita — confira na conversa";
      expect(await aprovado.json()).toMatchObject({
        state: "approved",
        result: null,
        failure: incerto,
        uncertain: true,
      });

      expect((await respostaA(t, geral.id, origem)).body).toBe("Pode ter saído; confira.");
      expect(textoDe(respostas(t)[1]!)).toContain(`Bruno aprovou, mas o resultado é incerto: ${incerto}`);
    },
    LONGO,
  );

  test(
    "na recusa, se o anúncio cai, a resposta continua mesmo assim",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      t.anthropic.reply(
        { toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou." } }] },
        { text: "Tudo bem, não avisei." },
      );
      const origem = await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      const publish = t.events.publish;
      let falhou = false;
      t.events.publish = (to, event) => {
        if (!falhou && event.type === "approval.updated") {
          falhou = true;
          throw new Error("o anúncio caiu");
        }
        publish.call(t.events, to, event);
      };
      expect((await recusar(t, pedido)).status).toBe(500);
      expect(falhou).toBe(true);

      expect((await respostaA(t, geral.id, origem)).body).toBe("Tudo bem, não avisei.");
      expect(textoDe(respostas(t)[1]!)).toContain("Bruno recusou, sem dar motivo");
    },
    LONGO,
  );

  test(
    "o Pedido vencido que a varredura ainda não expirou não se aprova nem se recusa",
    async () => {
      const t = await testApp();
      const { geral, anuncios } = await workspace(t);
      t.anthropic.reply({
        toolUse: [{ name: "postar_mensagem", input: { conversa: "#anuncios", texto: "A reunião mudou." } }],
      });
      await enviar(t, geral.id, "@Faro avisa no #anuncios");
      const pedido = await pedidoPendente(t, geral.id);

      // O prazo passou sem a varredura (que falhou, atrasou ou estava com o servidor fora): o alarme
      // continua armado para o prazo antigo, e o Pedido segue pendente no banco.
      await t.db
        .update(schema.approvalRequests)
        .set({ expiresAt: new Date(t.clock.now().getTime() - 1) })
        .where(eq(schema.approvalRequests.id, pedido.id));

      const aprovado = await aprovar(t, pedido);
      expect(aprovado.status).toBe(409);
      expect(await aprovado.json()).toEqual({ error: "expired" });
      const recusado = await recusar(t, pedido);
      expect(recusado.status).toBe(409);
      expect(await recusado.json()).toEqual({ error: "expired" });
      expect((await mensagens(t, anuncios.id)).some((m) => m.author.kind === "agent")).toBe(false);
      expect(respostas(t)).toHaveLength(1);
    },
    LONGO,
  );

  test(
    "aprovado, todos já veem a decisão enquanto a ação roda, sem esperar o fim dela",
    async () => {
      const lenta = escritaLenta();
      const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, lenta.definition] } });
      const { faro, geral } = await workspace(t);
      const { origem, pedido } = await pedidoDaEscritaLenta(t, faro.id, geral.id, "Registrei.");
      const abaDaJuliana = await t.socket(juliana);

      const aprovado = aprovar(t, pedido);
      await lenta.comecou;
      const { approval } = await andamentoDoPedido(abaDaJuliana, pedido.id);
      expect(approval).toMatchObject({ state: "approved", result: null, failure: null });

      lenta.soltar("pedido 1 registrado");
      expect(await (await aprovado).json()).toMatchObject({ state: "approved", result: "pedido 1 registrado" });
      expect((await andamentoDoPedido(abaDaJuliana, pedido.id)).approval.result).toBe("pedido 1 registrado");
      expect((await respostaA(t, geral.id, origem)).body).toBe("Registrei.");
    },
    LONGO,
  );
});
