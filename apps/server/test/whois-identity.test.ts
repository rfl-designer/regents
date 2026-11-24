import { describe, expect, test } from "bun:test";
import { createWhoisIdentity, IdentityUnavailableError } from "../src/identity/whois";
import { fakeLocalApi, recordedWhois } from "./fake-localapi";
import { fakeClock, testApp } from "./harness";

/** Uma requisição como o Serve a entrega ao app: o IP tailnet do peer no `X-Forwarded-For`. */
function fromServe(ip: string | undefined, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://app:3000/api/me", { headers });
}

describe("adaptador whois da LocalAPI (contrato, resposta gravada)", () => {
  test("pessoa da tailnet: o Membro é o UserProfile.ID como texto, sem perder precisão", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    const who = await identity.whoAmI(fromServe("100.101.102.103"));

    // 9007199254740993 = 2^53 + 1: um JSON.parse comum devolveria ...992.
    expect(who).toEqual({
      kind: "user",
      userId: "9007199254740993",
      login: "juliana@exemplo.com",
      displayName: "Juliana Souza",
      profilePicUrl: "https://exemplo.com/juliana.png",
      device: "Notebook da Juliana",
      sharee: false,
    });
    expect(localApi.calls).toEqual([{ addr: "100.101.102.103", host: "local-tailscaled.sock" }]);
  });

  test("pessoa de outra tailnet (share do nó) vem marcada pelo ShareeNode", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.90.80.70", recordedWhois("whois-sharee"));
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    const who = await identity.whoAmI(fromServe("100.90.80.70"));

    expect(who).toEqual({
      kind: "user",
      userId: "51234567890123",
      login: "bruno@outra-tailnet.com",
      displayName: "Bruno Lima",
      device: "Celular do Bruno",
      sharee: true,
    });
  });

  test("sem Hostinfo.Hostname, o aparelho é o ComputedName do nó", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro").replace('"Hostname": "Notebook da Juliana",', ""));
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    expect(await identity.whoAmI(fromServe("100.101.102.103"))).toMatchObject({ device: "notebook-da-juliana" });
  });

  test("nó com tag não tem identidade, mesmo com o UserProfile tagged-devices", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.70.60.50", recordedWhois("whois-tag"));
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    expect(await identity.whoAmI(fromServe("100.70.60.50"))).toEqual({ kind: "none", reason: "tagged" });
  });

  test("IP que a tailnet não conhece (404 da LocalAPI) não tem identidade", async () => {
    const localApi = fakeLocalApi();
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    expect(await identity.whoAmI(fromServe("198.51.100.7"))).toEqual({ kind: "none", reason: "unknown" });
    expect(localApi.calls).toHaveLength(1);
  });

  test("requisição de Funnel não tem identidade e nem chega a perguntar à LocalAPI", async () => {
    const localApi = fakeLocalApi();
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    const who = await identity.whoAmI(fromServe("203.0.113.9", { "tailscale-funnel-request": "?1" }));

    expect(who).toEqual({ kind: "none", reason: "funnel" });
    expect(localApi.calls).toEqual([]);
  });

  test("sem X-Forwarded-For (não veio pelo Serve) não há identidade", async () => {
    const localApi = fakeLocalApi();
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    expect(await identity.whoAmI(fromServe(undefined))).toEqual({ kind: "none", reason: "unknown" });
    expect(localApi.calls).toEqual([]);
  });

  test("headers de identidade forjados não valem nada: quem diz é o whois", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    const who = await identity.whoAmI(
      fromServe("100.101.102.103", { "tailscale-user-login": "admin@exemplo.com", "tailscale-user-name": "Admin" }),
    );

    expect(who).toMatchObject({ kind: "user", userId: "9007199254740993", login: "juliana@exemplo.com" });
  });

  test("LocalAPI fora do ar é falha, não 'sem identidade'", async () => {
    const localApi = fakeLocalApi();
    localApi.stop();
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    await expect(identity.whoAmI(fromServe("100.101.102.103"))).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  test("LocalAPI respondendo erro ou um corpo sem UserProfile.ID é falha", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.1.1.1", "boom\n", 500);
    localApi.answer("100.2.2.2", '{"Node":{},"UserProfile":{}}');
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    await expect(identity.whoAmI(fromServe("100.1.1.1"))).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(identity.whoAmI(fromServe("100.2.2.2"))).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  test("uma pergunta à LocalAPI por sessão: o mesmo peer não é perguntado de novo por 1 minuto", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));
    localApi.answer("100.90.80.70", recordedWhois("whois-sharee"));
    const clock = fakeClock();
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock });

    await identity.whoAmI(fromServe("100.101.102.103"));
    clock.advance(59_000);
    const again = await identity.whoAmI(fromServe("100.101.102.103"));
    await identity.whoAmI(fromServe("100.90.80.70"));
    expect(again).toMatchObject({ userId: "9007199254740993" });
    expect(localApi.calls.map((c) => c.addr)).toEqual(["100.101.102.103", "100.90.80.70"]);

    clock.advance(1_000);
    await identity.whoAmI(fromServe("100.101.102.103"));
    expect(localApi.calls.map((c) => c.addr)).toEqual(["100.101.102.103", "100.90.80.70", "100.101.102.103"]);
  });

  test("uma falha da LocalAPI não fica guardada: a próxima requisição pergunta de novo", async () => {
    const localApi = fakeLocalApi();
    localApi.answer("100.101.102.103", "starting\n", 503);
    const identity = createWhoisIdentity({ socketPath: localApi.socketPath, clock: fakeClock() });

    await expect(identity.whoAmI(fromServe("100.101.102.103"))).rejects.toBeInstanceOf(IdentityUnavailableError);
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));

    expect(await identity.whoAmI(fromServe("100.101.102.103"))).toMatchObject({ kind: "user" });
  });
});

describe("entrada pela tailnet: o app com o whois de verdade", () => {
  async function tailnetApp() {
    const localApi = fakeLocalApi();
    const clock = fakeClock();
    const t = await testApp({ clock, identity: createWhoisIdentity({ socketPath: localApi.socketPath, clock }) });
    return { t, localApi };
  }
  const juliana = { "x-forwarded-for": "100.101.102.103" };

  test("o primeiro peer vira Admin, e outro ID que só difere depois de 2^53 é outra pessoa", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));
    // 9007199254740992 e 9007199254740993 viram o mesmo número num JSON.parse comum.
    localApi.answer(
      "100.101.102.104",
      recordedWhois("whois-membro").replaceAll("9007199254740993", "9007199254740992").replace("juliana@", "outra@"),
    );

    const me = await t.request(juliana).get("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      login: "juliana@exemplo.com",
      displayName: "Juliana Souza",
      role: "admin",
    });

    const other = await t.request({ "x-forwarded-for": "100.101.102.104" }).get("/api/me");
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "not_a_member" });
  });

  test("nó com tag recebe 403 sem identidade, com o motivo", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.answer("100.70.60.50", recordedWhois("whois-tag"));

    const res = await t.request({ "x-forwarded-for": "100.70.60.50" }).get("/api/me");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_identity", reason: "tagged" });
  });

  test("o WebSocket pergunta ao whois no upgrade e a conexão fica com aquele Membro", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));

    const aba = await t.socketWith(juliana, "aba da Juliana");

    expect(aba.received()[0]).toMatchObject({ type: "ready", me: { login: "juliana@exemplo.com", role: "admin" } });
    expect(localApi.calls).toHaveLength(1);
  });

  test("com a LocalAPI fora do ar, a API e o upgrade respondem 503 identity_unavailable", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.stop();

    const res = await t.request(juliana).get("/api/me");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "identity_unavailable" });
    expect((await t.upgradeWith(juliana)).status).toBe(503);
    // A página do PWA também pergunta ao whois (#16): 503, não a página de "sem identidade".
    expect((await t.request(juliana).get("/")).status).toBe(503);
  });

  test("o Pedido de entrada leva o aparelho, a foto e o sharee que o whois deu", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.answer("100.101.102.103", recordedWhois("whois-membro"));
    localApi.answer("100.90.80.70", recordedWhois("whois-sharee"));
    const bruno = { "x-forwarded-for": "100.90.80.70" };
    expect((await t.request(juliana).get("/api/me")).status).toBe(200);

    expect([200, 201]).toContain((await t.request(bruno).post("/api/join-request")).status);

    const pedidos = await (await t.request(juliana).get("/api/join-requests")).json();
    expect(pedidos).toEqual([
      expect.objectContaining({
        login: "bruno@outra-tailnet.com",
        displayName: "Bruno Lima",
        device: "Celular do Bruno",
        profilePicUrl: null,
        sharee: true,
      }),
    ]);
  });

  test("/api/health responde sem perguntar ao whois (é o healthcheck do container)", async () => {
    const { t, localApi } = await tailnetApp();
    localApi.stop();

    expect((await t.request({}).get("/api/health")).status).toBe(200);
  });
});
