/**
 * Entrypoint do servidor: `bun src/main.ts serve | migrate`.
 *
 * Variáveis:
 * - `SHEARIM_IDENTITY`: `tailnet` (o `whois` da LocalAPI pelo socket do tailscaled; é o da
 *   imagem Docker) ou `dev` (cookie, só desenvolvimento).
 * - `TS_SOCKET`: socket do tailscaled (padrão `/var/run/tailscale/tailscaled.sock`, o do compose).
 * - `DATABASE_PASSWORD_FILE`: arquivo com a senha do Postgres (o segredo do compose), à parte da URL.
 * - `DATABASE_URL`: Postgres. Sem ela, PGlite em `SHEARIM_PGLITE_DIR` (padrão `.data/pglite`;
 *   `memory://` para um banco em memória que some ao parar).
 * - `HOST` (padrão `0.0.0.0`), `PORT` (padrão `3000`).
 * - `SHEARIM_WEB_DIST`: build do PWA servido em `/` (padrão `apps/web/dist`).
 * - `SHEARIM_CLAUDE_BIN`: o binário `claude` das Contas (padrão: `claude` do `PATH`).
 * - `SHEARIM_ACCOUNTS_DIR`: pasta-raiz das Contas, fora do backup (padrão `.data/accounts`).
 * - `SHEARIM_MASTER_KEY_FILE`: a chave mestra (32 bytes em hex ou base64), que cifra a Chave do
 *   Workspace. No compose, `/run/secrets/master_key`. Sem a variável, `.data/secrets/master_key`,
 *   gerada se faltar (só desenvolvimento).
 * - `SHEARIM_ANTHROPIC_BASE_URL`: a Messages API (padrão: a da Anthropic; o e2e usa a falsa).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { systemClock } from "./clock";
import { connect, MEMORY } from "./db/connect";
import { createDevIdentity } from "./identity/dev";
import type { IdentityPort } from "./identity/port";
import { createWhoisIdentity } from "./identity/whois";
import { loadMasterKey, secretBox } from "./secrets";

const repoRoot = resolve(import.meta.dir, "../../..");

function fail(message: string): never {
  console.error(`shearim: ${message}`);
  process.exit(1);
}

const DEFAULT_TS_SOCKET = "/var/run/tailscale/tailscaled.sock";

function identityFromEnv(): { identity: IdentityPort; routes?: Hono; describe: string } {
  const mode = process.env.SHEARIM_IDENTITY;
  if (mode === "dev") {
    const dev = createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
    return { ...dev, describe: "identidade de desenvolvimento" };
  }
  if (mode === "tailnet") {
    const socketPath = process.env.TS_SOCKET || DEFAULT_TS_SOCKET;
    // Não exige o socket já na subida: o sidecar pode estar subindo. Sem ele, a API responde 503.
    if (!existsSync(socketPath)) console.warn(`shearim: socket do tailscaled ainda não existe em ${socketPath}`);
    return {
      identity: createWhoisIdentity({ socketPath, clock: systemClock }),
      describe: `whois da tailnet em ${socketPath}`,
    };
  }
  fail(`SHEARIM_IDENTITY=${mode || "(vazio)"} não é suportado. Use "tailnet" (a Instalação) ou "dev".`);
}

function secretFromFile(path: string | undefined) {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    fail(`não consegui ler o segredo em ${path}: ${String(err)}`);
  }
}

/** `memory://` é um PGlite em memória, que some ao parar (o e2e usa para começar do zero). */
function pgliteDirFromEnv(raw: string | undefined) {
  if (raw === MEMORY) return raw;
  return resolve(raw ?? resolve(repoRoot, ".data/pglite"));
}

async function main(command: string | undefined) {
  const conn = connect({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_PASSWORD: secretFromFile(process.env.DATABASE_PASSWORD_FILE),
    pgliteDir: pgliteDirFromEnv(process.env.SHEARIM_PGLITE_DIR),
  });

  if (command === "migrate") {
    await conn.migrate();
    console.log(`shearim: migrações aplicadas em ${conn.describe}`);
    await conn.close();
    return;
  }
  if (command !== "serve") fail(`comando desconhecido: ${command ?? "(nenhum)"}. Use "serve" ou "migrate".`);

  const who = identityFromEnv();
  const masterKeyFile = process.env.SHEARIM_MASTER_KEY_FILE;
  let secrets: Awaited<ReturnType<typeof secretBox>>;
  try {
    secrets = await secretBox(
      masterKeyFile
        ? loadMasterKey(resolve(masterKeyFile))
        : loadMasterKey(resolve(repoRoot, ".data/secrets/master_key"), { generate: true }),
    );
  } catch (err) {
    fail((err as Error).message);
  }
  await conn.migrate();
  const { app, websocket, executions, close } = createApp({
    db: conn.db,
    identity: who.identity,
    clock: systemClock,
    accounts: {
      claudeBin: process.env.SHEARIM_CLAUDE_BIN || Bun.which("claude") || "claude",
      root: resolve(process.env.SHEARIM_ACCOUNTS_DIR ?? resolve(repoRoot, ".data/accounts")),
    },
    secrets,
    anthropicBaseUrl: process.env.SHEARIM_ANTHROPIC_BASE_URL || undefined,
    devRoutes: who.routes,
  });
  executions.start();

  const root = new Hono();
  root.route("/", app);
  // Rota de API desconhecida não cai no fallback do PWA.
  root.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  const webDist = resolve(process.env.SHEARIM_WEB_DIST ?? resolve(repoRoot, "apps/web/dist"));
  if (existsSync(webDist)) {
    root.use("/*", serveStatic({ root: webDist }));
    root.get("/*", serveStatic({ root: webDist, path: "index.html" }));
  }

  const server = Bun.serve({
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    fetch: root.fetch,
    websocket,
  });
  console.log(`shearim: ouvindo em http://${server.hostname}:${server.port} (${conn.describe}; ${who.describe})`);

  // SIGTERM (o `docker compose stop`, com 30 s de folga): dreno, até 20 s para o que está rodando
  // terminar. SIGINT (Ctrl-C no dev): para na hora. O que não terminou vira "o servidor
  // reiniciou" na próxima subida, com a nova tentativa automática.
  let stopping = false;
  const stop = (drain: boolean) => async () => {
    if (stopping) return;
    stopping = true;
    await (drain ? executions.drain() : executions.stop());
    await server.stop();
    await close();
    await conn.close();
    process.exit(0);
  };
  process.on("SIGINT", stop(false));
  process.on("SIGTERM", stop(true));
}

await main(process.argv[2]);
