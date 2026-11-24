/**
 * Arnês de testes do servidor (Spec, "Testing Decisions").
 *
 * Os testes falam com o app pelo HTTP (`app.request`), com a identidade falsa,
 * o PGlite com as migrações reais e o relógio injetável. Nada de olhar tabela:
 * o que se verifica é o que um cliente veria.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  type AccountDto,
  EVENTS_PATH,
  type JoinRequestDto,
  type MeDto,
  type ServerEvent,
  type ServerEventOf,
  type ServerEventType,
} from "@shearim/contracts";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type AppDeps, createApp } from "../src/app";
import type { Clock } from "../src/clock";
import { type Db, migrationsFolder, schema } from "../src/db/client";
import type { Identity, IdentityPort, NoIdentityReason } from "../src/identity/port";
import { secretBox } from "../src/secrets";
import { FAKE_LOGIN_CODE, type FakeClaude, fakeClaude } from "./fake-claude";
import { startFakeMessagesApi } from "./fakes/messages-api";
import { type Delivery, type FakeSubscription, type PushCollector, startPushCollector } from "./fakes/push-collector";

// ---------- limpeza automática (o preload roda `runCleanups` no afterEach) ----------

const cleanups: (() => unknown)[] = [];
export function onCleanup(fn: () => unknown) {
  cleanups.push(fn);
}
export async function runCleanups() {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

// ---------- banco: PGlite com as migrações reais ----------

let template: Promise<Blob> | undefined;
/** Migra um PGlite uma vez por processo e devolve o dump do diretório de dados. */
function migratedTemplate() {
  template ??= (async () => {
    const client = new PGlite();
    await migrate(drizzle(client, { schema, casing: "snake_case" }), { migrationsFolder });
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return template;
}

/** Banco novo e já migrado para um teste. Fecha sozinho no fim do teste. */
export async function testDb() {
  const client = new PGlite({ loadDataDir: await migratedTemplate() });
  await client.waitReady;
  onCleanup(() => client.close());
  const db: Db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client };
}

// ---------- relógio ----------

export interface FakeClock extends Clock {
  /** Anda o relógio e dispara, em ordem, os `after` que venceram no caminho. */
  advance(ms: number): void;
  set(at: Date | string): void;
}

export function fakeClock(start: Date | string = "2026-11-24T12:00:00.000Z"): FakeClock {
  let t = new Date(start).getTime();
  let pending: { at: number; seq: number; fn: () => void }[] = [];
  let seq = 0;
  const fire = () => {
    for (;;) {
      const due = pending.filter((p) => p.at <= t).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) return;
      pending = pending.filter((p) => p !== due);
      due.fn();
    }
  };
  return {
    now: () => new Date(t),
    after(ms, fn) {
      const timer = { at: t + ms, seq: seq++, fn };
      pending.push(timer);
      return () => {
        pending = pending.filter((p) => p !== timer);
      };
    },
    advance: (ms) => {
      t += ms;
      fire();
    },
    set: (at) => {
      t = new Date(at).getTime();
      fire();
    },
  };
}

// ---------- esperar o que acontece fora da requisição ----------

/**
 * Repete `probe` (pela borda, ex. um GET) até ele devolver algo, ou falha depois de `timeoutMs`
 * com `label`. Para o que acontece sem conexão aberta para ouvir (ex. logo depois de um reinício).
 */
export async function eventually<T>(
  label: string,
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`não aconteceu em ${timeoutMs} ms: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------- identidade falsa ----------

/** Quem o teste diz que é. `id` é o `UserProfile.ID` da tailnet. */
export interface Person {
  id: string;
  login?: string;
  name?: string;
  sharee?: boolean;
  /** Nome do aparelho que a tailnet informa. */
  device?: string;
  profilePicUrl?: string;
}

const H = {
  user: "x-test-user",
  login: "x-test-login",
  name: "x-test-name",
  sharee: "x-test-sharee",
  device: "x-test-device",
  pic: "x-test-profile-pic",
  none: "x-test-no-identity",
} as const;

/** Headers que a identidade falsa entende. Úteis também para `fetch`/WebSocket num `Bun.serve` real. */
export function identityHeaders(who: Person | { none: NoIdentityReason }): Record<string, string> {
  if ("none" in who) return { [H.none]: who.none };
  const h: Record<string, string> = {
    [H.user]: who.id,
    [H.login]: who.login ?? `${who.id}@exemplo.com`,
    [H.name]: encodeURIComponent(who.name ?? `Pessoa ${who.id}`),
  };
  if (who.sharee) h[H.sharee] = "1";
  if (who.device) h[H.device] = encodeURIComponent(who.device);
  if (who.profilePicUrl) h[H.pic] = who.profilePicUrl;
  return h;
}

/**
 * Porta de identidade falsa: lê headers de teste no lugar do `whois`.
 * Sem header nenhum, não há identidade (como um nó com tag).
 */
export const fakeIdentity: IdentityPort = {
  async whoAmI(req): Promise<Identity> {
    const none = req.headers.get(H.none) as NoIdentityReason | null;
    const userId = req.headers.get(H.user);
    if (none || !userId) return { kind: "none", reason: none ?? "tagged" };
    return {
      kind: "user",
      userId,
      login: req.headers.get(H.login) ?? `${userId}@exemplo.com`,
      displayName: decodeURIComponent(req.headers.get(H.name) ?? userId),
      sharee: req.headers.has(H.sharee),
      device: optional(req.headers.get(H.device), decodeURIComponent),
      profilePicUrl: optional(req.headers.get(H.pic), (v) => v),
    };
  },
};

function optional<T>(v: string | null, f: (v: string) => T): T | undefined {
  return v === null ? undefined : f(v);
}

// ---------- WebSocket de eventos, como um cliente ----------

/** Quanto `next` espera por padrão. Folgado para a máquina carregada; provar ausência usa o evento-sentinela, não a espera. */
const EVENT_TIMEOUT_MS = 5_000;

/** Uma conexão aberta no WebSocket de eventos, com a fila do que chegou. */
export interface EventSocket {
  /**
   * O próximo evento desse tipo ainda não lido (os de outros tipos ficam na fila).
   * Falha depois de `timeoutMs` dizendo o que chegou no lugar.
   */
  next<T extends ServerEventType>(type: T, opts?: { timeoutMs?: number }): Promise<ServerEventOf<T>>;
  /** Tudo o que chegou até agora, na ordem, inclusive o que `next` já leu. */
  received(): ServerEvent[];
  /** O `connectionId` do `ready`: é com ele que a Presença diz o que esta conexão tem à vista. */
  connectionId: string;
  close(): Promise<void>;
}

/**
 * Abre o WebSocket com estes headers e só devolve depois do `ready`:
 * a partir daí, todo evento publicado para essa conexão chega a ela.
 */
async function openEventSocket(url: string, headers: Record<string, string>, label: string): Promise<EventSocket> {
  // O WebSocket do Bun aceita `headers` no construtor (é assim que a identidade falsa chega
  // no handshake); os tipos do DOM, que o tsconfig inclui, só conhecem `protocols`.
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const all: ServerEvent[] = [];
  const unread: ServerEvent[] = [];
  const waiters: { type: ServerEventType; resolve: (e: ServerEvent) => void }[] = [];
  let closed: Promise<void> | undefined;

  const deliver = () => {
    for (const w of [...waiters]) {
      const i = unread.findIndex((e) => e.type === w.type);
      if (i < 0) continue;
      const [event] = unread.splice(i, 1);
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(event!);
    }
  };
  ws.addEventListener("message", (e) => {
    const event = JSON.parse(String(e.data)) as ServerEvent;
    all.push(event);
    unread.push(event);
    deliver();
  });

  const socket: EventSocket = {
    next(type, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? EVENT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve: (e: ServerEvent) => {
            clearTimeout(timer);
            resolve(e as ServerEventOf<typeof type>);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          const got = all.map((e) => e.type).join(", ") || "nenhum";
          reject(new Error(`${label}: nenhum evento "${type}" em ${timeoutMs} ms (chegaram: ${got})`));
        }, timeoutMs);
        waiters.push(waiter);
        deliver();
      });
    },
    received: () => [...all],
    get connectionId() {
      const ready = all.find((e) => e.type === "ready");
      return ready?.type === "ready" ? ready.connectionId : "";
    },
    close() {
      closed ??= new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.addEventListener("close", () => resolve(), { once: true });
        ws.close();
      });
      return closed;
    },
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: o WebSocket não mandou "ready" em ${EVENT_TIMEOUT_MS} ms`)),
      EVENT_TIMEOUT_MS,
    );
    const done = (err?: Error) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      err ? reject(err) : resolve();
    };
    const onMessage = () => all.some((e) => e.type === "ready") && done();
    const onClose = (e: CloseEvent) =>
      done(new Error(`${label}: o WebSocket fechou antes do "ready" (código ${e.code}); o upgrade foi recusado?`));
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
  return socket;
}

/** Os headers de um upgrade de WebSocket, para pedir um sem abrir a conexão. */
const UPGRADE_HEADERS = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

// ---------- app de teste ----------

export interface Client {
  get(path: string, init?: RequestInit): Promise<Response>;
  delete(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export type TestApp = Awaited<ReturnType<typeof testApp>>;

/**
 * O `fake-claude` e uma pasta-raiz de Contas descartáveis, para quem monta o
 * `createApp` à mão. Somem no fim do teste.
 */
export function throwawayAccounts() {
  const claude = fakeClaude();
  const root = mkdtempSync(join(tmpdir(), "shearim-contas-"));
  onCleanup(() => {
    claude.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  // Limites curtos no encerramento do `claude -p`: um processo que ignora sinais não segura o teste.
  return { claude, config: { claudeBin: claude.bin, root, stopGrace: { sigintMs: 300, sigtermMs: 300 } } };
}

/** Admin padrão do `addMember` quando o teste não diz quem aprova. */
export const DEFAULT_ADMIN: Person = { id: "1000", login: "admin@exemplo.com", name: "Admin" };

/** Falha de arranjo com o que o servidor respondeu, para não parecer falha do teste. */
async function expectStatus(res: Response, ok: number[], what: string) {
  if (ok.includes(res.status)) return res;
  throw new Error(`addMember: ${what} respondeu ${res.status}: ${await res.text()}`);
}

/** A Messages API falsa, que fecha sozinha no fim do teste. */
export async function fakeMessagesApi() {
  const api = await startFakeMessagesApi();
  onCleanup(() => api.stop());
  return api;
}

/** O coletor de push (o dublê dos push services), que fecha sozinho no fim do teste. */
export async function pushCollector() {
  const collector = await startPushCollector();
  onCleanup(() => collector.stop());
  return collector;
}

/** Um aparelho de uma pessoa com o push ligado: o que o teste lê do coletor é só dele. */
export interface PushDevice {
  /** O id que o PWA gerou para este aparelho. */
  deviceId: string;
  subscription: FakeSubscription;
  /** O próximo push que chegou a este aparelho. */
  next(opts?: { timeoutMs?: number }): Promise<Delivery>;
  /** A partir de agora o push service responde `status` para este aparelho (ex.: `410`). */
  respond(status: number): void;
}

/** O `sub` do VAPID nos testes. */
export const TEST_VAPID_CONTACT = "mailto:contato@exemplo.com";

/**
 * Um app novo com banco vazio e migrado, identidade falsa, relógio parado,
 * o `fake-claude` no lugar do binário `claude`, uma pasta-raiz de Contas descartável,
 * uma chave mestra aleatória e a Messages API falsa (`t.anthropic`) no lugar da Anthropic.
 * A fila de execuções já está rodando.
 * `identity` troca a porta (o teste do adaptador `whois` usa a de verdade); aí `as`,
 * `anonymous`, `socket` e `addMember` não servem, e a requisição leva os headers que o
 * Serve poria (`request`/`socketWith`/`upgradeWith`).
 */
export async function testApp(
  opts: {
    clock?: FakeClock;
    identity?: IdentityPort;
    hooks?: AppDeps["hooks"];
    keyBrain?: AppDeps["keyBrain"];
    /** Outro banco já migrado (ex.: um PGlite em disco, para os comandos `restore` e `migrate`). */
    db?: Db;
    /** A chave mestra de `./secrets` (padrão: uma aleatória). Para subir de novo com a mesma. */
    masterKey?: Uint8Array;
    /** A versão e o vencimento da chave do nó da seção Instalação. */
    installation?: AppDeps["installation"];
  } = {},
) {
  const db = opts.db ?? (await testDb()).db;
  const clock = opts.clock ?? fakeClock();
  const { claude, config } = throwawayAccounts();
  const accountsRoot = config.root;
  const anthropic = await fakeMessagesApi();
  const push = await pushCollector();
  const secrets = await secretBox(opts.masterKey ?? crypto.getRandomValues(new Uint8Array(32)));

  async function boot() {
    const built = createApp({
      db,
      identity: opts.identity ?? fakeIdentity,
      clock,
      hooks: opts.hooks,
      accounts: config,
      secrets,
      anthropicBaseUrl: anthropic.url,
      keyBrain: opts.keyBrain,
      push: { contact: TEST_VAPID_CONTACT, agent: push.agent },
      installation: opts.installation,
    });
    await built.start();
    return built;
  }
  let current = await boot();
  let down = false;
  async function shutdown() {
    if (down) return;
    down = true;
    await current.executions.stop();
    await current.close();
  }
  onCleanup(shutdown);

  // O WebSocket precisa de um servidor de verdade; ele só sobe quando um teste abre conexão.
  let server: ReturnType<typeof Bun.serve> | undefined;
  function origin() {
    if (!server) {
      const { app, websocket } = current;
      const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
      server = s;
      onCleanup(() => s.stop(true));
    }
    return `127.0.0.1:${server.port}`;
  }

  function client(extra: Record<string, string>): Client {
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return Promise.resolve(current.app.request(path, { ...init, headers }));
    };
    const send = (method: string) => (path: string, body?: unknown, init?: RequestInit) =>
      request(path, {
        ...init,
        method,
        headers: { "content-type": "application/json", ...init?.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return {
      request,
      get: (path, init) => request(path, { ...init, method: "GET" }),
      delete: (path, init) => request(path, { ...init, method: "DELETE" }),
      post: send("POST"),
      put: send("PUT"),
      patch: send("PATCH"),
    };
  }

  return {
    get app() {
      return current.app;
    },
    db,
    clock,
    /** A Messages API falsa que o app usa pela Chave do Workspace. */
    anthropic,
    /** O coletor de push: tudo o que o app mandou aos push services. */
    push: push as PushCollector,
    /**
     * Liga o push num aparelho dessa pessoa, como o PWA faria depois do "Ligar notificações":
     * uma inscrição nova no coletor, entregue ao servidor por `PUT /api/push/subscriptions/:aparelho`.
     */
    async pushDevice(who: Person, deviceId: string = crypto.randomUUID()): Promise<PushDevice> {
      const subscription = push.subscription();
      const res = await this.as(who).put(`/api/push/subscriptions/${deviceId}`, subscription);
      if (res.status !== 204) throw new Error(`pushDevice: a inscrição respondeu ${res.status}: ${await res.text()}`);
      return {
        deviceId,
        subscription,
        next: (opts) => push.next({ ...opts, endpoint: subscription.endpoint }),
        respond: (status) => push.respond(subscription.endpoint, status),
      };
    },
    /**
     * Reinicia o servidor no mesmo banco: a fila para (o que estava em andamento fica sem
     * processo), as conexões de WebSocket caem e um app novo sobe com a fila rodando.
     */
    /** Para o app (a fila e o que ele deixou rodando), para fechar o banco no meio do teste. */
    shutdown,
    async restart() {
      await current.executions.stop();
      await current.close();
      if (server) {
        const s = server;
        server = undefined;
        await s.stop(true);
      }
      current = await boot();
      down = false;
    },
    /**
     * O dreno do `SIGTERM`: a fila para de pegar trabalho e espera o que está rodando até `ms`
     * (20 s do relógio injetável por padrão). O app continua respondendo; `restart()` sobe outro.
     */
    drain: (ms?: number) => current.executions.drain(ms),
    /** Cliente HTTP como uma pessoa da tailnet. */
    as: (who: Person) => client(identityHeaders(who)),
    /** Cliente HTTP sem identidade (nó com tag, Funnel). */
    anonymous: (reason: NoIdentityReason = "tagged") => client(identityHeaders({ none: reason })),
    /**
     * Abre o WebSocket de eventos como essa pessoa (uma aba do PWA) e espera o `ready`.
     * Fecha sozinho no fim do teste.
     */
    async socket(who: Person, label = `WebSocket de ${who.name ?? who.id}`) {
      const socket = await openEventSocket(`ws://${origin()}${EVENTS_PATH}`, identityHeaders(who), label);
      onCleanup(() => socket.close());
      return socket;
    },
    /** Pede o upgrade do WebSocket sem abrir a conexão; para ver a recusa (`res.status`). */
    upgrade: (who: Person | { none: NoIdentityReason }) =>
      fetch(`http://${origin()}${EVENTS_PATH}`, { headers: { ...UPGRADE_HEADERS, ...identityHeaders(who) } }),
    /** Cliente HTTP com estes headers crus (ex.: o `X-Forwarded-For` do Serve). */
    request: (headers: Record<string, string>) => client(headers),
    /** Como `socket`, mas o handshake leva estes headers crus. */
    async socketWith(headers: Record<string, string>, label = "WebSocket") {
      const socket = await openEventSocket(`ws://${origin()}${EVENTS_PATH}`, headers, label);
      onCleanup(() => socket.close());
      return socket;
    },
    /** Como `upgrade`, com headers crus. */
    upgradeWith: (headers: Record<string, string>) =>
      fetch(`http://${origin()}${EVENTS_PATH}`, { headers: { ...UPGRADE_HEADERS, ...headers } }),
    /** O ponto único de publicação de eventos do app, para testar o envio direto. */
    get events() {
      return current.events;
    },
    /** O dublê do binário `claude`: `t.claude.script({...})` e `t.claude.callsOf("auth login")`. */
    claude: claude as FakeClaude,
    /** Pasta-raiz das Contas (as pastas de `CLAUDE_CONFIG_DIR` ficam debaixo dela). */
    accountsRoot,
    /**
     * Liga a Conta do Claude de `who` pelo fluxo de verdade ("Ligar minha Conta do Claude", o
     * código colado e a validação pelo `fake-claude`, com o roteiro que estiver valendo). Devolve
     * a pasta da Conta (o `CLAUDE_CONFIG_DIR` dos `claude -p` dela). `who` já tem de ser Membro.
     */
    async linkAccount(who: Person): Promise<string> {
      const started = await this.as(who).post("/api/account/linking");
      if (started.status !== 202) throw new Error(`linkAccount: ligar respondeu ${started.status}`);
      await eventually(
        "o login mostrar a URL",
        async () =>
          ((await (await this.as(who).get("/api/account")).json()) as AccountDto).linking?.state === "waiting_code",
        15_000,
      );
      const login = claude.callsOf("auth login").at(-1)!;
      await this.as(who).post("/api/account/linking/code", { code: FAKE_LOGIN_CODE });
      const account = await eventually(
        "a Conta ficar Ligada",
        async () => {
          const a: AccountDto = await (await this.as(who).get("/api/account")).json();
          if (a.linking?.state === "failed") throw new Error(`linkAccount: a ligação falhou: ${a.linking.message}`);
          return a.status.state === "linked" && a.linking === null && a;
        },
        15_000,
      );
      if (!account) throw new Error("linkAccount: a Conta não ficou Ligada");
      return login.env.CLAUDE_CONFIG_DIR!;
    },
    /**
     * Põe `who` no Workspace como Membro pelo fluxo de verdade: `who` cria o Pedido de
     * entrada e `by` (um Admin) aprova. Se a Instalação está vazia, `by` abre o Workspace
     * e vira o primeiro Admin. Sem `by`, aprova o `DEFAULT_ADMIN`; se o teste já abriu
     * o Workspace com outra pessoa, passe essa pessoa em `by`. Devolve o `/api/me` de `who`.
     */
    async addMember(who: Person, opts: { by?: Person } = {}): Promise<MeDto> {
      const admin = opts.by ?? DEFAULT_ADMIN;
      const adminMe: MeDto = await (await expectStatus(await this.as(admin).get("/api/me"), [200], "o Admin")).json();
      if (adminMe.role !== "admin") throw new Error(`addMember: ${admin.id} é Membro, mas não Admin`);
      const created = await expectStatus(await this.as(who).post("/api/join-request"), [200, 201], "o pedido");
      const request: JoinRequestDto = await created.json();
      await expectStatus(await this.as(admin).post(`/api/join-requests/${request.id}/approve`), [200], "a aprovação");
      return (await this.as(who).get("/api/me")).json();
    },
  };
}
