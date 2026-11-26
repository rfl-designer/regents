/**
 * A atualização (`deploy/update.sh`; Spec, história 8): baixa o compose da release, mantém as
 * configurações no `.env` (e os segredos) e roda `docker compose pull` e `docker compose up -d`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { composeTag, download, SETUP_ENV, tailnetStatus, type World, world } from "./world";

async function installed(version = "1.2.3") {
  const w = await world();
  const installer = await w.release(version);
  const r = await w.run(installer, [], { env: SETUP_ENV });
  if (r.code !== 0) throw new Error(r.output);
  return w;
}

const kept = ["secrets/master_key", "secrets/postgres_password", "secrets/ts_authkey", ".env"];
const snapshot = (w: World) => kept.map((f) => readFileSync(join(w.installDir, f), "utf8"));
const compose = (w: World) => readFileSync(join(w.installDir, "compose.yaml"), "utf8");
const callsSince = (w: World, n: number) => w.calls().slice(n);

describe("deploy/update.sh", () => {
  test("baixa a última release, mantém o .env e os segredos, e roda pull e up", async () => {
    const w = await installed("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    const before = snapshot(w);
    const n = w.calls().length;

    const r = await w.run(join(w.installDir, "deploy/update.sh"), [], { cwd: w.home });
    expect(r.code, r.output).toBe(0);

    const calls = callsSince(w, n);
    const order = [download(), "docker compose config -q", "docker compose pull", "docker compose up -d"].map((want) =>
      calls.findIndex((c) => c.startsWith(want)),
    );
    expect(
      order.every((i) => i >= 0),
      calls.join("\n"),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nem setup de novo, nem nada instalado.
    expect(
      calls.filter((c) => /^(brew|sudo|launchctl|curl -fsSL https:\/\/get)|up -d tailscale|docker login/.test(c)),
    ).toEqual([]);

    expect(compose(w)).toContain(composeTag("1.3.0"));
    expect(snapshot(w)).toEqual(before);
    expect(r.stdout).toContain("de 1.2.3 para 1.3.0");
  });

  test("com uma versão: vai para ela", async () => {
    const w = await installed("1.2.3");
    await w.release("1.2.4");

    const r = await w.run(join(w.installDir, "deploy/update.sh"), ["v1.2.4"]);
    expect(r.code, r.output).toBe(0);
    expect(w.calls().some((c) => c.startsWith(download("v1.2.4")))).toBe(true);
    expect(compose(w)).toContain(composeTag("1.2.4"));
  });

  test("avisa quando o .env fixa REGENTS_VERSION", async () => {
    const w = await installed("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    const env = join(w.installDir, ".env");
    await Bun.write(env, `${readFileSync(env, "utf8")}REGENTS_VERSION=1.2.3\n`);

    const r = await w.run(join(w.installDir, "deploy/update.sh"));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("REGENTS_VERSION=1.2.3");
  });

  test("se o compose novo não fecha com o .env (falta REGENTS_VAPID_CONTACT): volta o de antes e não reinicia nada", async () => {
    const w = await installed("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    await Bun.write(join(w.installDir, ".env"), "SHEARIM_VAPID_CONTACT=mailto:rafa@example.com\n");
    const n = w.calls().length;

    const r = await w.run(join(w.installDir, "deploy/update.sh"));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("REGENTS_VAPID_CONTACT");
    expect(r.stderr).toContain("rode o instalador novo com --update (veja o README)");
    expect(compose(w)).toContain(composeTag("1.2.3"));
    expect(callsSince(w, n).filter((c) => /compose (pull|up)/.test(c))).toEqual([]);
  });

  test("fora de uma Instalação: recusa", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    const r = await w.run(installer, ["--update", "--dir", join(w.root, "nada")]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("não parece uma Instalação");
  });
});

/**
 * O updater antigo (Spec #96, história 34): uma Instalação que ainda é Shearim roda o
 * `sh deploy/update.sh` de hábito, e ele chega à release nova do Regents. O updater é o da release
 * v0.1.2 de verdade (`fixtures/shearim-v0.1.2`, o pacote publicado, igual ao `deploy/` da `main`
 * antes da troca do nome): ele roda o `install.sh --update` antigo, que baixa
 * `shearim-compose.tar.gz` de `rfl-designer/shearim` (o GitHub redireciona para `regents`).
 */
describe("o updater antigo, numa Instalação Shearim, diante da release nova", () => {
  const OLD = join(import.meta.dir, "fixtures/shearim-v0.1.2");

  // O que o instalador antigo lê no lugar das REGENTS_* da caixa de areia.
  const oldEnv = (w: World) => ({
    SHEARIM_EXTRA_PATH: join(w.root, "extra-bin"),
    SHEARIM_APPLICATIONS: join(w.root, "Applications"),
    SHEARIM_TTY: "/dev/null",
    SHEARIM_WAIT_SECONDS: "1",
    TS_AUTHKEY: "tskey-auth-falsa",
    SHEARIM_CONTACT_EMAIL: "rafa@example.com",
  });

  // A Instalação da v0.1.2, feita pelo instalador da v0.1.2.
  async function shearimInstalled() {
    const w = await world();
    const dir = join(w.state, "releases/v0.1.2");
    mkdirSync(dir, { recursive: true });
    const tar = await w.run("-c", [`tar -czf "${dir}/shearim-compose.tar.gz" -C "${OLD}" compose.yaml deploy`]);
    if (tar.code !== 0) throw new Error(tar.output);
    w.set("tailnet.json", tailnetStatus().replaceAll("regents", "shearim"));
    const r = await w.run(join(OLD, "deploy/install.sh"), [], { env: oldEnv(w) });
    if (r.code !== 0) throw new Error(r.output);
    return { w, installDir: join(w.home, "shearim") };
  }

  // O compose.yaml e cada arquivo de deploy/, com o conteúdo.
  const deployFiles = (dir: string) =>
    ["compose.yaml", ...readdirSync(join(dir, "deploy"), { recursive: true }).map((f) => join("deploy", String(f)))]
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]);

  test("volta o compose e o deploy/ de antes, não reinicia nada e mostra o comando do instalador novo com --update", async () => {
    const { w, installDir } = await shearimInstalled();
    await w.release("0.2.0");
    w.set("latest", "v0.2.0");
    const before = deployFiles(installDir);
    expect(before.map(([f]) => f)).toContain("deploy/update.sh");
    const env = readFileSync(join(installDir, ".env"), "utf8");
    const n = w.calls().length;

    const r = await w.run(join(installDir, "deploy/update.sh"), [], { cwd: installDir, env: oldEnv(w) });
    expect(r.code).not.toBe(0);

    // Ele baixou a release nova pelo nome antigo do pacote, e foi o compose dela que não fechou.
    const calls = w.calls().slice(n);
    const oldDownload =
      "curl -fsSL https://github.com/rfl-designer/shearim/releases/latest/download/shearim-compose.tar.gz";
    expect(calls.some((c) => c.startsWith(oldDownload))).toBe(true);
    expect(r.stderr).toContain("REGENTS_VAPID_CONTACT");

    expect(deployFiles(installDir)).toEqual(before);
    expect(readFileSync(join(installDir, ".env"), "utf8")).toBe(env);
    expect(calls.filter((c) => /^docker compose (pull|up|down|stop|start|restart|rm|create)/.test(c))).toEqual([]);

    expect(r.output).toContain(
      "curl -fsSL https://github.com/rfl-designer/regents/releases/latest/download/install.sh | sh -s -- --update --dir ~/shearim",
    );
  });
});
