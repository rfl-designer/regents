/**
 * A configuração da Instalação (spec #96): o servidor lê `REGENTS_<sufixo>` e aceita o nome antigo
 * `SHEARIM_<sufixo>` como reserva, com um aviso no log. O que se olha é o que quem cuida da
 * Instalação veria: o processo de verdade (`main.ts`), o que ele escreve no log, o código de saída e
 * o Workspace pela borda HTTP.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InstallationDto } from "@regents/contracts";
import { onCleanup, throwawayAccounts } from "./harness";

const MAIN = resolve(import.meta.dir, "../src/main.ts");

type Vars = Record<string, string>;

/** As variáveis com o prefixo dado: `named("REGENTS", { IDENTITY: "dev" })` → `REGENTS_IDENTITY=dev`. */
function named(prefix: "REGENTS" | "SHEARIM", vars: Vars): Vars {
  return Object.fromEntries(Object.entries(vars).map(([suffix, value]) => [`${prefix}_${suffix}`, value]));
}

/** O ambiente de quem roda os testes, sem nenhuma `REGENTS_*` ou `SHEARIM_*` que vaze para o processo. */
function cleanEnv(): Vars {
  const env: Vars = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(REGENTS|SHEARIM)_/.test(k)) env[k] = v;
  }
  return { ...env, DATABASE_URL: "", DATABASE_PASSWORD_FILE: "", HOST: "127.0.0.1", PORT: "0" };
}

/** O que uma Instalação precisa para subir com a identidade de dev, num PGlite em memória (sem prefixo). */
function installation(): Vars {
  const { config } = throwawayAccounts();
  const dir = mkdtempSync(join(tmpdir(), "regents-config-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const masterKey = join(dir, "master_key");
  writeFileSync(masterKey, "11".repeat(32));
  return {
    IDENTITY: "dev",
    PGLITE_DIR: "memory://",
    WEB_DIST: join(dir, "sem-pwa"),
    CLAUDE_BIN: config.claudeBin,
    ACCOUNTS_DIR: config.root,
    MASTER_KEY_FILE: masterKey,
    BACKUPS_DIR: join(dir, "backups"),
  };
}

/**
 * Roda `bun src/main.ts <comando>` com o ambiente dado. Devolve quando o servidor diz em que porta
 * ouve (`origin`) ou quando o processo sai (`code`); `log()` é tudo o que ele escreveu até agora.
 */
async function run(command: string, env: Vars) {
  const proc = Bun.spawn(["bun", MAIN, command], { env: { ...cleanEnv(), ...env }, stdout: "pipe", stderr: "pipe" });
  onCleanup(() => proc.kill("SIGKILL"));
  let out = "";
  let listening: (origin: string) => void = () => {};
  const origin = new Promise<string>((r) => {
    listening = r;
  });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      out += decoder.decode(chunk);
      const found = out.match(/ouvindo em http:\/\/([\d.]+:\d+)/)?.[1];
      if (found) listening(found);
    }
  };
  const done = Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]).then(([, , code]) => code);
  const first = await Promise.race([origin.then((o) => ({ origin: o })), done.then((code) => ({ code }))]);
  return { ...first, log: () => out };
}

/** A versão que a seção Instalação mostra (a Pessoa Dev entra primeiro e é a Admin). */
async function versionAt(origin: string) {
  expect((await fetch(`http://${origin}/api/me`)).status).toBe(200);
  const res = await fetch(`http://${origin}/api/installation`);
  expect(res.status).toBe(200);
  return ((await res.json()) as InstallationDto).version;
}

describe("configuração: REGENTS_* com SHEARIM_* como reserva", () => {
  test("uma Instalação nova só com REGENTS_* sobe com esses valores e não escreve aviso", async () => {
    const app = await run("serve", named("REGENTS", { ...installation(), VERSION: "1.2.3", MAX_PROCESSES: "3" }));

    expect("origin" in app ? app.origin : app.log()).toMatch(/^127\.0\.0\.1:\d+$/);
    if (!("origin" in app)) return;
    expect(await versionAt(app.origin)).toBe("1.2.3");
    expect(app.log()).not.toContain("nome antigo");
    expect(app.log()).not.toContain("SHEARIM_");
  }, 60_000);

  test("a Instalação que ainda tem só SHEARIM_* sobe com esses valores e avisa uma vez cada nome antigo", async () => {
    const vars = { ...installation(), VERSION: "0.1.2", MAX_PROCESSES: "3" };
    const app = await run("serve", named("SHEARIM", vars));

    expect("origin" in app ? app.origin : app.log()).toMatch(/^127\.0\.0\.1:\d+$/);
    if (!("origin" in app)) return;
    expect(await versionAt(app.origin)).toBe("0.1.2");
    const aviso = "SHEARIM_MAX_PROCESSES é o nome antigo; use REGENTS_MAX_PROCESSES";
    expect(app.log().split(aviso).length - 1).toBe(1);
    // A reserva vale para todas: identidade, banco, Contas, chave mestra, backups, versão...
    for (const suffix of Object.keys(vars)) {
      expect(app.log()).toContain(`SHEARIM_${suffix} é o nome antigo; use REGENTS_${suffix}`);
    }
  }, 60_000);

  test("com os dois nomes, vale REGENTS_*, e o log diz que o SHEARIM_* foi ignorado", async () => {
    const app = await run("serve", {
      ...named("REGENTS", { ...installation(), VERSION: "2.0.0" }),
      SHEARIM_VERSION: "0.1.2",
    });

    expect("origin" in app ? app.origin : app.log()).toMatch(/^127\.0\.0\.1:\d+$/);
    if (!("origin" in app)) return;
    expect(await versionAt(app.origin)).toBe("2.0.0");
    expect(app.log()).toContain("REGENTS_VERSION e SHEARIM_VERSION estão definidas; vale REGENTS_VERSION");
    expect(app.log()).toContain("SHEARIM_VERSION foi ignorada");
    expect(app.log()).not.toContain("SHEARIM_VERSION é o nome antigo");
  }, 60_000);

  test("um valor inválido para o arranque com a mensagem que cita o nome que foi lido", async () => {
    const antigo = await run("backup", named("SHEARIM", { ...installation(), BACKUP_AT: "25:00" }));
    expect(antigo).toMatchObject({ code: 1 });
    expect(antigo.log()).toContain("SHEARIM_BACKUP_AT=25:00 não é uma hora (HH:MM).");

    const novo = await run("serve", named("REGENTS", { ...installation(), MAX_PROCESSES: "0" }));
    expect(novo).toMatchObject({ code: 1 });
    expect(novo.log()).toContain("REGENTS_MAX_PROCESSES=0 não é um número inteiro maior que zero.");
    expect(novo.log()).not.toContain("ouvindo");

    const semIdentidade = await run("serve", named("REGENTS", { ...installation(), IDENTITY: "" }));
    expect(semIdentidade).toMatchObject({ code: 1 });
    expect(semIdentidade.log()).toContain("REGENTS_IDENTITY=(vazio) não é suportado.");
  }, 60_000);

  test("o contato do push que não é mailto: nem https: para o arranque com o nome que foi lido", async () => {
    for (const prefix of ["REGENTS", "SHEARIM"] as const) {
      const app = await run("serve", named(prefix, { ...installation(), VAPID_CONTACT: "rafa@example.com" }));
      expect(app).toMatchObject({ code: 1 });
      expect(app.log()).toContain(`${prefix}_VAPID_CONTACT=rafa@example.com não é mailto: nem https:.`);
      expect(app.log()).not.toContain("undefined");
    }
  }, 60_000);
});
