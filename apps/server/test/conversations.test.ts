import { describe, expect, test } from "bun:test";
import type { ChannelDto, MessageDto } from "@shearim/contracts";
import { testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };

async function canalInicial(t: Awaited<ReturnType<typeof testApp>>) {
  const res = await t.as(juliana).get("/api/channels");
  const channels: ChannelDto[] = await res.json();
  return channels[0]!;
}

describe("Conversas", () => {
  test("a Instalação tem um Canal público inicial quando o primeiro Admin chega", async () => {
    const t = await testApp();

    const res = await t.as(juliana).get("/api/channels");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: expect.any(String),
        name: "geral",
        kind: "public",
        instructions: "",
        recentMessages: 30,
        participants: [{ kind: "member", id: expect.any(String), displayName: "Juliana" }],
      },
    ]);
  });

  test("a mensagem do Admin é gravada e aparece de novo ao recarregar", async () => {
    const t = await testApp();
    const geral = await canalInicial(t);

    const sent = await t.as(juliana).post(`/api/channels/${geral.id}/messages`, { body: "Bom dia, time!" });
    expect(sent.status).toBe(201);

    const reload = await t.as(juliana).get(`/api/channels/${geral.id}/messages`);
    expect(reload.status).toBe(200);
    const messages: MessageDto[] = await reload.json();
    expect(messages).toEqual([
      {
        id: expect.any(String),
        channelId: geral.id,
        body: "Bom dia, time!",
        author: { id: expect.any(String), displayName: "Juliana", profilePicUrl: null },
        mentions: [],
        createdAt: "2026-11-24T12:00:00.000Z",
      },
    ]);
  });

  test("as mensagens voltam na ordem em que foram enviadas, com a hora do relógio", async () => {
    const t = await testApp();
    const geral = await canalInicial(t);
    const path = `/api/channels/${geral.id}/messages`;

    await t.as(juliana).post(path, { body: "primeira" });
    await t.as(juliana).post(path, { body: "segunda" });
    t.clock.advance(90_000);
    await t.as(juliana).post(path, { body: "terceira" });

    const messages: MessageDto[] = await (await t.as(juliana).get(path)).json();
    expect(messages.map((m) => [m.body, m.createdAt])).toEqual([
      ["primeira", "2026-11-24T12:00:00.000Z"],
      ["segunda", "2026-11-24T12:00:00.000Z"],
      ["terceira", "2026-11-24T12:01:30.000Z"],
    ]);
  });

  test("uma mensagem em branco é recusada e não é gravada", async () => {
    const t = await testApp();
    const geral = await canalInicial(t);
    const path = `/api/channels/${geral.id}/messages`;

    const res = await t.as(juliana).post(path, { body: "   " });

    expect(res.status).toBe(400);
    expect(await (await t.as(juliana).get(path)).json()).toEqual([]);
  });

  test("um Canal que não existe responde 404", async () => {
    const t = await testApp();
    await canalInicial(t);
    const path = `/api/channels/${crypto.randomUUID()}/messages`;

    expect((await t.as(juliana).get(path)).status).toBe(404);
    expect((await t.as(juliana).post(path, { body: "oi" })).status).toBe(404);
  });

  test("quem não é Membro não vê os Canais", async () => {
    const t = await testApp();
    await canalInicial(t);

    expect((await t.as({ id: "2002" }).get("/api/channels")).status).toBe(403);
  });
});
