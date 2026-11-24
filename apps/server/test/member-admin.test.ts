import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  type AgentDto,
  type ChannelDto,
  type DmDto,
  type ExecutionDto,
  MEMBER_REMOVED_CLOSE_CODE,
  type MemberSummaryDto,
  type MessageDto,
} from "@shearim/contracts";
import { FAKE_LOGIN_CODE } from "./fake-claude";
import { type EventSocket, eventually, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "1003", login: "carla@exemplo.com", name: "Carla" };

/** Juliana abre o Workspace (Admin); Bruno e Carla entram pelo Pedido de entrada. */
async function workspace(t: TestApp) {
  const brunoMe = await t.addMember(bruno, { by: juliana });
  const carlaMe = await t.addMember(carla, { by: juliana });
  const julianaMe = await (await t.as(juliana).get("/api/me")).json();
  return { juliana: julianaMe, bruno: brunoMe, carla: carlaMe };
}

/** A Chave, o Faro no #geral e o #geral. */
async function geralComFaro(t: TestApp) {
  await t.as(juliana).put("/api/workspace-key", { apiKey: "sk-ant-api03-chave" });
  const faro: AgentDto = await (
    await t.as(juliana).post("/api/agents", { name: "Faro", description: "Comercial.", model: "claude-sonnet-5-5" })
  ).json();
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  await t.as(juliana).post(`/api/channels/${geral!.id}/agents`, { agentId: faro.id });
  return geral!;
}

/** O próximo Andamento que satisfaz `quando`. */
async function andamento(aba: EventSocket, quando: (e: ExecutionDto) => boolean): Promise<ExecutionDto> {
  for (;;) {
    const { execution } = await aba.next("execution.updated");
    if (quando(execution)) return execution;
  }
}

async function membros(t: TestApp): Promise<MemberSummaryDto[]> {
  return (await t.as(juliana).get("/api/members")).json();
}

describe("Admin muda o papel de um Membro", () => {
  test("o Admin torna outro Membro Admin, e todos veem a troca", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const abaDoBruno = await t.socket(bruno, "aba do Bruno");

    const res = await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "admin" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ids.bruno.id, role: "admin" });
    expect((await (await t.as(bruno).get("/api/me")).json()).role).toBe("admin");
    expect((await abaDoBruno.next("member.updated")).member).toMatchObject({ id: ids.bruno.id, role: "admin" });
    expect((await t.as(bruno).get("/api/join-requests")).status).toBe(200);
    expect((await membros(t)).map((m) => [m.displayName, m.role])).toEqual([
      ["Bruno", "admin"],
      ["Carla", "member"],
      ["Juliana", "admin"],
    ]);
  });

  test("quem não é Admin não muda o papel de ninguém", async () => {
    const t = await testApp();
    const ids = await workspace(t);

    const res = await t.as(bruno).patch(`/api/members/${ids.carla.id}`, { role: "admin" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin" });
  });

  test("o Admin rebaixa outro Admin, mas não o último", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "admin" });

    const rebaixado = await t.as(bruno).patch(`/api/members/${ids.juliana.id}`, { role: "member" });
    const ultimo = await t.as(bruno).patch(`/api/members/${ids.bruno.id}`, { role: "member" });

    expect(rebaixado.status).toBe(200);
    expect(ultimo.status).toBe(409);
    expect(await ultimo.json()).toMatchObject({ error: "last_admin" });
    expect((await (await t.as(bruno).get("/api/me")).json()).role).toBe("admin");
  });

  test("papel inválido ou Membro que não existe", async () => {
    const t = await testApp();
    const ids = await workspace(t);

    expect((await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "dono" })).status).toBe(400);
    expect((await t.as(juliana).patch(`/api/members/${crypto.randomUUID()}`, { role: "admin" })).status).toBe(404);
    expect((await t.as(juliana).patch("/api/members/nao-e-uuid", { role: "admin" })).status).toBe(404);
  });
});

describe("Admin remove um Membro", () => {
  test("quem é removido perde o acesso: o HTTP recusa e o WebSocket aberto é avisado e fechado", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const abaDoBruno = await t.socket(bruno, "aba do Bruno");
    const abaDaCarla = await t.socket(carla, "aba da Carla");

    const res = await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    expect(res.status).toBe(204);
    expect((await abaDaCarla.next("member.removed")).memberId).toBe(ids.bruno.id);
    expect((await abaDoBruno.next("member.removed")).memberId).toBe(ids.bruno.id);
    expect(await abaDoBruno.closed()).toMatchObject({ code: MEMBER_REMOVED_CLOSE_CODE });
    expect(await (await t.as(bruno).get("/api/channels")).json()).toEqual({ error: "not_a_member" });
    expect((await t.upgrade(bruno)).status).toBe(403);
    expect((await membros(t)).map((m) => m.displayName)).toEqual(["Carla", "Juliana"]);
  });

  test("quem não é Admin não remove; ninguém remove a si mesmo", async () => {
    const t = await testApp();
    const ids = await workspace(t);

    const porMembro = await t.as(bruno).delete(`/api/members/${ids.carla.id}`);
    const aSiMesmo = await t.as(juliana).delete(`/api/members/${ids.juliana.id}`);

    expect(porMembro.status).toBe(403);
    expect(aSiMesmo.status).toBe(409);
    expect(await aSiMesmo.json()).toMatchObject({ error: "cannot_remove_self" });
    expect((await t.as(carla).get("/api/me")).status).toBe(200);
  });

  test("o Admin remove outro Admin; remover de novo quem já saiu é como um Membro que não existe", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "admin" });

    expect((await t.as(juliana).delete(`/api/members/${ids.bruno.id}`)).status).toBe(204);
    expect((await t.as(juliana).delete(`/api/members/${ids.bruno.id}`)).status).toBe(404);
    expect((await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "admin" })).status).toBe(404);
  });
});

describe("O que fica de quem saiu", () => {
  test("as execuções abertas de quem foi removido são canceladas à vista de todos, com o motivo", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const geral = await geralComFaro(t);
    const aba = await t.socket(juliana);
    t.anthropic.reply({ hang: true });
    const origem: MessageDto = await (
      await t.as(bruno).post(`/api/channels/${geral.id}/messages`, { body: "@Faro me ajuda?" })
    ).json();
    await t.anthropic.waitForRequests(1);

    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    const cancelada = await andamento(aba, (e) => e.state === "cancelled");
    expect(cancelada).toMatchObject({
      originMessageId: origem.id,
      reason: "quem escreveu saiu do Workspace",
    });
    const [depois] = (await (await t.as(juliana).get(`/api/channels/${geral.id}/executions`)).json()) as ExecutionDto[];
    expect(depois).toMatchObject({ state: "cancelled", reason: "quem escreveu saiu do Workspace" });
  });

  test("as mensagens de quem foi removido ficam com a marca de que saiu do Workspace", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    await t.as(bruno).post(`/api/channels/${geral!.id}/messages`, { body: "oi, gente" });
    await t.as(carla).post(`/api/channels/${geral!.id}/messages`, { body: "oi, Bruno" });

    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    const lista: MessageDto[] = await (await t.as(carla).get(`/api/channels/${geral!.id}/messages`)).json();
    expect(lista.map((m) => [m.author.displayName, m.author.kind === "member" && m.author.leftWorkspace])).toEqual([
      ["Bruno", true],
      ["Carla", false],
    ]);
  });
});

describe("A Conta de quem foi removido", () => {
  test("é desligada: claude auth logout na pasta dela, e a pasta apagada", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const aba = await t.socket(bruno);
    await t.as(bruno).post("/api/account/linking");
    for (;;)
      if ((await aba.next("account.updated", { timeoutMs: 5_000 })).account.linking?.state === "waiting_code") break;
    await t.as(bruno).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
    for (;;) if ((await aba.next("account.updated", { timeoutMs: 5_000 })).account.status.state === "linked") break;
    const dir = t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!;

    expect((await t.as(juliana).delete(`/api/members/${ids.bruno.id}`)).status).toBe(204);

    expect(t.claude.callsOf("auth logout").map((c) => c.env.CLAUDE_CONFIG_DIR)).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  test("uma ligação pela metade é encerrada, sem sobrar processo nem pasta", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const aba = await t.socket(bruno);
    await t.as(bruno).post("/api/account/linking");
    for (;;)
      if ((await aba.next("account.updated", { timeoutMs: 5_000 })).account.linking?.state === "waiting_code") break;
    const dir = t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR!;

    expect((await t.as(juliana).delete(`/api/members/${ids.bruno.id}`)).status).toBe(204);

    expect(existsSync(dir)).toBe(false);
  });
});

/** Bruno num Canal privado, numa DM em grupo e numa DM a dois com a Carla; e uma mensagem dele no #geral. */
async function brunoEmTudo(t: TestApp, ids: Awaited<ReturnType<typeof workspace>>) {
  const privado: ChannelDto = await (
    await t.as(carla).post("/api/channels", { name: "diretoria", kind: "private" })
  ).json();
  await t.as(carla).post(`/api/channels/${privado.id}/participants`, { memberId: ids.bruno.id });
  const grupo: DmDto = await (await t.as(carla).post("/api/dms", { memberIds: [ids.bruno.id, ids.juliana.id] })).json();
  const dm: DmDto = await (await t.as(carla).post("/api/dms", { memberIds: [ids.bruno.id] })).json();
  await t.as(bruno).post(`/api/conversations/${dm.id}/messages`, { body: "oi, Carla" });
  const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
  const noGeral: MessageDto = await (
    await t.as(bruno).post(`/api/channels/${geral!.id}/messages`, { body: "bom dia" })
  ).json();
  return { privado, grupo, dm, geral: geral!, noGeral };
}

const pessoas = (participants: { kind: string; displayName: string }[]) =>
  participants.filter((p) => p.kind === "member").map((p) => p.displayName);

describe("Quem foi removido sai das conversas fechadas", () => {
  test("sai dos Canais privados e das DMs em grupo, e quem fica vê a troca; continua nas DMs a dois", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const { privado, grupo, dm } = await brunoEmTudo(t, ids);
    const abaDaCarla = await t.socket(carla);

    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    expect(pessoas((await abaDaCarla.next("channel.updated")).channel.participants)).toEqual(["Carla"]);
    expect(pessoas((await abaDaCarla.next("dm.updated")).dm.participants)).toEqual(["Carla", "Juliana"]);
    const dms: DmDto[] = await (await t.as(carla).get("/api/dms")).json();
    expect(Object.fromEntries(dms.map((d) => [d.id, pessoas(d.participants)]))).toEqual({
      [grupo.id]: ["Carla", "Juliana"],
      [dm.id]: ["Bruno", "Carla"],
    });
    const canal: ChannelDto = await (await t.as(carla).get(`/api/channels/${privado.id}`)).json();
    expect(pessoas(canal.participants)).toEqual(["Carla"]);
  });

  test("quem saiu não pode ser posto de novo numa conversa", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const { privado } = await brunoEmTudo(t, ids);
    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    const noCanal = await t.as(carla).post(`/api/channels/${privado.id}/participants`, { memberId: ids.bruno.id });
    const numaDm = await t.as(carla).post("/api/dms", { memberIds: [ids.bruno.id, ids.juliana.id] });

    expect(noCanal.status).toBe(400);
    expect(numaDm.status).toBe(400);
  });
});

describe("Quem foi removido volta pelo Pedido de entrada", () => {
  test("vê que saiu do Workspace e pode pedir de novo", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    t.clock.advance(60_000);
    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    const mine = await (await t.as(bruno).get("/api/join-request")).json();
    const pedido = await t.as(bruno).post("/api/join-request");

    expect(mine).toMatchObject({ joinRequest: null, removedAt: "2026-11-24T12:01:00.000Z" });
    expect(pedido.status).toBe(201);
    expect(await (await t.as(bruno).get("/api/join-request")).json()).toMatchObject({
      joinRequest: { status: "pending" },
      removedAt: "2026-11-24T12:01:00.000Z",
    });
  });

  test("aprovado de novo, é o mesmo Membro, com o histórico, mas fora dos Canais privados e das DMs em grupo", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const { privado, grupo, dm, geral, noGeral } = await brunoEmTudo(t, ids);
    await t.as(juliana).patch(`/api/members/${ids.bruno.id}`, { role: "admin" });
    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    const voltou = await t.addMember(bruno, { by: juliana });

    expect(voltou).toMatchObject({ id: ids.bruno.id, handle: ids.bruno.handle, role: "member" });
    const canais: ChannelDto[] = await (await t.as(bruno).get("/api/channels")).json();
    expect(canais.map((c) => c.id)).toEqual([geral.id]);
    expect((await t.as(bruno).get(`/api/channels/${privado.id}`)).status).toBe(404);
    const dms: DmDto[] = await (await t.as(bruno).get("/api/dms")).json();
    expect(dms.map((d) => d.id)).toEqual([dm.id]);
    expect((await t.as(bruno).get(`/api/conversations/${grupo.id}/messages`)).status).toBe(404);
    const noGeralAgora: MessageDto[] = await (await t.as(bruno).get(`/api/channels/${geral.id}/messages`)).json();
    expect(noGeralAgora.find((m) => m.id === noGeral.id)?.author).toMatchObject({
      id: ids.bruno.id,
      leftWorkspace: false,
    });
    const naDm: MessageDto[] = await (await t.as(bruno).get(`/api/conversations/${dm.id}/messages`)).json();
    expect(naDm.map((m) => m.body)).toEqual(["oi, Carla"]);
    expect((await membros(t)).map((m) => m.displayName)).toEqual(["Bruno", "Carla", "Juliana"]);
  });
});

describe("Os Agentes e quem saiu", () => {
  test("quem saiu não entra no quem é quem do contexto, e as mensagens dele continuam", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const geral = await geralComFaro(t);
    await t.as(bruno).post(`/api/channels/${geral.id}/messages`, { body: "a proposta sai sexta" });
    await t.as(carla).post(`/api/channels/${geral.id}/messages`, { body: "combinado" });
    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    await t.as(carla).post(`/api/channels/${geral.id}/messages`, { body: "@Faro quando sai a proposta?" });
    // As mensagens sem Menção passam pelo roteamento da Sophya (com `output_config`); a do Faro, não.
    const chamada = await eventually("o Faro ser chamado", async () =>
      t.anthropic.requests.find((r) => !r.body.output_config),
    );

    const system = String(chamada!.body.system);
    const pessoasNoContexto = system.slice(system.indexOf("Pessoas:"), system.indexOf("Agentes:"));
    expect(pessoasNoContexto).toContain("- Carla");
    expect(pessoasNoContexto).not.toContain("Bruno");
    expect(JSON.stringify(chamada!.body.messages)).toContain("Bruno (pessoa): a proposta sai sexta");
  });
});

describe("O push de quem foi removido", () => {
  test("para: nem a DM a dois que continua nem uma Menção chegam aos aparelhos dele", async () => {
    const t = await testApp();
    const ids = await workspace(t);
    const dm: DmDto = await (await t.as(carla).post("/api/dms", { memberIds: [ids.bruno.id] })).json();
    const comJuliana: DmDto = await (await t.as(carla).post("/api/dms", { memberIds: [ids.juliana.id] })).json();
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];
    const doBruno = await t.pushDevice(bruno);
    const daJuliana = await t.pushDevice(juliana);
    await t.as(juliana).delete(`/api/members/${ids.bruno.id}`);

    await t.as(carla).post(`/api/conversations/${dm.id}/messages`, { body: "Bruno, ainda está aí?" });
    await t.as(carla).post(`/api/channels/${geral!.id}/messages`, { body: `@${ids.bruno.handle} oi` });
    await t.as(carla).post(`/api/conversations/${comJuliana.id}/messages`, { body: "O Bruno saiu?" });

    // Os pushes saem em fila: quando o da Juliana chega, os anteriores já teriam chegado.
    expect((await daJuliana.next()).payload.notification.body).toBe("O Bruno saiu?");
    expect(t.push.deliveries.filter((d) => d.endpoint === doBruno.subscription.endpoint)).toEqual([]);
  });
});
