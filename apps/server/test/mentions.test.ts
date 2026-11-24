import { describe, expect, test } from "bun:test";
import type { ChannelDto, MessageDto } from "@shearim/contracts";
import { type TestApp, testApp } from "./harness";

const juliana = { id: "1001", name: "Juliana", profilePicUrl: "https://pic/j.png" };
const bruno = { id: "2002", name: "Bruno" };
const carla = { id: "3003", name: "Carla" };

async function geral(t: TestApp) {
  const channels: ChannelDto[] = await (await t.as(juliana).get("/api/channels")).json();
  return channels.find((c) => c.name === "geral")!;
}

async function send(t: TestApp, who: typeof juliana | typeof bruno, channelId: string, body: string) {
  const res = await t.as(who).post(`/api/channels/${channelId}/messages`, { body });
  expect(res.status).toBe(201);
  return (await res.json()) as MessageDto;
}

describe("Menção a pessoa", () => {
  test("uma mensagem com @nome registra a Menção, na resposta, na lista e no WebSocket", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const canal = await geral(t);
    const abaDoBruno = await t.socket(bruno, "aba do Bruno");

    const enviada = await send(t, juliana, canal.id, "@bruno olha isso");
    const { message: chegou } = await abaDoBruno.next("message.created");
    const [lida] = await (await t.as(bruno).get(`/api/channels/${canal.id}/messages`)).json();

    for (const m of [enviada, chegou, lida]) expect(m.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
    expect(lida.author).toMatchObject({ displayName: "Juliana", profilePicUrl: "https://pic/j.png" });
  });

  test("a Menção ignora maiúsculas, acento e pontuação em volta, e vale uma vez por pessoa", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const daCarla = await t.addMember({ id: "3003", name: "Cárla" }, { by: juliana });
    const canal = await geral(t);

    const m = await send(t, juliana, canal.id, "Oi @Bruno, e você (@CÁRLA)? @bruno.");

    expect(m.mentions).toEqual([
      { kind: "member", id: doBruno.id },
      { kind: "member", id: daCarla.id },
    ]);
  });

  test("e-mail, identificador de ninguém e @ solto não são Menção", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const canal = await geral(t);

    const m = await send(t, juliana, canal.id, "manda para bruno@exemplo.com, @ninguem e @ sozinho");

    expect(m.mentions).toEqual([]);
  });

  test("num Canal privado, só conta a Menção a quem participa dele", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    await t.addMember(carla, { by: juliana });
    const privado: ChannelDto = await (
      await t.as(juliana).post("/api/channels", { name: "diretoria", kind: "private" })
    ).json();
    await t.as(juliana).post(`/api/channels/${privado.id}/participants`, { memberId: doBruno.id });

    const m = await send(t, juliana, privado.id, "@bruno e @carla, vejam");

    expect(m.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
  });

  test("a Menção continua da pessoa depois que ela troca o identificador", async () => {
    const t = await testApp();
    const doBruno = await t.addMember(bruno, { by: juliana });
    const canal = await geral(t);
    await send(t, juliana, canal.id, "@bruno pode ver?");

    await t.as(bruno).patch("/api/me", { handle: "bl" });
    const [lida] = await (await t.as(juliana).get(`/api/channels/${canal.id}/messages`)).json();

    expect(lida.mentions).toEqual([{ kind: "member", id: doBruno.id }]);
  });
});
