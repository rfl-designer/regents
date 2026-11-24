import { describe, expect, test } from "bun:test";
import { testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana Prado", profilePicUrl: "https://pic/j.png" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno Lima", profilePicUrl: "https://pic/b.png" };

describe("Perfil do Membro", () => {
  test("nome e foto vêm da tailnet na primeira entrada, para o primeiro Admin e para quem é aprovado", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });

    const me = await (await t.as(juliana).get("/api/me")).json();
    const members = await (await t.as(bruno).get("/api/members")).json();

    expect(me).toMatchObject({ displayName: "Juliana Prado", profilePicUrl: "https://pic/j.png" });
    expect(members).toEqual([
      expect.objectContaining({ displayName: "Bruno Lima", profilePicUrl: "https://pic/b.png" }),
      expect.objectContaining({ displayName: "Juliana Prado", profilePicUrl: "https://pic/j.png" }),
    ]);
  });

  test("sem foto na tailnet, o Membro fica sem foto", async () => {
    const t = await testApp();

    const me = await (await t.as({ id: "1001", name: "Juliana" }).get("/api/me")).json();

    expect(me.profilePicUrl).toBeNull();
  });

  test("o Membro edita o nome, e a tailnet não o sobrescreve nas entradas seguintes", async () => {
    const t = await testApp();
    await t.as(juliana).get("/api/me");

    const res = await t.as(juliana).patch("/api/me", { displayName: "  Ju  " });
    const depois = await t.as({ ...juliana, name: "Juliana P. (novo nome na tailnet)" }).get("/api/me");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayName: "Ju" });
    expect(await depois.json()).toMatchObject({ displayName: "Ju" });
  });

  test("a edição chega na hora a todo Membro e às outras abas de quem editou", async () => {
    const t = await testApp();
    const me = await t.addMember(bruno, { by: juliana });
    const abaDoBruno = await t.socket(bruno, "aba do Bruno");
    const outraAbaDoBruno = await t.socket(bruno, "outra aba do Bruno");
    const abaDaJuliana = await t.socket(juliana, "aba da Juliana");

    await t.as(bruno).patch("/api/me", { displayName: "Bruninho" });

    for (const aba of [abaDoBruno, outraAbaDoBruno, abaDaJuliana]) {
      const { member } = await aba.next("member.updated");
      expect(member).toMatchObject({ id: me.id, displayName: "Bruninho", profilePicUrl: "https://pic/b.png" });
    }
  });

  test('o "sobre mim" é opcional: começa vazio, o Membro escreve, os outros veem, e pode apagar', async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });
    const antes = await (await t.as(bruno).get("/api/me")).json();

    await t.as(bruno).patch("/api/me", { about: "  Cuido do financeiro.  " });
    const visto = (await (await t.as(juliana).get("/api/members")).json()).find(
      (m: { displayName: string }) => m.displayName === "Bruno Lima",
    );
    const apagado = await (await t.as(bruno).patch("/api/me", { about: "" })).json();
    const longo = await t.as(bruno).patch("/api/me", { about: "x".repeat(501) });

    expect(antes.about).toBe("");
    expect(visto.about).toBe("Cuido do financeiro.");
    expect(apagado.about).toBe("");
    expect(longo.status).toBe(400);
  });

  test("nome vazio ou longo demais é recusado com o motivo", async () => {
    const t = await testApp();
    const ju = t.as(juliana);

    const vazio = await ju.patch("/api/me", { displayName: "   " });
    const longo = await ju.patch("/api/me", { displayName: "x".repeat(81) });

    expect(vazio.status).toBe(400);
    expect(await vazio.json()).toEqual({ error: "invalid_input", message: "Dê um nome a você." });
    expect(longo.status).toBe(400);
    expect((await (await ju.get("/api/me")).json()).displayName).toBe("Juliana Prado");
  });
});

describe("Identificador de Menção", () => {
  test("cada Membro ganha um identificador a partir do nome da tailnet, sem acento e em minúsculas", async () => {
    const t = await testApp();
    await t.addMember({ id: "2002", name: "João Câmara" }, { by: juliana });

    const me = await (await t.as(juliana).get("/api/me")).json();
    const members = await (await t.as(juliana).get("/api/members")).json();

    expect(me.handle).toBe("juliana");
    expect(members.map((m: { handle: string }) => m.handle).sort()).toEqual(["joao", "juliana"]);
  });

  test("quando colide, ganha sufixo: @rafael, @rafael2, @rafael3", async () => {
    const t = await testApp();
    const admin = { id: "1000", name: "Rafael Oliveira" };
    const segundo = await t.addMember({ id: "2002", name: "Rafael Souza" }, { by: admin });
    const terceiro = await t.addMember({ id: "3003", name: "rafael" }, { by: admin });

    const primeiro = await (await t.as(admin).get("/api/me")).json();

    expect([primeiro.handle, segundo.handle, terceiro.handle]).toEqual(["rafael", "rafael2", "rafael3"]);
  });

  test("sem letra aproveitável no nome, o identificador vem do login", async () => {
    const t = await testApp();

    const me = await (await t.as({ id: "1001", login: "ju.prado@exemplo.com", name: "🙂" }).get("/api/me")).json();

    expect(me.handle).toBe("juprado");
  });

  test("o Membro edita o identificador; o antigo fica livre e os outros veem a troca", async () => {
    const t = await testApp();
    const brunoMe = await t.addMember(bruno, { by: juliana });
    const aba = await t.socket(juliana, "aba da Juliana");

    const res = await t.as(bruno).patch("/api/me", { handle: "@Bru_Lima" });
    const { member } = await aba.next("member.updated");
    const carla = await t.addMember({ id: "3003", name: "Bruno Costa" }, { by: juliana });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "bru_lima" });
    expect(member).toMatchObject({ id: brunoMe.id, handle: "bru_lima" });
    expect(carla.handle).toBe("bruno");
  });

  test("editar para um identificador que já é de outro é recusado, e o seu fica como estava", async () => {
    const t = await testApp();
    await t.addMember(bruno, { by: juliana });

    const res = await t.as(bruno).patch("/api/me", { handle: "Juliana", displayName: "Bruninho" });
    const me = await (await t.as(bruno).get("/api/me")).json();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "handle_taken", message: "@juliana já é de outra pessoa ou Agente." });
    expect(me).toMatchObject({ handle: "bruno", displayName: "Bruno Lima" });
  });

  test("identificador com espaço, pontuação, vazio ou longo demais é recusado", async () => {
    const t = await testApp();
    const ju = t.as(juliana);

    const recusados = await Promise.all(
      ["ju prado", "ju.prado", "", "@", "x".repeat(33)].map(
        async (handle) => (await ju.patch("/api/me", { handle })).status,
      ),
    );
    const mesmo = await ju.patch("/api/me", { handle: "JULIANA" });

    expect(recusados).toEqual([400, 400, 400, 400, 400]);
    expect(mesmo.status).toBe(200);
    expect((await mesmo.json()).handle).toBe("juliana");
  });
});
