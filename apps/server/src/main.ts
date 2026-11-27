/**
 * Entrypoint do servidor: `bun src/main.ts serve | migrate | restore <arquivo> [--sem-copia] | backup`.
 *
 * Variáveis (a peça de `./config` lê cada `REGENTS_<sufixo>` e aceita o nome antigo,
 * `SHEARIM_<sufixo>`, como reserva, com um aviso no log):
 * - `REGENTS_IDENTITY`: `tailnet` (o `whois` da LocalAPI pelo socket do tailscaled; é o da
 *   imagem Docker) ou `dev` (cookie, só desenvolvimento).
 * - `TS_SOCKET`: socket do tailscaled (padrão `/var/run/tailscale/tailscaled.sock`, o do compose).
 * - `DATABASE_PASSWORD_FILE`: arquivo com a senha do Postgres (o segredo do compose), à parte da URL.
 * - `DATABASE_URL`: Postgres. Sem ela, PGlite em `REGENTS_PGLITE_DIR` (padrão `.data/pglite`;
 *   `memory://` para um banco em memória que some ao parar).
 * - `HOST` (padrão `0.0.0.0`), `PORT` (padrão `3000`).
 * - `REGENTS_WEB_DIST`: build do PWA servido em `/` (padrão `apps/web/dist`).
 * - `REGENTS_CLAUDE_BIN`: o binário `claude` das Contas (padrão: `claude` do `PATH`).
 * - `REGENTS_ACCOUNTS_DIR`: pasta-raiz das Contas, fora do backup (padrão `.data/accounts`).
 * - `REGENTS_MASTER_KEY_FILE`: a chave mestra (32 bytes em hex ou base64), que cifra a Chave do
 *   Workspace. No compose, `/run/secrets/master_key`. Sem a variável, `.data/secrets/master_key`,
 *   gerada se faltar (só desenvolvimento).
 * - `REGENTS_ANTHROPIC_BASE_URL`: a Messages API (padrão: a da Anthropic; o e2e usa a falsa).
 * - `REGENTS_GITHUB_URL` e `REGENTS_GITHUB_API_URL`: o GitHub (padrão: github.com e api.github.com;
 *   o e2e usa o falso).
 * - `REGENTS_BACKUPS_DIR`: `./backups` (padrão `.data/backups`; no compose, `/backups`): os dumps de
 *   antes de migrar e de restaurar, e os backups noturnos do comando `backup`.
 * - `REGENTS_BACKUP_AT`: a hora do backup noturno, `HH:MM` na hora local do container (padrão 03:00).
 * - `REGENTS_PG_BIN_DIR`: pasta do `pg_dump`/`pg_restore` (padrão: os do `PATH`).
 * - `REGENTS_PROXY_HOST`: o nome do sidecar na rede do compose (padrão `tailscale`). Com
 *   `REGENTS_IDENTITY=tailnet`, só uma conexão vinda dele tem o `X-Forwarded-For` lido.
 * - `REGENTS_VERSION`: a versão que aparece na seção Instalação (a imagem traz a tag).
 * - `REGENTS_VAPID_CONTACT`: o `sub` do VAPID (`mailto:` com domínio real; o `deploy/setup.sh`
 *   grava no `.env`). Sem ela, só em desenvolvimento, um `mailto:` de exemplo.
 * - `REGENTS_MEMORY_MODEL`: o modelo pequeno da extração da Memória (padrão `claude-haiku-5-5`).
 * - `REGENTS_MEMORY_SUMMARY_CHARS`: o orçamento do resumo da Memória que entra em cada resposta,
 *   em caracteres (padrão 4000). Um valor que não é inteiro maior que zero impede o servidor de subir.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { approvalTtlFromEnv } from "./approvals";
import { systemClock } from "./clock";
import { configFrom, PREFIX } from "./config";
import { connect, MEMORY } from "./db/connect";
import { limitsFromEnv } from "./executions";
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
import { memoryFromEnv } from "./memory/extraction";
import { loadMasterKey, secretBox } from "./secrets";
import { toolMaxTurnsFromEnv, toolTimeoutFromEnv } from "./tools/port";
import { wikiFromEnv } from "./wiki/sources";

const repoRoot = resolve(import.meta.dir, "../../..");

function fail(message: string): never {
  console.error(`regents: ${message}`);
  process.exit(1);
}

/** Só desenvolvimento: a Apple recusa o push com `sub` sem domínio real. */
const DEV_VAPID_CONTACT = "mailto:regents@example.com";

/** A configuração da Instalação: `REGENTS_*`, com `SHEARIM_*` como reserva (o aviso sai no log). */
const config = configFrom(process.env, (line) => console.warn(`regents: ${line}`));

/** O valor da configuração `suffix`, ou `undefined`. */
const setting = (suffix: string) => config.read(suffix)?.value;

const DEFAULT_TS_SOCKET = "/var/run/tailscale/tailscaled.sock";

function identityFromEnv(): { identity: IdentityPort; routes?: Hono; describe: string; nodeKey: NodeKeyPort } {
  const read = config.read("IDENTITY");
  const mode = read?.value;
  if (mode === "dev") {
    const dev = createDevIdentity({ defaultUser: { id: "dev-1", name: "Pessoa Dev" } });
    return { ...dev, describe: "identidade de desenvolvimento", nodeKey: noNodeKey };
  }
  if (mode === "tailnet") {
    const socketPath = process.env.TS_SOCKET || DEFAULT_TS_SOCKET;
    // Não exige o socket já na subida: o sidecar pode estar subindo. Sem ele, a API responde 503.
    if (!existsSync(socketPath)) console.warn(`regents: socket do tailscaled ainda não existe em ${socketPath}`);
    return {
      identity: createWhoisIdentity({
        socketPath,
        clock: systemClock,
        proxyHost: setting("PROXY_HOST") || "tailscale",
      }),
      describe: `whois da tailnet em ${socketPath}`,
      nodeKey: localApiNodeKey({ socketPath }),
    };
  }
  fail(
    `${read?.name ?? `${PREFIX}_IDENTITY`}=${mode || "(vazio)"} não é suportado. Use "tailnet" (a Instalação) ou "dev".`,
  );
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
const backupsDir = resolve(setting("BACKUPS_DIR") || resolve(repoRoot, ".data/backups"));

function commandDeps(conn: ReturnType<typeof connect>): CommandDeps {
  return { conn, clock: systemClock, backupsDir, log: (line) => console.log(`regents: ${line}`) };
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
 * `pg_dump` por noite (às `REGENTS_BACKUP_AT`, padrão 03:00, na hora local do container) em
 * `./backups`, guardando 14 dias. No `SIGTERM`, espera o backup em andamento terminar.
 */
async function nightlyBackups(conn: ReturnType<typeof connect>) {
  const backupAt = config.read("BACKUP_AT");
  const at = backupAt?.value || "03:00";
  const [hour, minute] = at.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! > 23 || minute! > 59) {
    fail(`${backupAt?.name ?? `${PREFIX}_BACKUP_AT`}=${at} não é uma hora (HH:MM).`);
  }
  let warned = false;
  for (;;) {
    const state = await migrationState(conn.db);
    if (state.kind === "current") break;
    if (!warned) console.log("regents: esperando o app aplicar as migrações para começar os backups");
    warned = true;
    await Bun.sleep(10_000);
  }
  const job = createNightlyBackups({
    db: conn.db,
    clock: systemClock,
    dumper: conn.dumper,
    dir: backupsDir,
    at: { hour: hour!, minute: minute! },
    log: (line) => console.log(`regents: ${line}`),
  });
  mkdirSync(backupsDir, { recursive: true });
  job.start();
  console.log(`regents: backup noturno às ${at} em ${backupsDir} (${conn.describe})`);
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
    pgliteDir: pgliteDirFromEnv(setting("PGLITE_DIR")),
    pgBinDir: setting("PG_BIN_DIR") || undefined,
  });

  if (command === "migrate") {
    await migrateOrFail(conn);
    console.log(`regents: migrações aplicadas em ${conn.describe}`);
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
  const masterKeyFile = setting("MASTER_KEY_FILE");
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
  const vapid = config.read("VAPID_CONTACT");
  const vapidContact = vapid?.value || DEV_VAPID_CONTACT;
  if (!/^(mailto:|https:)/.test(vapidContact)) {
    fail(`${vapid?.name ?? `${PREFIX}_VAPID_CONTACT`}=${vapidContact} não é mailto: nem https:.`);
  }
  let limits: ReturnType<typeof limitsFromEnv>;
  let toolTimeoutMs: number | undefined;
  let toolMaxTurns: number | undefined;
  let approvalTtlMs: number | undefined;
  let memory: ReturnType<typeof memoryFromEnv> = {};
  let wiki: ReturnType<typeof wikiFromEnv> = {};
  try {
    limits = limitsFromEnv(config);
    toolTimeoutMs = toolTimeoutFromEnv(config);
    toolMaxTurns = toolMaxTurnsFromEnv(config);
    approvalTtlMs = approvalTtlFromEnv(config);
    memory = memoryFromEnv(config);
    wiki = wikiFromEnv(config);
  } catch (err) {
    fail((err as Error).message);
  }
  const githubUrl = setting("GITHUB_URL");
  const githubApiUrl = setting("GITHUB_API_URL");
  const regents = createApp({
    db: conn.db,
    identity: who.identity,
    clock: systemClock,
    accounts: {
      claudeBin: setting("CLAUDE_BIN") || Bun.which("claude") || "claude",
      root: resolve(setting("ACCOUNTS_DIR") ?? resolve(repoRoot, ".data/accounts")),
    },
    secrets,
    anthropicBaseUrl: setting("ANTHROPIC_BASE_URL"),
    github: {
      ...(githubUrl ? { webUrl: githubUrl } : {}),
      ...(githubApiUrl ? { apiUrl: githubApiUrl } : {}),
    },
    devRoutes: who.routes,
    push: { contact: vapidContact },
    // A seção Instalação: a versão (a tag da imagem), o backup e a chave do nó, com os avisos.
    installation: { version: setting("VERSION") || "dev", watch: true, nodeKey: who.nodeKey },
    // Os tetos de concorrência das execuções (2 por Conta, 4 na Chave, 8 processos no host).
    limits,
    // O prazo padrão de uma chamada de Ferramenta (60 s) e o teto de turnos de Ferramenta (20).
    tools: { timeoutMs: toolTimeoutMs, maxTurns: toolMaxTurns },
    // O prazo do Pedido de aprovação (24 h).
    approvals: { ttlMs: approvalTtlMs },
    // O modelo pequeno da extração da Memória (claude-haiku-5-5) e o orçamento do resumo (4000 caracteres).
    memory,
    // O tamanho máximo de uma Fonte da Wiki (5 MB).
    wiki,
  });
  // O par VAPID nasce na primeira subida (e daí em diante é sempre o mesmo, guardado no banco).
  await regents.push.ensureKeys();
  await regents.start();

  const root = new Hono();
  root.route("/", regents.app);
  // Rota de API desconhecida não cai no fallback do PWA.
  root.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  const webDist = resolve(setting("WEB_DIST") ?? resolve(repoRoot, "apps/web/dist"));
  if (existsSync(webDist)) {
    root.use("/*", serveStatic({ root: webDist }));
    root.get("/*", serveStatic({ root: webDist, path: "index.html" }));
  }

  const server = Bun.serve({
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    fetch: root.fetch,
    websocket: regents.websocket,
  });
  console.log(`regents: ouvindo em http://${server.hostname}:${server.port} (${conn.describe}; ${who.describe})`);

  // SIGTERM (o `docker compose stop`, com 30 s de folga): dreno, até 20 s para o que está rodando
  // terminar. SIGINT (Ctrl-C no dev): para na hora. Nos dois, os WebSockets fecham com 1012 logo
  // de início, e o PWA mostra "Atualizando o Shearim" até reconectar. O que não terminou vira "o servidor
  // reiniciou" na próxima subida, com a nova tentativa automática.
  let stopping = false;
  const stop = (drain: boolean) => async () => {
    if (stopping) return;
    stopping = true;
    await (drain ? regents.drain() : regents.halt());
    // No Bun 1.3.11, depois que o servidor fecha um WebSocket (o 1012 acima, ou o 4403 de um Membro
    // removido), a promessa do `stop()` nunca resolve, embora a porta feche na hora: espera as
    // requisições em curso até 1 s.
    await Promise.race([server.stop(), Bun.sleep(1_000)]);
    await regents.close();
    await conn.close();
    process.exit(0);
  };
  process.on("SIGINT", stop(false));
  process.on("SIGTERM", stop(true));
}

await main(process.argv[2]);
