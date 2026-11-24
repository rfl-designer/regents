/**
 * Arnês de testes do servidor (Spec, "Testing Decisions").
 *
 * Os testes falam com o app pelo HTTP (`app.request`), com a identidade falsa,
 * o PGlite com as migrações reais e o relógio injetável. Nada de olhar tabela:
 * o que se verifica é o que um cliente veria.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app";
import type { Clock } from "../src/clock";
import { type Db, migrationsFolder, schema } from "../src/db/client";
import type { Identity, IdentityPort, NoIdentityReason } from "../src/identity/port";

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
  advance(ms: number): void;
  set(at: Date | string): void;
}

export function fakeClock(start: Date | string = "2026-11-24T12:00:00.000Z"): FakeClock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    set: (at) => {
      t = new Date(at).getTime();
    },
  };
}

// ---------- identidade falsa ----------

/** Quem o teste diz que é. `id` é o `UserProfile.ID` da tailnet. */
export interface Person {
  id: string;
  login?: string;
  name?: string;
  sharee?: boolean;
}

const H = {
  user: "x-test-user",
  login: "x-test-login",
  name: "x-test-name",
  sharee: "x-test-sharee",
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
    };
  },
};

// ---------- app de teste ----------

export interface Client {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export type TestApp = Awaited<ReturnType<typeof testApp>>;

/** Um app novo com banco vazio e migrado, identidade falsa e relógio parado. */
export async function testApp(opts: { clock?: FakeClock } = {}) {
  const { db } = await testDb();
  const clock = opts.clock ?? fakeClock();
  const { app } = createApp({ db, identity: fakeIdentity, clock });

  function client(extra: Record<string, string>): Client {
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return Promise.resolve(app.request(path, { ...init, headers }));
    };
    return {
      request,
      get: (path, init) => request(path, { ...init, method: "GET" }),
      post: (path, body, init) =>
        request(path, {
          ...init,
          method: "POST",
          headers: { "content-type": "application/json", ...init?.headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
    };
  }

  return {
    app,
    db,
    clock,
    /** Cliente HTTP como uma pessoa da tailnet. */
    as: (who: Person) => client(identityHeaders(who)),
    /** Cliente HTTP sem identidade (nó com tag, Funnel). */
    anonymous: (reason: NoIdentityReason = "tagged") => client(identityHeaders({ none: reason })),
  };
}
