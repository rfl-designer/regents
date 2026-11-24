import { describe, expect, test } from "bun:test";
import type { ChannelDto, MeDto } from "@shearim/contracts";
import {
  membroSemPedidoDeEntrada as membroSemPedidoDeEntradaComo,
  type Person,
  type TestApp,
  testApp,
} from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };

/** PROVISÓRIO até o #16 (ver o arnês): Juliana é a primeira a chegar e vira Admin. */
const membroSemPedidoDeEntrada = (t: TestApp, who: Person) => membroSemPedidoDeEntradaComo(t, juliana, who);

async function canais(t: TestApp, who: Person): Promise<ChannelDto[]> {
  const res = await t.as(who).get("/api/channels");
  expect(res.status).toBe(200);
  return res.json();
}

/** Cria um Canal um minuto depois do anterior (a lista vem em ordem de criação). */
async function criarCanal(t: TestApp, who: Person, name: string, kind: "public" | "private"): Promise<ChannelDto> {
  t.clock.advance(60_000);
  const res = await t.as(who).post("/api/channels", { name, kind });
  expect(res.status).toBe(201);
  return res.json();
}

describe("Canais públicos", () => {
  test("um Membro cria um Canal público com nome, e todo Membro o vê na lista", async () => {
    const t = await testApp();
    const eu = await membroSemPedidoDeEntrada(t, bruno);

    const vendas = await criarCanal(t, bruno, "vendas", "public");

    expect(vendas).toEqual({
      id: expect.any(String),
      name: "vendas",
      kind: "public",
      instructions: "",
      recentMessages: 30,
      participants: [{ kind: "member", id: eu.id, displayName: "Bruno" }],
    });
    expect((await canais(t, juliana)).map((c) => c.name)).toEqual(["geral", "vendas"]);
    expect((await canais(t, bruno)).find((c) => c.name === "vendas")).toEqual(vendas);
  });

  test("qualquer Membro entra num Canal público, e todos ficam sabendo", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    await membroSemPedidoDeEntrada(t, carla);
    const vendas = await criarCanal(t, bruno, "vendas", "public");
    const daJuliana = await t.socket(juliana, "aba da Juliana");

    const res = await t.as(carla).post(`/api/channels/${vendas.id}/join`);

    expect(res.status).toBe(200);
    const depois: ChannelDto = await res.json();
    expect(depois.participants.map((p) => p.displayName)).toEqual(["Bruno", "Carla"]);
    expect((await daJuliana.next("channel.updated")).channel).toEqual(depois);
    expect((await t.as(carla).post(`/api/channels/${vendas.id}/join`)).status).toBe(200);
  });

  test("quem escreve num Canal público de que não participa passa a participar", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const vendas = await criarCanal(t, juliana, "vendas", "public");
    t.clock.advance(60_000);

    await t.as(bruno).post(`/api/channels/${vendas.id}/messages`, { body: "cheguei" });

    const [, lista] = await canais(t, juliana);
    expect(lista!.participants.map((p) => p.displayName)).toEqual(["Juliana", "Bruno"]);
  });

  test("o primeiro Admin já participa do Canal inicial", async () => {
    const t = await testApp();
    const me: MeDto = await (await t.as(juliana).get("/api/me")).json();

    const [geral] = await canais(t, juliana);

    expect(geral!.participants).toEqual([{ kind: "member", id: me.id, displayName: "Juliana" }]);
  });

  test("o nome do Canal é obrigatório e único, sem diferença de maiúsculas", async () => {
    const t = await testApp();
    await canais(t, juliana);
    await criarCanal(t, juliana, "Vendas", "public");

    const repetido = await t.as(juliana).post("/api/channels", { name: " vendas ", kind: "private" });
    expect(repetido.status).toBe(409);
    expect(await repetido.json()).toMatchObject({ error: "name_taken" });
    expect((await t.as(juliana).post("/api/channels", { name: "  ", kind: "public" })).status).toBe(400);
    expect((await t.as(juliana).post("/api/channels", { name: "outro", kind: "secreto" })).status).toBe(400);
    expect((await canais(t, juliana)).map((c) => c.name)).toEqual(["geral", "Vendas"]);
  });
});

describe("Canais privados", () => {
  test("a lista de Membros mostra quem se pode adicionar a um Canal", async () => {
    const t = await testApp();
    const doBruno = await membroSemPedidoDeEntrada(t, bruno);
    const daJuliana: MeDto = await (await t.as(juliana).get("/api/me")).json();

    const res = await t.as(bruno).get("/api/members");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: doBruno.id, displayName: "Bruno" },
      { id: daJuliana.id, displayName: "Juliana" },
    ]);
  });

  test("só quem participa vê um Canal privado; o Admin de fora não o vê nem lê as mensagens", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    await membroSemPedidoDeEntrada(t, carla);
    const diretoria = await criarCanal(t, bruno, "diretoria", "private");
    await t.as(bruno).post(`/api/channels/${diretoria.id}/messages`, { body: "segredo" });
    const path = `/api/channels/${diretoria.id}/messages`;

    expect((await canais(t, bruno)).map((c) => c.name)).toEqual(["geral", "diretoria"]);
    for (const fora of [juliana, carla]) {
      expect((await canais(t, fora)).map((c) => c.name)).toEqual(["geral"]);
      expect((await t.as(fora).get(path)).status).toBe(404);
      expect((await t.as(fora).get(`/api/channels/${diretoria.id}`)).status).toBe(404);
      expect((await t.as(fora).post(path, { body: "posso?" })).status).toBe(404);
    }
    const lidas = await (await t.as(bruno).get(path)).json();
    expect(lidas.map((m: { body: string }) => m.body)).toEqual(["segredo"]);
    expect(await (await t.as(bruno).get(`/api/channels/${diretoria.id}`)).json()).toEqual(diretoria);
  });

  test("quem não participa de um Canal privado não recebe nenhum evento dele pelo WebSocket", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    await membroSemPedidoDeEntrada(t, carla);
    const geral = (await canais(t, juliana))[0]!;
    const daJuliana = await t.socket(juliana, "aba da Juliana (Admin, fora do Canal)");
    const daCarla = await t.socket(carla, "aba da Carla (fora do Canal)");
    const doBruno = await t.socket(bruno, "aba do Bruno (no Canal)");

    const diretoria = await criarCanal(t, bruno, "diretoria", "private");
    await t.as(bruno).post(`/api/channels/${diretoria.id}/messages`, { body: "segredo" });
    // Depois, algo que chega a todos: se o do Canal privado chegasse, chegaria antes.
    t.clock.advance(60_000);
    const aberto = await criarCanal(t, carla, "aberto", "public");
    await t.as(carla).post(`/api/channels/${geral.id}/messages`, { body: "para todos" });

    expect((await doBruno.next("channel.updated")).channel).toEqual(diretoria);
    expect((await doBruno.next("message.created")).message.body).toBe("segredo");
    for (const fora of [daJuliana, daCarla]) {
      expect((await fora.next("channel.updated")).channel).toEqual(aberto);
      expect((await fora.next("message.created")).message.body).toBe("para todos");
    }
  });

  test("quem participa adiciona uma pessoa, que passa a ver o Canal, o histórico e os eventos", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const daCarla = await membroSemPedidoDeEntrada(t, carla);
    const diretoria = await criarCanal(t, bruno, "diretoria", "private");
    await t.as(bruno).post(`/api/channels/${diretoria.id}/messages`, { body: "antes da Carla" });
    const abaDaCarla = await t.socket(carla, "aba da Carla");

    const res = await t.as(bruno).post(`/api/channels/${diretoria.id}/participants`, { memberId: daCarla.id });
    expect(res.status).toBe(200);
    const atualizado: ChannelDto = await res.json();

    expect(atualizado.participants.map((p) => p.displayName)).toEqual(["Bruno", "Carla"]);
    expect((await abaDaCarla.next("channel.updated")).channel).toEqual(atualizado);
    expect((await canais(t, carla)).map((c) => c.name)).toEqual(["geral", "diretoria"]);
    const historico = await (await t.as(carla).get(`/api/channels/${diretoria.id}/messages`)).json();
    expect(historico.map((m: { body: string }) => m.body)).toEqual(["antes da Carla"]);

    await t.as(bruno).post(`/api/channels/${diretoria.id}/messages`, { body: "oi, Carla" });
    expect((await abaDaCarla.next("message.created")).message.body).toBe("oi, Carla");
  });

  test("quem não vê o Canal privado não adiciona ninguém, e só Membro pode ser adicionado", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const daCarla = await membroSemPedidoDeEntrada(t, carla);
    const diretoria = await criarCanal(t, bruno, "diretoria", "private");
    const path = `/api/channels/${diretoria.id}/participants`;

    expect((await t.as(juliana).post(path, { memberId: daCarla.id })).status).toBe(404);
    expect((await t.as(carla).post(path, { memberId: daCarla.id })).status).toBe(404);
    expect((await t.as(bruno).post(path, { memberId: crypto.randomUUID() })).status).toBe(400);
    expect((await t.as(bruno).post(path, {})).status).toBe(400);
    expect((await canais(t, carla)).map((c) => c.name)).toEqual(["geral"]);
  });

  test("ninguém entra sozinho num Canal privado", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const diretoria = await criarCanal(t, bruno, "diretoria", "private");

    expect((await t.as(juliana).post(`/api/channels/${diretoria.id}/join`)).status).toBe(404);
    expect((await canais(t, juliana)).map((c) => c.name)).toEqual(["geral"]);
  });
});

describe("Instruções do Canal e N", () => {
  test("o Admin edita as Instruções e o N de um Canal privado de que não participa, sem ler as mensagens", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const diretoria = await criarCanal(t, bruno, "diretoria", "private");
    await t.as(bruno).post(`/api/channels/${diretoria.id}/messages`, { body: "segredo" });
    const doBruno = await t.socket(bruno, "aba do Bruno");

    const lista = await t.as(juliana).get("/api/channel-settings");
    expect(lista.status).toBe(200);
    const config = await lista.json();
    expect(config).toEqual([
      { id: expect.any(String), name: "geral", kind: "public", instructions: "", recentMessages: 30 },
      { id: diretoria.id, name: "diretoria", kind: "private", instructions: "", recentMessages: 30 },
    ]);
    expect(JSON.stringify(config)).not.toContain("segredo");

    const res = await t.as(juliana).request(`/api/channel-settings/${diretoria.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Responda curto.", recentMessages: 0 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: diretoria.id,
      name: "diretoria",
      kind: "private",
      instructions: "Responda curto.",
      recentMessages: 0,
    });
    expect((await doBruno.next("channel.updated")).channel).toMatchObject({
      instructions: "Responda curto.",
      recentMessages: 0,
    });
    expect(await (await t.as(bruno).get(`/api/channels/${diretoria.id}`)).json()).toMatchObject({
      instructions: "Responda curto.",
      recentMessages: 0,
    });
    expect((await t.as(juliana).get(`/api/channels/${diretoria.id}/messages`)).status).toBe(404);
  });

  test("só o Admin mexe nas Instruções e no N, e o N é um inteiro de 0 para cima", async () => {
    const t = await testApp();
    await membroSemPedidoDeEntrada(t, bruno);
    const [geral] = await canais(t, juliana);
    const patch = (who: Person, body: unknown) =>
      t.as(who).request(`/api/channel-settings/${geral!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await t.as(bruno).get("/api/channel-settings")).status).toBe(403);
    expect((await patch(bruno, { instructions: "mandei eu" })).status).toBe(403);
    expect((await patch(juliana, { recentMessages: -1 })).status).toBe(400);
    expect((await patch(juliana, { recentMessages: 2.5 })).status).toBe(400);
    expect((await patch(juliana, { instructions: 42 })).status).toBe(400);
    expect(
      (await t.as(juliana).request(`/api/channel-settings/${crypto.randomUUID()}`, { method: "PATCH" })).status,
    ).toBe(404);
    expect((await canais(t, bruno))[0]).toMatchObject({ instructions: "", recentMessages: 30 });
  });
});
