import { describe, expect, test } from "bun:test";
import type { JoinRequestAdminDto, MessageDto } from "@shearim/contracts";
import { type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno", device: "iphone-do-bruno" };

/** Abre o Workspace com a Juliana (Admin) e devolve o que o Admin vê como pendente. */
async function pendentes(t: TestApp): Promise<JoinRequestAdminDto[]> {
  const res = await t.as(juliana).get("/api/join-requests");
  expect(res.status).toBe(200);
  return res.json();
}

describe("Pedido de entrada", () => {
  test("uma identidade nova cria um Pedido de entrada e, enquanto ele espera, vê só o estado dele", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me"); // a primeira pessoa vira Admin

    const created = await t.as(bruno).post("/api/join-request");

    expect(created.status).toBe(201);
    const mine = await (await t.as(bruno).get("/api/join-request")).json();
    expect(mine).toEqual({
      you: { login: "bruno@exemplo.com", displayName: "Bruno" },
      joinRequest: {
        id: expect.any(String),
        status: "pending",
        createdAt: "2026-11-24T12:00:00.000Z",
        decidedAt: null,
      },
    });
    expect((await t.as(bruno).get("/api/channels")).status).toBe(403);
    expect((await t.upgrade(bruno)).status).toBe(403);
  });

  test("o Admin vê nome, foto, login, aparelho e a marca de outra tailnet do pedido", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const carla = {
      id: "3003",
      login: "carla@outra.com",
      name: "Carla",
      device: "notebook-da-carla",
      profilePicUrl: "https://exemplo.com/carla.png",
      sharee: true,
    };
    await t.as(carla).post("/api/join-request");

    const list = await pendentes(t);

    expect(list).toEqual([
      {
        id: expect.any(String),
        status: "pending",
        createdAt: "2026-11-24T12:00:00.000Z",
        decidedAt: null,
        login: "carla@outra.com",
        displayName: "Carla",
        profilePicUrl: "https://exemplo.com/carla.png",
        device: "notebook-da-carla",
        sharee: true,
        previousRefusals: 0,
        lastRefusedAt: null,
      },
    ]);
  });

  test("um pedido de alguém da mesma tailnet chega sem a marca", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");

    const [pedido] = await pendentes(t);

    expect(pedido).toMatchObject({ displayName: "Bruno", sharee: false, profilePicUrl: null });
  });

  test("o Admin aprova o pedido e a pessoa vira Membro", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const [pedido] = await pendentes(t);

    const res = await t.as(juliana).post(`/api/join-requests/${pedido!.id}/approve`);

    expect(res.status).toBe(200);
    const me = await t.as(bruno).get("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ displayName: "Bruno", login: "bruno@exemplo.com", role: "member" });
    expect((await t.as(bruno).get("/api/channels")).status).toBe(200);
    expect((await (await t.as(bruno).get("/api/join-request")).json()).joinRequest.status).toBe("approved");
    expect(await pendentes(t)).toEqual([]);
  });

  test("quem foi recusado vê a recusa", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const [pedido] = await pendentes(t);
    t.clock.advance(60_000);

    const res = await t.as(juliana).post(`/api/join-requests/${pedido!.id}/refuse`);

    expect(res.status).toBe(200);
    expect((await (await t.as(bruno).get("/api/join-request")).json()).joinRequest).toEqual({
      id: pedido!.id,
      status: "refused",
      createdAt: "2026-11-24T12:00:00.000Z",
      decidedAt: "2026-11-24T12:01:00.000Z",
    });
    expect(await (await t.as(bruno).get("/api/me")).json()).toEqual({ error: "not_a_member" });
    expect(await pendentes(t)).toEqual([]);
  });

  test("quem foi recusado pede de novo, e o Admin vê que já houve uma recusa", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const [primeiro] = await pendentes(t);
    t.clock.advance(60_000);
    await t.as(juliana).post(`/api/join-requests/${primeiro!.id}/refuse`);
    t.clock.advance(60_000);

    const res = await t.as(bruno).post("/api/join-request");

    expect(res.status).toBe(201);
    expect((await (await t.as(bruno).get("/api/join-request")).json()).joinRequest.status).toBe("pending");
    const [novo] = await pendentes(t);
    expect(novo).toMatchObject({
      displayName: "Bruno",
      createdAt: "2026-11-24T12:02:00.000Z",
      previousRefusals: 1,
      lastRefusedAt: "2026-11-24T12:01:00.000Z",
    });
    expect(novo!.id).not.toBe(primeiro!.id);
  });

  test("pedir de novo enquanto espera não cria um segundo pedido", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    const primeiro = await (await t.as(bruno).post("/api/join-request")).json();

    const res = await t.as(bruno).post("/api/join-request");

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(primeiro.id);
    expect(await pendentes(t)).toHaveLength(1);
  });

  test("outro UserProfile.ID é outra pessoa e cria um pedido novo, mesmo com o mesmo login", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const outroBruno = { id: "2999", login: bruno.login, name: "Bruno" };

    const res = await t.as(outroBruno).post("/api/join-request");

    expect(res.status).toBe(201);
    expect(await pendentes(t)).toHaveLength(2);
    expect((await (await t.as(outroBruno).get("/api/join-request")).json()).joinRequest.status).toBe("pending");
  });

  test("um pedido já decidido não é decidido de novo", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const [pedido] = await pendentes(t);
    await t.as(juliana).post(`/api/join-requests/${pedido!.id}/approve`);

    const res = await t.as(juliana).post(`/api/join-requests/${pedido!.id}/refuse`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_decided", status: "approved" });
    expect((await t.as(bruno).get("/api/me")).status).toBe(200);
  });

  test("um Membro que não é Admin não vê nem decide pedidos", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const carla = { id: "3003", name: "Carla" };
    await t.as(carla).post("/api/join-request");
    const [pedido] = await pendentes(t);

    const lista = await t.as(bruno).get("/api/join-requests");
    const aprova = await t.as(bruno).post(`/api/join-requests/${pedido!.id}/approve`);

    expect(lista.status).toBe(403);
    expect(await aprova.json()).toEqual({ error: "not_admin" });
    expect((await t.as(carla).get("/api/me")).status).toBe(403);
  });

  test("quem já é Membro não cria pedido", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const res = await t.as(juliana).post("/api/join-request");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_member" });
  });

  test("o pedido novo chega na hora ao Admin pelo WebSocket, e não a quem não é Admin", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const daJuliana = await t.socket(juliana, "aba da Juliana");
    const doBruno = await t.socket(bruno, "aba do Bruno");

    await t.as({ id: "3003", name: "Carla", sharee: true }).post("/api/join-request");
    t.events.publish("everyone", { type: "message.created", message: marcador() });

    expect((await daJuliana.next("join_request.created")).joinRequest).toMatchObject({
      displayName: "Carla",
      sharee: true,
      status: "pending",
    });
    await doBruno.next("message.created");
    expect(doBruno.received().map((e) => e.type)).toEqual(["ready", "message.created"]);
  });

  test("a decisão de um Admin chega aos Admins, para o pedido sair da lista deles", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");
    await t.as(bruno).post("/api/join-request");
    const [pedido] = await pendentes(t);
    const aba = await t.socket(juliana);

    await t.as(juliana).post(`/api/join-requests/${pedido!.id}/refuse`);

    expect((await aba.next("join_request.decided")).joinRequest).toMatchObject({ id: pedido!.id, status: "refused" });
  });

  test("cada pedido novo passa pelo gancho de aviso aos Admins (o push é do #34)", async () => {
    const avisados: JoinRequestAdminDto[] = [];
    const t = await testApp({ hooks: { joinRequestCreated: (r) => void avisados.push(r) } });
    await t.as(juliana).get("/api/me");

    await t.as(bruno).post("/api/join-request");
    await t.as(bruno).post("/api/join-request"); // o mesmo pedido, não avisa de novo

    expect(avisados).toEqual([expect.objectContaining({ displayName: "Bruno", device: "iphone-do-bruno" })]);
  });

  test("sem identidade, a página é a estática em pt-BR com o motivo, e nenhum pedido é criado", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const page = await t.anonymous("funnel").get("/", { headers: { accept: "text/html" } });
    const pedido = await t.anonymous("funnel").post("/api/join-request");

    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Não sabemos quem é você");
    expect(html).toContain("O acesso veio pela internet aberta (Funnel)");
    expect(pedido.status).toBe(403);
    expect(await pedido.json()).toEqual({ error: "no_identity", reason: "funnel" });
    expect(await pendentes(t)).toEqual([]);
  });

  test("um nó com tag recebe a página com o motivo dele", async () => {
    const t = await testApp();

    const page = await t.anonymous("tagged").get("/c/qualquer");

    expect(page.status).toBe(403);
    expect(await page.text()).toContain("Este aparelho entrou na tailnet com uma tag");
  });
});

/** Um evento que chega a todos, publicado depois, para provar que outro não chegou. */
function marcador(): MessageDto {
  return {
    id: crypto.randomUUID(),
    channelId: crypto.randomUUID(),
    body: "marcador",
    author: { kind: "member", id: crypto.randomUUID(), displayName: "x", profilePicUrl: null },
    originMessageId: null,
    threadRootId: null,
    mentions: [],
    createdAt: "2026-11-24T12:00:00.000Z",
  };
}
