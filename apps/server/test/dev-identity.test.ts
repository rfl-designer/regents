import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createDevIdentity } from "../src/identity/dev";
import { fakeClock, fakeIdentity, testDb } from "./harness";

async function devApp() {
  const { db } = await testDb();
  const dev = createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
  return createApp({ db, clock: fakeClock(), identity: dev.identity, devRoutes: dev.routes }).app;
}

describe("identidade de desenvolvimento (bun run dev)", () => {
  test("sem escolher ninguém, quem abre é a pessoa padrão de dev", async () => {
    const app = await devApp();

    const me = await (await app.request("/api/me")).json();

    expect(me).toMatchObject({ displayName: "Pessoa Dev", role: "admin" });
  });

  test("/dev/como/:id troca a pessoa por cookie, e cada aba pode ser alguém", async () => {
    const app = await devApp();
    await app.request("/api/me"); // a pessoa padrão vira Admin

    const res = await app.request("/dev/como/2002?nome=Bruno%20Lima");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ error: "not_a_member" });
  });

  test("/dev/sem-identidade/:motivo faz a aba chegar sem identidade, como um nó com tag ou o Funnel", async () => {
    const app = await devApp();

    const res = await app.request("/dev/sem-identidade/funnel");
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

    expect(res.status).toBe(302);
    const page = await app.request("/", { headers: { cookie } });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("internet aberta (Funnel)");
    expect(await (await app.request("/api/me", { headers: { cookie } })).json()).toEqual({
      error: "no_identity",
      reason: "funnel",
    });
  });

  test("a pessoa de dev entra pelo Pedido de entrada como qualquer outra", async () => {
    const app = await devApp();
    await app.request("/api/me"); // a pessoa padrão vira Admin
    const bruno = { cookie: `dev_user=${encodeURIComponent(JSON.stringify({ id: "2002", name: "Bruno" }))}` };

    const pedido = await (await app.request("/api/join-request", { method: "POST", headers: bruno })).json();
    await app.request(`/api/join-requests/${pedido.id}/approve`, { method: "POST" });

    expect(await (await app.request("/api/me", { headers: bruno })).json()).toMatchObject({
      displayName: "Bruno",
      role: "member",
    });
  });

  test("com outra porta de identidade, a rota /dev não existe", async () => {
    const { db } = await testDb();
    const { app } = createApp({ db, clock: fakeClock(), identity: fakeIdentity });

    expect((await app.request("/dev/como/1001")).status).toBe(404);
  });
});
