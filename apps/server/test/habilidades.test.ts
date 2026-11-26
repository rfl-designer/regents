/**
 * Habilidades (spec #74, ticket #75): o Admin escreve uma Habilidade (nome, descrição e corpo em
 * markdown) e a ativa em Agentes, a Articuladora inclusive. O Agente recebe no contexto só o
 * catálogo (uma linha com o nome e a descrição de cada Habilidade ativa, logo depois das
 * instruções dele) e carrega o corpo pela Ferramenta automática "carregar Habilidade" quando a
 * tarefa pede, à vista no Andamento. Pela Chave e pela Conta.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDto, AgentSkillDto, ChannelDto, ExecutionDto, MessageDto, SkillDto } from "@shearim/contracts";
import type { ToolDefinition } from "../src/tools/port";
import { WORKSPACE_TOOLS } from "../src/tools/workspace";
import { toolResults } from "./fakes/messages-api";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const CHAVE = "sk-ant-api03-chave-do-workspace";
const LONGO = 120_000;
const CARREGAR = "carregar_habilidade";

const CARROSSEL = {
  name: "Criar carrossel",
  description: "Use quando pedirem um carrossel para o Instagram.",
  body: "# Criar carrossel\n\n1. Comece com um gancho.\n2. Uma ideia por slide.\n3. Feche com uma chamada.",
};

/** Juliana (Admin) grava a Chave e cria o Social no #geral; Bruno (Membro) entra no #geral. */
async function workspace(t: TestApp) {
  await t.as(juliana).get("/api/me");
  await t.as(juliana).put("/api/workspace-key", { apiKey: CHAVE });
  const social = await novoAgente(t, "Social");
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: social.id });
  await t.addMember(bruno, { by: juliana });
  await t.as(bruno).post(`/api/channels/${geral!.id}/join`);
  return { social, geral: geral! };
}

async function novoAgente(t: TestApp, name: string, extra: Record<string, unknown> = {}): Promise<AgentDto> {
  const res = await t.as(juliana).post("/api/agents", {
    name,
    photo: null,
    description: `O ${name}.`,
    instructions: `Você é o ${name}.`,
    model: "claude-sonnet-5-5",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function criar(t: TestApp, input: Record<string, unknown> = CARROSSEL): Promise<SkillDto> {
  const res = await t.as(juliana).post("/api/skills", input);
  expect(res.status).toBe(201);
  return res.json();
}

async function ativar(t: TestApp, agentId: string, skillId: string) {
  expect((await t.as(juliana).put(`/api/agents/${agentId}/skills/${skillId}`)).status).toBe(200);
}

async function enviar(t: TestApp, conversationId: string, body: string, who: Person = bruno): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

async function respostaA(t: TestApp, conversationId: string, origem: MessageDto) {
  return eventually(
    "a resposta sair",
    async () => {
      const lista: MessageDto[] = await (
        await t.as(juliana).get(`/api/conversations/${conversationId}/messages`)
      ).json();
      return lista.find((m) => m.originMessageId === origem.id);
    },
    20_000,
  );
}

/** As chamadas de resposta (sem o roteamento nem a extração) que chegaram à Messages API falsa. */
const respostas = (t: TestApp) => t.anthropic.requests.filter((r) => !r.body.output_config);
const systemDe = (r: ReturnType<typeof respostas>[number]) => {
  const { system } = r.body;
  return typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
};
const ferramentasDe = (r: ReturnType<typeof respostas>[number]) =>
  ((r.body.tools ?? []) as { name: string }[]).map((f) => f.name);

describe("o Admin escreve Habilidades", () => {
  test("o Admin cria a Habilidade Criar carrossel com descrição e corpo, e ela aparece na lista", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const criada = await criar(t);

    expect(criada).toMatchObject({ ...CARROSSEL, origin: "written", agents: [] });
    const lista: SkillDto[] = await (await t.as(juliana).get("/api/skills")).json();
    expect(lista).toEqual([criada]);
    expect(await (await t.as(juliana).get(`/api/skills/${criada.id}`)).json()).toEqual(criada);
  });

  test("um segundo Criar carrossel, mesmo em outra caixa, é recusado com o motivo; sem descrição também", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await criar(t);

    const repetida = await t.as(juliana).post("/api/skills", { ...CARROSSEL, name: "CRIAR Carrossel" });
    expect(repetida.status).toBe(409);
    expect(await repetida.json()).toEqual({
      error: "name_taken",
      message: "Já existe uma Habilidade chamada CRIAR Carrossel.",
    });

    const semDescricao = await t
      .as(juliana)
      .post("/api/skills", { ...CARROSSEL, name: "Criar Reels", description: " " });
    expect(semDescricao.status).toBe(400);
    expect(await semDescricao.json()).toEqual({
      error: "invalid_input",
      message: "A descrição diz quando usar a Habilidade: ela é obrigatória.",
    });

    const outra = await criar(t, { ...CARROSSEL, name: "Criar Reels" });
    const renomeada = await t.as(juliana).patch(`/api/skills/${outra.id}`, { name: "criar carrossel" });
    expect(renomeada.status).toBe(409);
    expect((await t.as(juliana).patch(`/api/skills/${outra.id}`, { description: "" })).status).toBe(400);
    const lista: SkillDto[] = await (await t.as(juliana).get("/api/skills")).json();
    expect(lista.map((s) => s.name)).toEqual(["Criar carrossel", "Criar Reels"]);
  });

  test("um Membro que não é Admin recebe 403 ao criar, editar, ativar, desativar ou apagar uma Habilidade", async () => {
    const t = await testApp();
    const { social } = await workspace(t);
    const criada = await criar(t);
    const membro = t.as(bruno);

    expect((await membro.post("/api/skills", { ...CARROSSEL, name: "Outra" })).status).toBe(403);
    expect((await membro.patch(`/api/skills/${criada.id}`, { body: "Mudei." })).status).toBe(403);
    expect((await membro.put(`/api/agents/${social.id}/skills/${criada.id}`)).status).toBe(403);
    expect((await membro.delete(`/api/agents/${social.id}/skills/${criada.id}`)).status).toBe(403);
    expect((await membro.delete(`/api/skills/${criada.id}`)).status).toBe(403);

    // Nada mudou.
    expect(await (await t.as(juliana).get(`/api/skills/${criada.id}`)).json()).toEqual(criada);
  });
});

describe("o catálogo no contexto", () => {
  test(
    "ativada no Social, a próxima resposta dele recebe, logo depois das instruções, a linha com o nome e a descrição, e não o corpo",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      const lince = await novoAgente(t, "Lince");
      await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: lince.id });
      const carrossel = await criar(t);
      await ativar(t, social.id, carrossel.id);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@social faz um carrossel?"));
      const [pedido] = respostas(t);
      const system = systemDe(pedido!);
      expect(system).toContain("## Suas instruções\n\nVocê é o Social.\n\n## Suas Habilidades\n\n");
      expect(system).toContain("- Criar carrossel: Use quando pedirem um carrossel para o Instagram.");
      expect(system).toContain("carregar Habilidade");
      expect(system).not.toContain("Uma ideia por slide");
      expect(ferramentasDe(pedido!)).toContain(CARREGAR);
      expect(t.anthropic.requests.flatMap((r) => JSON.stringify(r.body))).not.toContain("Uma ideia por slide");
    },
    LONGO,
  );

  test(
    "um Agente sem Habilidade ativa não recebe a camada, e carregar Habilidade não é oferecida a ele",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      const lince = await novoAgente(t, "Lince");
      await t.as(juliana).post(`/api/channels/${geral.id}/agents`, { agentId: lince.id });
      await ativar(t, social.id, (await criar(t)).id);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@lince oi"));
      const [pedido] = respostas(t);
      expect(systemDe(pedido!)).not.toContain("Habilidade");
      expect(ferramentasDe(pedido!)).not.toContain(CARREGAR);
    },
    LONGO,
  );
});

/**
 * Bruno pede ao Social, e o modelo chama "carregar Habilidade" com cada nome de `nomes`, um por
 * turno, e responde. Devolve os resultados que voltaram ao modelo e os passos do Andamento.
 */
async function carregar(t: TestApp, conversationId: string, nomes: string[]) {
  const aba = await t.socket(bruno);
  const antes = respostas(t).length;
  t.anthropic.reply(
    ...nomes.map((nome, i) => ({ toolUse: [{ id: `toolu_${i + 1}`, name: CARREGAR, input: { nome } }] })),
    { text: "Pronto." },
  );
  const origem = await enviar(t, conversationId, "@social faz um carrossel?");
  const resposta = await respostaA(t, conversationId, origem);
  const resultados = nomes.map((_, i) => toolResults(respostas(t)[antes + i + 1]!.body)[0]!);
  const andamento = await terminou(aba, origem);
  await aba.close();
  const passos = andamento.at(-1)!.tools.filter((f) => f.tool === CARREGAR);
  return { resposta, resultados, passos, andamento };
}

/** Os Andamentos da execução de `origem` que chegaram à aba, até o `done`. */
function terminou(aba: Awaited<ReturnType<TestApp["socket"]>>, origem: MessageDto) {
  return eventually("o Andamento terminar", async () => {
    const vistos: ExecutionDto[] = aba
      .received()
      .flatMap((e) =>
        e.type === "execution.updated" && e.execution.originMessageId === origem.id ? [e.execution] : [],
      );
    return vistos.some((e) => e.state === "done") ? vistos : undefined;
  });
}

describe("carregar Habilidade", () => {
  test(
    'pela Chave, o Social carrega Criar carrossel e recebe o corpo; o Andamento mostra "carregando a Habilidade Criar carrossel"',
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await ativar(t, social.id, (await criar(t)).id);

      const { resposta, resultados, passos, andamento } = await carregar(t, geral.id, ["criar carrossel"]);

      expect(resultados[0]!.is_error).toBeFalsy();
      expect(resultados[0]!.content).toContain("2. Uma ideia por slide.");
      expect(passos).toMatchObject([{ label: "carregando a Habilidade Criar carrossel", state: "done" }]);
      expect(andamento.map((e) => e.state)).not.toContain("awaiting_approval");
      expect(resposta.body).toBe("Pronto.");
    },
    LONGO,
  );

  test(
    "um nome que não é de uma Habilidade ativa no Social vira falha com motivo no Andamento, e a resposta segue",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await ativar(t, social.id, (await criar(t)).id);
      // Existe, mas não está ativa no Social.
      await criar(t, { ...CARROSSEL, name: "Criar Reels", body: "Reels: vertical." });

      const { resposta, resultados, passos } = await carregar(t, geral.id, ["Criar Reels", "Fazer bolo"]);

      for (const r of resultados) expect(r.is_error).toBe(true);
      expect(resultados[0]!.content).toContain("Criar Reels não é uma Habilidade ativa sua");
      expect(resultados[0]!.content).not.toContain("vertical");
      expect(passos).toMatchObject([
        { state: "failed", reason: "Criar Reels não é uma Habilidade ativa sua" },
        { state: "failed", reason: "Fazer bolo não é uma Habilidade ativa sua" },
      ]);
      expect(resposta.body).toBe("Pronto.");
    },
    LONGO,
  );

  test(
    "pela Conta, o claude -p lista e chama carregar Habilidade no endpoint MCP do Shearim e recebe o corpo",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await ativar(t, social.id, (await criar(t)).id);
      await t.linkAccount(bruno);
      t.claude.script({
        run: {
          kind: "steps",
          steps: [{ tool: { name: CARREGAR, input: { nome: "Criar carrossel" } } }, { text: "{resultado}" }],
        },
      });
      const aba = await t.socket(bruno);

      const origem = await enviar(t, geral.id, "@social faz um carrossel?");
      const resposta = await respostaA(t, geral.id, origem);

      const [listou, chamou] = t.claude.mcp();
      expect((listou as { listed: string[] }).listed).toContain(CARREGAR);
      expect(chamou).toMatchObject({ called: CARREGAR, result: { isError: false } });
      expect(resposta.body).toContain("2. Uma ideia por slide.");
      const fim = (await terminou(aba, origem)).at(-1)!;
      expect(fim.tools.filter((f) => f.tool === CARREGAR)).toMatchObject([
        { label: "carregando a Habilidade Criar carrossel", state: "done" },
      ]);
      await aba.close();
    },
    LONGO,
  );
});

describe("a Habilidade muda durante e entre as respostas", () => {
  /** Uma Ferramenta do Workspace que segura o primeiro turno até o teste soltar. */
  function seguraTurno() {
    let soltar = () => {};
    let chegou = () => {};
    const segurando = new Promise<void>((resolve) => (chegou = resolve));
    const definicao: ToolDefinition = {
      id: "consultar_arquivo",
      title: "consultar o arquivo",
      label: "consultando o arquivo",
      description: "Consulta o arquivo morto.",
      origin: "workspace",
      access: "read",
      inputSchema: { type: "object", properties: {} },
      run: () =>
        new Promise<string>((resolve) => {
          soltar = () => resolve("nada no arquivo");
          chegou();
        }),
    };
    return { definicao, segurando, soltar: () => soltar() };
  }

  for (const [como, mudar] of [
    [
      "desativa",
      (t: TestApp, agente: string, skill: string) => t.as(juliana).delete(`/api/agents/${agente}/skills/${skill}`),
    ],
    ["apaga", (t: TestApp, _agente: string, skill: string) => t.as(juliana).delete(`/api/skills/${skill}`)],
  ] as const) {
    test(
      `o Admin ${como} a Habilidade no meio da resposta: a chamada seguinte de carregar Habilidade falha com motivo no Andamento`,
      async () => {
        const turno = seguraTurno();
        const t = await testApp({ tools: { definitions: [...WORKSPACE_TOOLS, turno.definicao] } });
        const { social, geral } = await workspace(t);
        const carrossel = await criar(t);
        await ativar(t, social.id, carrossel.id);
        await t.as(juliana).put(`/api/agents/${social.id}/tools/consultar_arquivo`);
        const aba = await t.socket(bruno);

        t.anthropic.reply(
          { toolUse: [{ id: "toolu_1", name: "consultar_arquivo" }] },
          { toolUse: [{ id: "toolu_2", name: CARREGAR, input: { nome: "Criar carrossel" } }] },
          { text: "Sem a Habilidade." },
        );
        const origem = await enviar(t, geral.id, "@social faz um carrossel?");
        await turno.segurando;
        expect((await mudar(t, social.id, carrossel.id)).status).toBeLessThan(300);
        turno.soltar();

        expect((await respostaA(t, geral.id, origem)).body).toBe("Sem a Habilidade.");
        const [resultado] = toolResults(respostas(t)[2]!.body);
        expect(resultado).toMatchObject({ is_error: true });
        expect(resultado!.content).not.toContain("Uma ideia por slide");
        const fim = (await terminou(aba, origem)).at(-1)!;
        expect(fim.tools.filter((f) => f.tool === CARREGAR)).toMatchObject([
          { state: "failed", reason: expect.stringMatching(/.+/) },
        ]);
        await aba.close();
      },
      LONGO,
    );
  }

  test(
    "o Admin edita o corpo: a leitura seguinte devolve o corpo novo",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      const carrossel = await criar(t);
      await ativar(t, social.id, carrossel.id);
      await carregar(t, geral.id, ["Criar carrossel"]);

      const editada = await t
        .as(juliana)
        .patch(`/api/skills/${carrossel.id}`, { body: "Agora: sete slides, no máximo." });
      expect(editada.status).toBe(200);
      const { resultados } = await carregar(t, geral.id, ["Criar carrossel"]);

      expect(resultados[0]!.content).toContain("Agora: sete slides, no máximo.");
      expect(resultados[0]!.content).not.toContain("Uma ideia por slide");
    },
    LONGO,
  );
});

describe("onde a Habilidade está ativa", () => {
  const nomesDosAgentes = async (t: TestApp, id: string) =>
    ((await (await t.as(juliana).get(`/api/skills/${id}`)).json()) as SkillDto).agents.map((a) => a.name);
  const ativasEm = async (t: TestApp, agentId: string) =>
    ((await (await t.as(juliana).get(`/api/agents/${agentId}/skills`)).json()) as AgentSkillDto[])
      .filter((s) => s.active)
      .map((s) => s.name);

  test(
    "a tela da Habilidade mostra em quais Agentes ela está ativa; apagar a tira de todos na hora",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      const lince = await novoAgente(t, "Lince");
      const carrossel = await criar(t);
      const reels = await criar(t, { ...CARROSSEL, name: "Criar Reels" });
      await ativar(t, social.id, carrossel.id);
      await ativar(t, lince.id, carrossel.id);
      await ativar(t, social.id, reels.id);

      expect(await nomesDosAgentes(t, carrossel.id)).toEqual(["Lince", "Social"]);
      expect(
        await t
          .as(juliana)
          .get(`/api/agents/${social.id}/skills`)
          .then((r) => r.json()),
      ).toEqual([
        { id: carrossel.id, name: "Criar carrossel", description: CARROSSEL.description, active: true },
        { id: reels.id, name: "Criar Reels", description: CARROSSEL.description, active: true },
      ]);

      expect((await t.as(juliana).delete(`/api/agents/${lince.id}/skills/${carrossel.id}`)).status).toBe(200);
      expect(await nomesDosAgentes(t, carrossel.id)).toEqual(["Social"]);

      expect((await t.as(juliana).delete(`/api/skills/${carrossel.id}`)).status).toBe(204);
      expect((await t.as(juliana).get(`/api/skills/${carrossel.id}`)).status).toBe(404);
      expect(await ativasEm(t, social.id)).toEqual(["Criar Reels"]);
      expect((await t.as(juliana).put(`/api/agents/${social.id}/skills/${carrossel.id}`)).status).toBe(404);

      await respostaA(t, geral.id, await enviar(t, geral.id, "@social oi"));
      const system = systemDe(respostas(t)[0]!);
      expect(system).toContain("- Criar Reels:");
      expect(system).not.toContain("Criar carrossel");
    },
    LONGO,
  );

  test("um Agente apagado sai da lista de onde a Habilidade está ativa", async () => {
    const t = await testApp();
    const { social } = await workspace(t);
    const carrossel = await criar(t);
    await ativar(t, social.id, carrossel.id);

    expect((await t.as(juliana).delete(`/api/agents/${social.id}`)).status).toBeLessThan(300);

    expect(await nomesDosAgentes(t, carrossel.id)).toEqual([]);
  });

  test(
    "a Habilidade pode ser ativada na Articuladora, como em qualquer Agente",
    async () => {
      const t = await testApp();
      const { geral } = await workspace(t);
      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      const sophya = agentes.find((a) => a.builtin)!;
      const carrossel = await criar(t);
      await ativar(t, sophya.id, carrossel.id);
      expect(await nomesDosAgentes(t, carrossel.id)).toEqual(["Sophya"]);

      t.anthropic.reply(
        { toolUse: [{ id: "toolu_1", name: CARREGAR, input: { nome: "Criar carrossel" } }] },
        { text: "Pronto." },
      );
      await respostaA(t, geral.id, await enviar(t, geral.id, "@sophya faz um carrossel?"));
      const [pedido, depois] = respostas(t);
      expect(systemDe(pedido!)).toContain("## Suas Habilidades");
      expect(systemDe(pedido!)).toContain("- Criar carrossel: Use quando pedirem um carrossel para o Instagram.");
      expect(toolResults(depois!.body)[0]!.content).toContain("2. Uma ideia por slide.");
    },
    LONGO,
  );
});

describe("teto, orçamento e precedência", () => {
  test(
    "carregar Habilidade conta no teto de turnos de Ferramenta: no limite, a última chamada vai sem Ferramentas",
    async () => {
      const t = await testApp({ tools: { maxTurns: 2 } });
      const { social, geral } = await workspace(t);
      await ativar(t, social.id, (await criar(t)).id);
      const aba = await t.socket(bruno);
      const carregaDeNovo = (id: string) => ({
        toolUse: [{ id, name: CARREGAR, input: { nome: "Criar carrossel" } }],
      });

      t.anthropic.reply(carregaDeNovo("toolu_1"), carregaDeNovo("toolu_2"), { text: "Com o que tenho." });
      const origem = await enviar(t, geral.id, "@social faz um carrossel?");

      expect((await respostaA(t, geral.id, origem)).body).toBe("Com o que tenho.");
      expect((await terminou(aba, origem)).at(-1)!.toolLimit).toBe(true);
      const ultimo = respostas(t).at(-1)!;
      expect(!ultimo.body.tools || (ultimo.body.tool_choice as { type?: string })?.type === "none").toBe(true);
      await aba.close();
    },
    LONGO,
  );

  test(
    "o que a resposta gasta carregando a Habilidade conta no orçamento do Agente",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await t.as(juliana).patch(`/api/agents/${social.id}`, { monthlyBudgetUsd: 10 });
      await ativar(t, social.id, (await criar(t)).id);
      const DOIS_DOLARES = { input_tokens: 500_000, output_tokens: 100_000 };

      t.anthropic.reply(
        { toolUse: [{ id: "toolu_1", name: CARREGAR, input: { nome: "Criar carrossel" } }], usage: DOIS_DOLARES },
        { text: "Pronto.", usage: DOIS_DOLARES },
      );
      await respostaA(t, geral.id, await enviar(t, geral.id, "@social faz um carrossel?"));

      const agentes: AgentDto[] = await (await t.as(juliana).get("/api/agents")).json();
      expect(agentes.find((a) => a.id === social.id)).toMatchObject({ keySpendUsd: 4 });
    },
    LONGO,
  );

  test(
    "a nota de precedência diz: Contexto do Workspace > Instruções do Canal > instruções do Agente e Habilidades > Wiki e Memória",
    async () => {
      const t = await testApp();
      const { social, geral } = await workspace(t);
      await ativar(t, social.id, (await criar(t)).id);
      await t.as(juliana).post("/api/workspace-memory", { text: "Carrossel tem dez slides." });

      await respostaA(t, geral.id, await enviar(t, geral.id, "@social faz um carrossel?"));

      expect(systemDe(respostas(t)[0]!)).toContain(
        "O Contexto do Workspace vale acima das Instruções do Canal, que valem acima das suas instruções e das suas Habilidades, que valem acima da Wiki e da Memória: quando se contradizem, siga o que vale mais. Entre a Wiki e a Memória não há ordem.",
      );
    },
    LONGO,
  );
});
