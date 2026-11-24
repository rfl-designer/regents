/**
 * Entrypoint do servidor: `bun src/main.ts serve | migrate | restore <arquivo> [--sem-copia] | backup`.
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
 * - `SHEARIM_BACKUPS_DIR`: `./backups` (padrão `.data/backups`; no compose, `/backups`): os dumps de
 *   antes de migrar e de restaurar, e os backups noturnos do comando `backup`.
 * - `SHEARIM_BACKUP_AT`: a hora do backup noturno, `HH:MM` na hora local do container (padrão 03:00).
 * - `SHEARIM_PG_BIN_DIR`: pasta do `pg_dump`/`pg_restore` (padrão: os do `PATH`).
 * - `SHEARIM_VERSION`: a versão que aparece na seção Instalação (a imagem traz a tag).
 * - `SHEARIM_VAPID_CONTACT`: o `sub` do VAPID (`mailto:` com domínio real; o `deploy/setup.sh`
 *   grava no `.env`). Sem ela, só em desenvolvimento, um `mailto:` de exemplo.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { systemClock } from "./clock";
import { connect, MEMORY } from "./db/connect";
import { createDevIdentity } from "./identity/dev";
import type { IdentityPort } from "./identity/port";
import { createWhoisIdentity } from "./identity/whois";
import { createNightlyBackups } from "./installation/backups";
import {
  type CommandDeps,
  DumpBeforeMigrationError,
  migrateSafely,
  RestoreError,
  restoreFrom,
} from "./installation/commands";
import { migrationState, NewerDatabaseError } from "./installation/migrations";
import { localApiNodeKey, type NodeKeyPort, noNodeKey } from "./installation/node-key";
import { loadMasterKey, secretBox } from "./secrets";

const repoRoot = resolve(import.meta.dir, "../../..");

function fail(message: string): never {
  console.error(`shearim: ${message}`);
  process.exit(1);
}

/** Só desenvolvimento: a Apple recusa o push com `sub` sem domínio real. */
const DEV_VAPID_CONTACT = "mailto:shearim@example.com";

const DEFAULT_TS_SOCKET = "/var/run/tailscale/tailscaled.sock";

function identityFromEnv(): { identity: IdentityPort; routes?: Hono; describe: string; nodeKey: NodeKeyPort } {
  const mode = process.env.SHEARIM_IDENTITY;
  if (mode === "dev") {
    const dev = createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
    return { ...dev, describe: "identidade de desenvolvimento", nodeKey: noNodeKey };
  }
  if (mode === "tailnet") {
    const socketPath = process.env.TS_SOCKET || DEFAULT_TS_SOCKET;
    // Não exige o socket já na subida: o sidecar pode estar subindo. Sem ele, a API responde 503.
    if (!existsSync(socketPath)) console.warn(`shearim: socket do tailscaled ainda não existe em ${socketPath}`);
    return {
      identity: createWhoisIdentity({ socketPath, clock: systemClock }),
      describe: `whois da tailnet em ${socketPath}`,
      nodeKey: localApiNodeKey({ socketPath }),
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

/** `./backups`: os dumps de antes da migração e os backups noturnos. No compose, `/backups`. */
const backupsDir = resolve(process.env.SHEARIM_BACKUPS_DIR || resolve(repoRoot, ".data/backups"));

function commandDeps(conn: ReturnType<typeof connect>): CommandDeps {
  return { conn, clock: systemClock, backupsDir, log: (line) => console.log(`shearim: ${line}`) };
}

/** As migrações do jeito seguro; um banco de versão mais nova encerra com a explicação. */
async function migrateOrFail(conn: ReturnType<typeof connect>) {
  try {
    await migrateSafely(commandDeps(conn));
  } catch (err) {
    if (!(err instanceof NewerDatabaseError || err instanceof DumpBeforeMigrationError)) throw err;
    await conn.close();
    fail(err.message);
  }
}

/**
 * O serviço `backup` do compose: espera o app deixar o banco em dia com as migrações e faz um
 * `pg_dump` por noite (às `SHEARIM_BACKUP_AT`, padrão 03:00, na hora local do container) em
 * `./backups`, guardando 14 dias. No `SIGTERM`, espera o backup em andamento terminar.
 */
async function nightlyBackups(conn: ReturnType<typeof connect>) {
  const [hour, minute] = (process.env.SHEARIM_BACKUP_AT || "03:00").split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! > 23 || minute! > 59) {
    fail(`SHEARIM_BACKUP_AT=${process.env.SHEARIM_BACKUP_AT} não é uma hora (HH:MM).`);
  }
  let warned = false;
  for (;;) {
    const state = await migrationState(conn.db);
    if (state.kind === "current") break;
    if (!warned) console.log("shearim: esperando o app aplicar as migrações para começar os backups");
    warned = true;
    await Bun.sleep(10_000);
  }
  const job = createNightlyBackups({
    db: conn.db,
    clock: systemClock,
    dumper: conn.dumper,
    dir: backupsDir,
    at: { hour: hour!, minute: minute! },
    log: (line) => console.log(`shearim: ${line}`),
  });
  mkdirSync(backupsDir, { recursive: true });
  job.start();
  console.log(
    `shearim: backup noturno às ${process.env.SHEARIM_BACKUP_AT || "03:00"} em ${backupsDir} (${conn.describe})`,
  );
  const stop = async () => {
    await job.stop();
    await conn.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main(command: string | undefined) {
  const conn = connect({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_PASSWORD: secretFromFile(process.env.DATABASE_PASSWORD_FILE),
    pgliteDir: pgliteDirFromEnv(process.env.SHEARIM_PGLITE_DIR),
    pgBinDir: process.env.SHEARIM_PG_BIN_DIR || undefined,
  });

  if (command === "migrate") {
    await migrateOrFail(conn);
    console.log(`shearim: migrações aplicadas em ${conn.describe}`);
    await conn.close();
    return;
  }
  if (command === "backup") {
    await nightlyBackups(conn);
    return;
  }
  if (command === "restore") {
    const args = process.argv.slice(3);
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) {
      await conn.close();
      fail("diga qual arquivo restaurar: restore <arquivo> (os backups ficam em ./backups).");
    }
    try {
      await restoreFrom(commandDeps(conn), file, { withCopy: !args.includes("--sem-copia") });
    } catch (err) {
      await conn.close();
      if (err instanceof RestoreError) fail(err.message);
      fail(`a restauração falhou: ${(err as Error).message}`);
    }
    await conn.close();
    return;
  }
  if (command !== "serve") {
    fail(`comando desconhecido: ${command ?? "(nenhum)"}. Use "serve", "migrate" ou "restore <arquivo>".`);
  }

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
  await migrateOrFail(conn);
  const vapidContact = process.env.SHEARIM_VAPID_CONTACT || DEV_VAPID_CONTACT;
  if (!/^(mailto:|https:)/.test(vapidContact)) fail(`SHEARIM_VAPID_CONTACT=${vapidContact} não é mailto: nem https:.`);
  const { app, websocket, executions, push, close } = createApp({
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
    push: { contact: vapidContact },
    // A seção Instalação: a versão (a tag da imagem), o backup e a chave do nó, com os avisos.
    installation: { version: process.env.SHEARIM_VERSION || "dev", watch: true, nodeKey: who.nodeKey },
  });
  // O par VAPID nasce na primeira subida (e daí em diante é sempre o mesmo, guardado no banco).
  await push.ensureKeys();
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
