/**
 * Entrypoint do servidor: `bun src/main.ts serve | migrate`.
 *
 * Variáveis:
 * - `SHEARIM_IDENTITY`: `dev` (cookie, só desenvolvimento). O `whois` da tailnet chega no #37.
 * - `DATABASE_URL`: Postgres. Sem ela, PGlite em `SHEARIM_PGLITE_DIR` (padrão `.data/pglite`;
 *   `memory://` para um banco em memória que some ao parar).
 * - `HOST` (padrão `0.0.0.0`), `PORT` (padrão `3000`).
 * - `SHEARIM_WEB_DIST`: build do PWA servido em `/` (padrão `apps/web/dist`).
 * - `SHEARIM_SECRETS_DIR`: pasta dos segredos, com a chave mestra em `master_key`
 *   (padrão `.data/secrets`; gerada se faltar).
 * - `SHEARIM_ANTHROPIC_BASE_URL`: a Messages API (padrão: a da Anthropic; o e2e usa a falsa).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { systemClock } from "./clock";
import { connect, MEMORY } from "./db/connect";
import { createDevIdentity } from "./identity/dev";
import { loadMasterKey, secretBox } from "./secrets";

const repoRoot = resolve(import.meta.dir, "../../..");

function fail(message: string): never {
  console.error(`shearim: ${message}`);
  process.exit(1);
}

function identityFromEnv() {
  const mode = process.env.SHEARIM_IDENTITY;
  if (mode === "dev") {
    return createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
  }
  fail(
    `SHEARIM_IDENTITY=${mode || "(vazio)"} não é suportado ainda. Use SHEARIM_IDENTITY=dev; ` +
      "a identidade pelo whois da tailnet chega com a Instalação (#37).",
  );
}

/** `memory://` é um PGlite em memória, que some ao parar (o e2e usa para começar do zero). */
function pgliteDirFromEnv(raw: string | undefined) {
  if (raw === MEMORY) return raw;
  return resolve(raw ?? resolve(repoRoot, ".data/pglite"));
}

async function main(command: string | undefined) {
  const conn = connect({
    DATABASE_URL: process.env.DATABASE_URL,
    pgliteDir: pgliteDirFromEnv(process.env.SHEARIM_PGLITE_DIR),
  });

  if (command === "migrate") {
    await conn.migrate();
    console.log(`shearim: migrações aplicadas em ${conn.describe}`);
    await conn.close();
    return;
  }
  if (command !== "serve") fail(`comando desconhecido: ${command ?? "(nenhum)"}. Use "serve" ou "migrate".`);

  const dev = identityFromEnv();
  const secretsDir = resolve(process.env.SHEARIM_SECRETS_DIR ?? resolve(repoRoot, ".data/secrets"));
  const secrets = await secretBox(loadMasterKey(secretsDir));
  await conn.migrate();
  const { app, websocket, executions } = createApp({
    db: conn.db,
    identity: dev.identity,
    clock: systemClock,
    secrets,
    anthropicBaseUrl: process.env.SHEARIM_ANTHROPIC_BASE_URL || undefined,
    devRoutes: dev.routes,
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
  console.log(`shearim: ouvindo em http://${server.hostname}:${server.port} (${conn.describe})`);

  const stop = async () => {
    await executions.stop();
    await server.stop();
    await conn.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main(process.argv[2]);
