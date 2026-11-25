/**
 * Ler o Workspace com alcance (#47, Spec #44): buscar mensagens, abrir uma conversa ou Thread,
 * listar Canais e listar Membros, pela Chave, pela borda do servidor.
 *
 * O alcance é a interseção do que vê cada Membro que vê a conversa da resposta, o autor incluído:
 * - num Canal público, todo Membro vê a conversa, então só os Canais públicos entram;
 * - numa DM só entre o autor e o Agente, entra tudo o que o autor vê;
 * - numa DM em grupo (ou num Canal privado), só o que todos os participantes veem;
 * - nunca uma conversa que o autor não vê, mesmo que o Agente participe dela.
 * O que está fora do alcance não aparece nem pelo nome, nem no resultado, nem no Andamento.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, ChannelDto, DmDto, MeDto, MessageDto } from "@shearim/contracts";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const ana = { id: "1002", login: "ana@exemplo.com", name: "Ana" };
const bruno = { id: "1003", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "1004", login: "carla@exemplo.com", name: "Carla" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;

const LEITURA = ["buscar_mensagens", "abrir_conversa", "listar_canais", "listar_membros"];

/**
 * Juliana vira Admin e grava a Chave; Ana, Bruno e Carla entram e estão no #geral. Ana cria o
 * #diretoria (privado, só ela). O Faro tem as Ferramentas de leitura do Workspace.
 */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const me: Record<string, MeDto> = {};
  for (const p of [ana, bruno, carla]) me[p.name] = await t.addMember(p, { by: juliana });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", {
      name: "Faro",
      photo: null,
      description: "Comercial: preços e propostas.",
      instructions: "Você é o Faro, do comercial.",
      model: "claude-sonnet-5-5",
    })
  ).json();
  for (const tool of LEITURA) {
    expect((await t.as(juliana).put(`/api/agents/${faro.id}/tools/${tool}`)).status).toBe(200);
  }
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  for (const p of [ana, bruno, carla]) await t.as(p).post(`/api/channels/${geral!.id}/join`);
  const diretoria: ChannelDto = await (
    await t.as(ana).post("/api/channels", { name: "diretoria", kind: "private" })
  ).json();
  return { me, faro, geral: geral!, diretoria };
}

/** Põe o Faro no Canal (depois das mensagens de semente: com ele lá, a Articuladora daria Desfecho). */
async function comFaro(t: TestApp, channelId: string, faro: AgentDto) {
  expect((await t.as(juliana).post(`/api/channels/${channelId}/agents`, { agentId: faro.id })).status).toBe(200);
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

async function dm(t: TestApp, who: Person, input: { memberIds: string[]; agentId?: string }): Promise<DmDto> {
  const res = await t.as(who).post("/api/dms", input);
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, who: Person, conversationId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (await t.as(who).get(`/api/conversations/${conversationId}/messages`)).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    10_000,
  );
}

/** As chamadas de resposta (sem o roteamento da Articuladora) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);

/**
 * `who` pede ao Faro, em `conversationId`, e o modelo chama `ferramenta` com `input`. Devolve o
 * resultado que voltou ao modelo e todo Andamento da execução que chegou à aba de `who`.
 */
async function usar(
  t: TestApp,
  who: Person,
  conversationId: string,
  ferramenta: string,
  input: Record<string, unknown>,
  body = "@Faro dá uma olhada?",
  threadRootId?: string,
) {
  const aba = await t.socket(who);
  const antes = respostas(t).length;
  t.anthropic.reply({ toolUse: [{ id: "toolu_1", name: ferramenta, input }] }, { text: "Pronto." });
  const origem = await enviar(t, who, conversationId, body, threadRootId);
  await respostaA(t, who, conversationId, origem);
  const [resultado] = toolResults(respostas(t)[antes + 1]!.body);
  const andamento = await eventually("o Andamento terminar", async () => {
    const vistos = aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
    return vistos.some((e) => e.state === "done") ? vistos : undefined;
  });
  // O passo da Ferramenta passou pelo Andamento (é nele que um nome fora do alcance vazaria).
  expect(andamento.some((e) => e.tools.some((f) => f.tool === ferramenta))).toBe(true);
  await aba.close();
  return { resultado: resultado!, andamento: JSON.stringify(andamento), origem };
}

describe("buscar mensagens", () => {
  test(
    "Ana participa de #diretoria; num Canal público, a busca dela não traz #diretoria, nem o nome dele, nem no resultado nem no Andamento",
    async () => {
      const t = await testApp();
      const { faro, geral, diretoria } = await workspace(t);
      await enviar(t, bruno, geral.id, "O orçamento do evento fechou em 10 mil.");
      await enviar(t, ana, diretoria.id, "Orçamento de 2027 aprovado pela diretoria.");
      await comFaro(t, geral.id, faro);

      const { resultado, andamento } = await usar(t, ana, geral.id, "buscar_mensagens", { texto: "orçamento" });

      expect(resultado.is_error).toBeFalsy();
      expect(resultado.content).toContain("O orçamento do evento fechou em 10 mil.");
      expect(resultado.content).toContain("#geral");
      expect(resultado.content).not.toContain("2027");
      expect(resultado.content).not.toContain("diretoria");
      expect(andamento).not.toContain("diretoria");

      // Nem pedindo #diretoria pelo nome: a resposta é a mesma de um Canal que não existe.
      const pedido = await usar(t, ana, geral.id, "buscar_mensagens", { texto: "orçamento", conversa: "#diretoria" });
      const inexistente = await usar(t, ana, geral.id, "buscar_mensagens", { texto: "orçamento", conversa: "#nada" });
      expect(pedido.resultado.content).not.toContain("2027");
      expect(pedido.resultado.content).toBe(inexistente.resultado.content);
      expect(pedido.andamento).not.toContain("diretoria");
    },
    LONGO,
  );
});

describe("o rótulo no Andamento", () => {
  test(
    "o Andamento diz onde a Ferramenta busca ou lê quando a conversa está no alcance; fora dele, o rótulo é genérico",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      const raiz = await enviar(t, bruno, geral.id, "Quem leva o estande?");
      await comFaro(t, geral.id, faro);
      const rotulo = (andamento: string) =>
        JSON.parse(andamento).flatMap((e: { tools: { label: string }[] }) => e.tools.map((f) => f.label));

      const busca = await usar(t, ana, geral.id, "buscar_mensagens", { texto: "estande", conversa: "#geral" });
      expect(rotulo(busca.andamento)).toContain("buscando em #geral");
      const leitura = await usar(t, ana, geral.id, "abrir_conversa", { conversa: "geral" });
      expect(rotulo(leitura.andamento)).toContain("lendo #geral");
      const thread = await usar(t, ana, geral.id, "abrir_conversa", { thread: raiz.id });
      expect(rotulo(thread.andamento)).toContain("lendo uma Thread em #geral");

      // #diretoria existe, mas está fora do alcance de quem vê o #geral: nem o nome aparece.
      const fora = await usar(t, ana, geral.id, "buscar_mensagens", { texto: "orçamento", conversa: "#diretoria" });
      expect(rotulo(fora.andamento)).toContain("buscando mensagens");
      const aberta = await usar(t, ana, geral.id, "abrir_conversa", { conversa: "#diretoria" });
      expect(rotulo(aberta.andamento)).toContain("lendo a conversa");
      expect(fora.andamento + aberta.andamento).not.toContain("diretoria");
    },
    LONGO,
  );
});

describe("o alcance pela conversa", () => {
  test(
    "numa DM só entre Ana e o Agente, a busca alcança tudo o que Ana vê",
    async () => {
      const t = await testApp();
      const { me, faro, geral, diretoria } = await workspace(t);
      await enviar(t, bruno, geral.id, "O orçamento do evento fechou em 10 mil.");
      await enviar(t, ana, diretoria.id, "Orçamento de 2027 aprovado pela diretoria.");
      const anaEBruno = await dm(t, ana, { memberIds: [me.Bruno!.id] });
      await enviar(t, bruno, anaEBruno.id, "Ana, o orçamento da viagem é teu.");
      const comFaro = await dm(t, ana, { memberIds: [], agentId: faro.id });

      // Na DM com o Agente, toda mensagem chama o Faro (sem Menção).
      const { resultado } = await usar(
        t,
        ana,
        comFaro.id,
        "buscar_mensagens",
        { texto: "orçamento" },
        "acha o orçamento?",
      );

      expect(resultado.is_error).toBeFalsy();
      expect(resultado.content).toContain("O orçamento do evento fechou em 10 mil.");
      expect(resultado.content).toContain("Orçamento de 2027 aprovado pela diretoria.");
      expect(resultado.content).toContain("#diretoria");
      expect(resultado.content).toContain("Ana, o orçamento da viagem é teu.");
      expect(resultado.content).toContain(`DM com Ana, Bruno [id ${anaEBruno.id}]`);
    },
    LONGO,
  );

  test(
    "numa DM em grupo, a busca alcança só o que todos os participantes veem",
    async () => {
      const t = await testApp();
      const { me, geral, diretoria } = await workspace(t);
      await enviar(t, bruno, geral.id, "O orçamento do evento fechou em 10 mil.");
      await enviar(t, ana, diretoria.id, "Orçamento de 2027 aprovado pela diretoria.");
      const comite: ChannelDto = await (
        await t.as(ana).post("/api/channels", { name: "comite", kind: "private" })
      ).json();
      for (const p of [me.Bruno!, me.Carla!])
        await t.as(ana).post(`/api/channels/${comite.id}/participants`, { memberId: p.id });
      await enviar(t, carla, comite.id, "Orçamento do comitê: 3 mil.");
      const anaEBruno = await dm(t, ana, { memberIds: [me.Bruno!.id] });
      await enviar(t, bruno, anaEBruno.id, "Ana, o orçamento da viagem é teu.");
      const grupo = await dm(t, ana, { memberIds: [me.Bruno!.id, me.Carla!.id] });
      await enviar(t, carla, grupo.id, "Quem fecha o orçamento do jantar?");

      const { resultado, andamento } = await usar(t, ana, grupo.id, "buscar_mensagens", { texto: "orçamento" });

      expect(resultado.content).toContain("O orçamento do evento fechou em 10 mil.");
      expect(resultado.content).toContain("Orçamento do comitê: 3 mil.");
      expect(resultado.content).toContain("Quem fecha o orçamento do jantar?");
      // #diretoria é só de Ana, e a DM de Ana com Bruno não é de Carla.
      expect(resultado.content).not.toContain("2027");
      expect(resultado.content).not.toContain("diretoria");
      expect(resultado.content).not.toContain("viagem");
      expect(resultado.content).not.toContain(anaEBruno.id);
      expect(andamento).not.toContain("diretoria");
    },
    LONGO,
  );

  test(
    "a busca nunca alcança uma conversa que o autor não vê, mesmo que o Agente participe dela",
    async () => {
      const t = await testApp();
      const { faro } = await workspace(t);
      const financeiro: ChannelDto = await (
        await t.as(bruno).post("/api/channels", { name: "financeiro", kind: "private" })
      ).json();
      await enviar(t, bruno, financeiro.id, "Orçamento da folha: sigiloso.");
      expect((await t.as(bruno).post(`/api/channels/${financeiro.id}/agents`, { agentId: faro.id })).status).toBe(200);
      const comFaro = await dm(t, ana, { memberIds: [], agentId: faro.id });

      const busca = await usar(t, ana, comFaro.id, "buscar_mensagens", { texto: "orçamento" }, "acha o orçamento?");
      expect(busca.resultado.content).not.toContain("folha");
      expect(busca.resultado.content).not.toContain("financeiro");

      const pedida = await usar(
        t,
        ana,
        comFaro.id,
        "buscar_mensagens",
        { texto: "folha", conversa: financeiro.id },
        "e no financeiro?",
      );
      expect(pedida.resultado).toMatchObject({ is_error: true });
      expect(pedida.resultado.content).not.toContain("financeiro");
      expect(pedida.andamento).not.toContain("financeiro");
    },
    LONGO,
  );
});

describe("abrir uma conversa ou Thread", () => {
  test(
    "abrir a conversa devolve as mensagens anteriores às últimas N, que o Agente já recebeu; a Thread, a raiz e as respostas",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      expect((await t.as(juliana).patch(`/api/channel-settings/${geral.id}`, { recentMessages: 2 })).status).toBe(200);
      await enviar(t, bruno, geral.id, "m1: a feira é em março.");
      const m2 = await enviar(t, carla, geral.id, "m2: quem leva o estande?");
      await enviar(t, bruno, geral.id, "t1: eu levo.", m2.id);
      await enviar(t, carla, geral.id, "t2: fechado.", m2.id);
      const m3 = await enviar(t, bruno, geral.id, "m3: e o hotel?");
      await enviar(t, carla, geral.id, "m4: já reservei.");
      await enviar(t, bruno, geral.id, "m5: ótimo.");
      await comFaro(t, geral.id, faro);

      const conversa = await usar(
        t,
        ana,
        geral.id,
        "abrir_conversa",
        { conversa: "#geral" },
        "@Faro o que falaram antes?",
      );
      expect(conversa.resultado.is_error).toBeFalsy();
      const texto = conversa.resultado.content;
      expect(texto).toContain("m1: a feira é em março.");
      expect(texto).toContain("m2: quem leva o estande?");
      expect(texto).toContain("m3: e o hotel?");
      expect(texto.indexOf("m1:")).toBeLessThan(texto.indexOf("m3:"));
      // As últimas N (m4, m5) já estão no contexto; as respostas da Thread não são do fluxo principal.
      expect(texto).not.toContain("m4:");
      expect(texto).not.toContain("m5:");
      expect(texto).not.toContain("t1:");
      expect(texto).toContain(`[mensagem ${m2.id}]`);
      expect(texto).toMatch(/m2: quem leva o estande\?.*\n?.*2 respostas/);

      const thread = await usar(t, ana, geral.id, "abrir_conversa", { thread: m2.id }, "@Faro e o estande?");
      expect(thread.resultado.content).toContain("m2: quem leva o estande?");
      expect(thread.resultado.content).toContain("t1: eu levo.");
      expect(thread.resultado.content).toContain("t2: fechado.");
      expect(thread.resultado.content).not.toContain("m1:");

      // Mais para trás, a partir de uma mensagem.
      const antes = await usar(
        t,
        ana,
        geral.id,
        "abrir_conversa",
        { conversa: "#geral", antes_de: m3.id },
        "@Faro e antes?",
      );
      expect(antes.resultado.content).toContain("m1:");
      expect(antes.resultado.content).toContain("m2:");
      expect(antes.resultado.content).not.toContain("m3:");
    },
    LONGO,
  );

  test(
    "na Thread em que o Agente foi chamado, abrir a Thread devolve as respostas anteriores às últimas N dela",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      expect((await t.as(juliana).patch(`/api/channel-settings/${geral.id}`, { recentMessages: 2 })).status).toBe(200);
      const raiz = await enviar(t, bruno, geral.id, "raiz: a feira.");
      for (const r of ["r1", "r2", "r3", "r4"]) await enviar(t, carla, geral.id, `${r}: resposta.`, raiz.id);
      await comFaro(t, geral.id, faro);

      const { resultado } = await usar(
        t,
        ana,
        geral.id,
        "abrir_conversa",
        { thread: raiz.id },
        "@Faro resume?",
        raiz.id,
      );
      expect(resultado.content).toContain("r1: resposta.");
      expect(resultado.content).toContain("r2: resposta.");
      expect(resultado.content).not.toContain("r3:");
      expect(resultado.content).not.toContain("r4:");
    },
    LONGO,
  );

  test(
    "abrir uma conversa ou Thread fora do alcance falha como se ela não existisse, sem o nome",
    async () => {
      const t = await testApp();
      const { faro, geral, diretoria } = await workspace(t);
      const segredo = await enviar(t, ana, diretoria.id, "Orçamento de 2027 aprovado pela diretoria.");
      await comFaro(t, geral.id, faro);

      const pedidos = [
        { conversa: "#diretoria" },
        { conversa: diretoria.id },
        { thread: segredo.id },
        { conversa: "#nada" },
        { thread: crypto.randomUUID() },
      ];
      const vistos = [];
      for (const input of pedidos) vistos.push(await usar(t, ana, geral.id, "abrir_conversa", input));
      for (const { resultado, andamento } of vistos) {
        expect(resultado.is_error).toBe(true);
        expect(resultado.content).not.toContain("2027");
        expect(resultado.content).not.toContain("diretoria");
        expect(andamento).not.toContain("diretoria");
      }
      // Fora do alcance e inexistente dão a mesma resposta.
      expect(new Set(vistos.map((v) => v.resultado.content)).size).toBe(1);
    },
    LONGO,
  );
});

describe("listar Canais e listar Membros", () => {
  test(
    "listar Canais segue o alcance: de um Canal público, só os públicos; da DM com o Agente, também os privados do autor",
    async () => {
      const t = await testApp();
      const { faro, geral } = await workspace(t);
      await t.as(juliana).post("/api/channels", { name: "produto", kind: "public" });
      await t.as(bruno).post("/api/channels", { name: "financeiro", kind: "private" });
      await comFaro(t, geral.id, faro);

      const publico = await usar(t, ana, geral.id, "listar_canais", {});
      expect(publico.resultado.content).toContain("#geral (público)");
      expect(publico.resultado.content).toContain("#produto (público)");
      expect(publico.resultado.content).not.toContain("diretoria");
      expect(publico.resultado.content).not.toContain("financeiro");
      expect(publico.andamento).not.toContain("diretoria");

      const comFaroDm = await dm(t, ana, { memberIds: [], agentId: faro.id });
      const naDm = await usar(t, ana, comFaroDm.id, "listar_canais", {}, "quais Canais existem?");
      expect(naDm.resultado.content).toContain("#geral (público)");
      expect(naDm.resultado.content).toContain("#diretoria (privado)");
      expect(naDm.resultado.content).not.toContain("financeiro");
    },
    LONGO,
  );

  test(
    "listar Membros traz todo Membro do Workspace; de uma conversa, só se ela está no alcance",
    async () => {
      const t = await testApp();
      const { me, faro, geral, diretoria } = await workspace(t);
      await t.as(ana).post(`/api/channels/${diretoria.id}/participants`, { memberId: me.Bruno!.id });
      await comFaro(t, geral.id, faro);

      const todos = await usar(t, carla, geral.id, "listar_membros", {});
      for (const nome of ["Juliana (@juliana), Admin", "Ana (@ana)", "Bruno (@bruno)", "Carla (@carla)"]) {
        expect(todos.resultado.content).toContain(nome);
      }
      expect(todos.resultado.content).not.toContain("diretoria");

      const fora = await usar(t, ana, geral.id, "listar_membros", { conversa: "#diretoria" });
      expect(fora.resultado.is_error).toBe(true);
      expect(fora.resultado.content).not.toContain("diretoria");
      expect(fora.resultado.content).not.toContain("Bruno");
      expect(fora.andamento).not.toContain("diretoria");

      const comFaroDm = await dm(t, ana, { memberIds: [], agentId: faro.id });
      const dentro = await usar(
        t,
        ana,
        comFaroDm.id,
        "listar_membros",
        { conversa: "#diretoria" },
        "quem está na diretoria?",
      );
      expect(dentro.resultado.is_error).toBeFalsy();
      expect(dentro.resultado.content).toContain("Ana (@ana)");
      expect(dentro.resultado.content).toContain("Bruno (@bruno)");
      expect(dentro.resultado.content).not.toContain("Carla");
    },
    LONGO,
  );
});
