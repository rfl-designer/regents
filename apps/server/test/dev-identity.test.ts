import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createDevIdentity } from "../src/identity/dev";
import { fakeClock, fakeIdentity, testDb, throwawayAccounts } from "./harness";

async function devApp() {
  const { db } = await testDb();
  const dev = createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
  const accounts = throwawayAccounts().config;
  return createApp({ db, clock: fakeClock(), identity: dev.identity, accounts, devRoutes: dev.routes }).app;
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

  test("com outra porta de identidade, a rota /dev não existe", async () => {
    const { db } = await testDb();
    const { app } = createApp({ db, clock: fakeClock(), identity: fakeIdentity, accounts: throwawayAccounts().config });

    expect((await app.request("/dev/como/1001")).status).toBe(404);
  });
});
