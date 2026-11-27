import { describe, expect, test } from "bun:test";
import type { ChannelDto, DmDto, MeDto, MessageDto } from "@regents/contracts";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };
const davi = { id: "4004", login: "davi@exemplo.com", name: "Davi" };

/** Juliana vira Admin; as outras pessoas, Membros. Devolve o `MeDto` de cada uma, pelo nome. */
async function workspace(t: TestApp, ...people: Person[]) {
  const me: Record<string, MeDto> = { Juliana: await (await t.as(juliana).get("/api/me")).json() };
  for (const p of people) me[p.name!] = await t.addMember(p, { by: juliana });
  return me;
}

async function abrirDm(t: TestApp, who: Person, memberIds: string[]) {
  return t.as(who).post("/api/dms", { memberIds });
}

async function dms(t: TestApp, who: Person): Promise<DmDto[]> {
  const res = await t.as(who).get("/api/dms");
  expect(res.status).toBe(200);
  return res.json();
}

const pessoa = (m: MeDto) => ({ kind: "member" as const, id: m.id, displayName: m.displayName });

describe("DM entre duas pessoas", () => {
  test("um Membro abre uma DM com outra pessoa, e só as duas veem a conversa", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);

    const res = await abrirDm(t, bruno, [me.Carla!.id]);

    expect(res.status).toBe(201);
    const dm: DmDto = await res.json();
    expect(dm).toEqual({ id: expect.any(String), kind: "dm", participants: [pessoa(me.Bruno!), pessoa(me.Carla!)] });
    expect(await dms(t, bruno)).toEqual([dm]);
    expect(await dms(t, carla)).toEqual([dm]);
    expect(await dms(t, juliana)).toEqual([]);

    const path = `/api/conversations/${dm.id}/messages`;
    expect((await t.as(bruno).post(path, { body: "oi, Carla" })).status).toBe(201);
    const lidas: MessageDto[] = await (await t.as(carla).get(path)).json();
    expect(lidas.map((m) => [m.author.displayName, m.body])).toEqual([["Bruno", "oi, Carla"]]);
    // Nem o Admin vê: para quem está fora, a DM não existe.
    expect((await t.as(juliana).get(path)).status).toBe(404);
    expect((await t.as(juliana).post(path, { body: "posso?" })).status).toBe(404);
  });

  test("os eventos da DM chegam só às duas pessoas", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const geral = ((await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[])[0]!;
    const doBruno = await t.socket(bruno, "aba do Bruno");
    const daCarla = await t.socket(carla, "aba da Carla");
    const daJuliana = await t.socket(juliana, "aba da Juliana (Admin, fora da DM)");

    const dm: DmDto = await (await abrirDm(t, bruno, [me.Carla!.id])).json();
    await t.as(carla).post(`/api/conversations/${dm.id}/messages`, { body: "oi, Bruno" });
    // Depois, algo que chega a todos: se o da DM chegasse à Juliana, chegaria antes.
    await t.as(bruno).post(`/api/channels/${geral.id}/messages`, { body: "para todos" });

    for (const dentro of [doBruno, daCarla]) {
      expect((await dentro.next("dm.updated")).dm).toEqual(dm);
      expect((await dentro.next("message.created")).message).toMatchObject({ channelId: dm.id, body: "oi, Bruno" });
    }
    expect((await daJuliana.next("message.created")).message.body).toBe("para todos");
    expect(daJuliana.received().some((e) => e.type === "dm.updated")).toBe(false);
  });

  test("abrir de novo uma DM com a mesma pessoa leva à mesma conversa, de qualquer um dos lados", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const primeira: DmDto = await (await abrirDm(t, bruno, [me.Carla!.id])).json();
    await t.as(bruno).post(`/api/conversations/${primeira.id}/messages`, { body: "lembra disso?" });
    const daCarla = await t.socket(carla, "aba da Carla");
    t.clock.advance(60_000);

    const deNovo = await abrirDm(t, bruno, [me.Carla!.id, me.Bruno!.id]);
    const doOutroLado = await abrirDm(t, carla, [me.Bruno!.id]);

    expect(deNovo.status).toBe(200);
    expect(await deNovo.json()).toEqual(primeira);
    expect(doOutroLado.status).toBe(200);
    expect(await doOutroLado.json()).toEqual(primeira);
    expect(await dms(t, carla)).toEqual([primeira]);
    const historico: MessageDto[] = await (await t.as(carla).get(`/api/conversations/${primeira.id}/messages`)).json();
    expect(historico.map((m) => m.body)).toEqual(["lembra disso?"]);
    // Nada mudou, então nada é avisado.
    await t.as(bruno).post(`/api/conversations/${primeira.id}/messages`, { body: "de novo" });
    expect((await daCarla.next("message.created")).message.body).toBe("de novo");
    expect(daCarla.received().some((e) => e.type === "dm.updated")).toBe(false);
  });

  test("duas aberturas ao mesmo tempo com a mesma pessoa dão numa DM só", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);

    const [a, b] = await Promise.all([abrirDm(t, bruno, [me.Carla!.id]), abrirDm(t, carla, [me.Bruno!.id])]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).id).toBe((await b.json()).id);
    expect(await dms(t, bruno)).toHaveLength(1);
  });
});

describe("DM em grupo", () => {
  test("um Membro abre uma DM em grupo com várias pessoas, e só os participantes a veem", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla, davi);
    const doDavi = await t.socket(davi, "aba do Davi");

    const res = await abrirDm(t, carla, [me.Davi!.id, me.Bruno!.id]);

    expect(res.status).toBe(201);
    const grupo: DmDto = await res.json();
    expect(grupo).toEqual({
      id: expect.any(String),
      kind: "group",
      participants: [pessoa(me.Bruno!), pessoa(me.Carla!), pessoa(me.Davi!)],
    });
    expect((await doDavi.next("dm.updated")).dm).toEqual(grupo);
    for (const dentro of [bruno, carla, davi]) expect(await dms(t, dentro)).toEqual([grupo]);
    expect(await dms(t, juliana)).toEqual([]);

    const path = `/api/conversations/${grupo.id}/messages`;
    await t.as(bruno).post(path, { body: "bom dia, grupo" });
    expect((await doDavi.next("message.created")).message.body).toBe("bom dia, grupo");
    expect((await t.as(juliana).get(path)).status).toBe(404);
  });

  test("abrir de novo com as mesmas pessoas leva ao mesmo grupo; com outras, é outra conversa", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla, davi);
    const grupo: DmDto = await (await abrirDm(t, bruno, [me.Carla!.id, me.Davi!.id])).json();
    t.clock.advance(60_000);

    const mesmo = await abrirDm(t, davi, [me.Bruno!.id, me.Carla!.id]);
    const maior = await abrirDm(t, bruno, [me.Carla!.id, me.Davi!.id, me.Juliana!.id]);
    t.clock.advance(60_000);
    const soDois = await abrirDm(t, bruno, [me.Carla!.id]);

    expect(mesmo.status).toBe(200);
    expect(await mesmo.json()).toEqual(grupo);
    expect(maior.status).toBe(201);
    expect(soDois.status).toBe(201);
    expect((await dms(t, bruno)).map((d) => [d.kind, d.participants.length])).toEqual([
      ["group", 3],
      ["group", 4],
      ["dm", 2],
    ]);
  });
});

describe("DMs e Canais", () => {
  test("as DMs aparecem numa lista própria, separadas dos Canais", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm: DmDto = await (await abrirDm(t, bruno, [me.Juliana!.id])).json();

    expect(((await (await t.as(bruno).get("/api/channels")).json()) as ChannelDto[]).map((c) => c.name)).toEqual([
      "geral",
    ]);
    expect((await dms(t, juliana)).map((d) => d.id)).toEqual([dm.id]);
    // Uma DM não é Canal: as rotas de Canal não a conhecem.
    expect((await t.as(bruno).get(`/api/channels/${dm.id}`)).status).toBe(404);
    expect((await t.as(bruno).get(`/api/channels/${dm.id}/messages`)).status).toBe(404);
    expect((await t.as(bruno).post(`/api/channels/${dm.id}/join`)).status).toBe(404);
    expect((await t.as(bruno).post(`/api/channels/${dm.id}/participants`, { memberId: me.Bruno!.id })).status).toBe(
      404,
    );
  });

  test("o N de uma DM é fixo: o Admin não a vê nem a edita nas Instruções dos Canais", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm: DmDto = await (await abrirDm(t, juliana, [me.Bruno!.id])).json();

    const config = await (await t.as(juliana).get("/api/channel-settings")).json();
    const patch = await t.as(juliana).request(`/api/channel-settings/${dm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recentMessages: 5 }),
    });

    expect(config.map((c: { name: string }) => c.name)).toEqual(["geral"]);
    expect(patch.status).toBe(404);
  });

  test("a mesma rota de mensagens serve para Canais", async () => {
    const t = await testApp();
    await workspace(t);
    const [geral] = (await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[];

    const res = await t.as(juliana).post(`/api/conversations/${geral!.id}/messages`, { body: "oi, geral" });

    expect(res.status).toBe(201);
    const lidas: MessageDto[] = await (await t.as(juliana).get(`/api/channels/${geral!.id}/messages`)).json();
    expect(lidas.map((m) => m.body)).toEqual(["oi, geral"]);
  });

  test("uma DM precisa de outra pessoa, e só de Membros", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);

    for (const body of [{}, { memberIds: [] }, { memberIds: [me.Bruno!.id] }, { memberIds: [42] }]) {
      const res = await t.as(bruno).post("/api/dms", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    expect((await abrirDm(t, bruno, [crypto.randomUUID()])).status).toBe(400);
    expect((await abrirDm(t, bruno, ["não-é-uuid"])).status).toBe(400);
    expect((await abrirDm(t, bruno, [me.Juliana!.id, crypto.randomUUID()])).status).toBe(400);
    expect(await dms(t, bruno)).toEqual([]);
  });
});
