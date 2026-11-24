import { describe, expect, test } from "bun:test";
import { testApp } from "./harness";

describe("Workspace e Membros", () => {
  test("a primeira identidade numa Instalação vazia vira Membro Admin, sem Pedido de entrada", async () => {
    const t = await testApp();
    const juliana = t.as({ id: "1001", login: "juliana@exemplo.com", name: "Juliana" });

    const res = await juliana.get("/api/me");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      displayName: "Juliana",
      login: "juliana@exemplo.com",
      role: "admin",
    });
  });

  test("quem vem de outra tailnet (nó compartilhado) não vira o primeiro Admin: entra por Pedido, e o dono ainda é o Admin", async () => {
    const t = await testApp();

    const sharee = await t.as({ id: "9009", name: "Parente", sharee: true }).get("/api/me");
    const dono = await t.as({ id: "1001", name: "Juliana" }).get("/api/me");

    expect(sharee.status).toBe(403);
    expect(await sharee.json()).toEqual({ error: "not_a_member" });
    expect(await dono.json()).toMatchObject({ role: "admin" });
  });

  test("quem chega depois do primeiro não vira Admin nem Membro sozinho", async () => {
    const t = await testApp();
    await t.as({ id: "1001", name: "Juliana" }).get("/api/me");

    const res = await t.as({ id: "2002", name: "Bruno" }).get("/api/me");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_a_member" });
  });

  // No PGlite as transações já saem em série; o teste fixa o comportamento, e o lock
  // em `createApp` é o que o garante no Postgres de verdade, com várias conexões.
  test("duas pessoas chegando juntas numa Instalação vazia: só uma vira Admin", async () => {
    const t = await testApp();

    const [a, b] = await Promise.all([t.as({ id: "1001" }).get("/api/me"), t.as({ id: "2002" }).get("/api/me")]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
  });

  test("o Membro é amarrado ao UserProfile.ID, e não ao login", async () => {
    const t = await testApp();
    const first = await (await t.as({ id: "1001", login: "juliana@antigo.com" }).get("/api/me")).json();

    const loginTrocado = await t.as({ id: "1001", login: "juliana@novo.com" }).get("/api/me");
    const mesmoLoginOutroId = await t.as({ id: "3003", login: "juliana@antigo.com" }).get("/api/me");

    expect(loginTrocado.status).toBe(200);
    expect((await loginTrocado.json()).id).toBe(first.id);
    expect(mesmoLoginOutroId.status).toBe(403);
  });

  test("um UserProfile.ID maior que 2^53 é guardado sem perder precisão", async () => {
    const t = await testApp();
    const id = "9007199254740993";
    await t.as({ id }).get("/api/me");

    const outro = await t.as({ id: "9007199254740992" }).get("/api/me");
    const mesmo = await t.as({ id }).get("/api/me");

    expect(outro.status).toBe(403);
    expect(mesmo.status).toBe(200);
  });

  test("uma requisição sem identidade é recusada com o motivo", async () => {
    const t = await testApp();

    const res = await t.anonymous("funnel").get("/api/me");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_identity", reason: "funnel" });
  });
});
