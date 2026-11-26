/**
 * A atualização (`deploy/update.sh`; Spec, história 8): baixa o compose da release, mantém as
 * configurações no `.env` (e os segredos) e roda `docker compose pull` e `docker compose up -d`.
 * Numa Instalação que ainda é Shearim, faz antes a migração do nome (spec #96).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
/** O compose.yaml e cada arquivo de deploy/, com o conteúdo. */
const deployFiles = (dir: string) =>
  ["compose.yaml", ...readdirSync(join(dir, "deploy"), { recursive: true }).map((f) => join("deploy", String(f)))]
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), "utf8")]);
/** Os projetos do Compose de pé no Docker falso. */
const running = (w: World) => readdirSync(join(w.state, "running")).sort();

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
    await Bun.write(join(w.installDir, ".env"), "REGENTS_MAX_PROCESSES=4\n");
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

/** Os volumes do projeto `shearim` que a migração do nome copia para os do projeto `regents`. */
const VOLUMES = ["ts-state", "ts-socket", "pgdata", "contas"];
const OLD_PLIST = "Library/LaunchAgents/com.shearim.acordado.plist";
const NEW_PLIST = "Library/LaunchAgents/com.regents.acordado.plist";

/**
 * Uma Instalação que ainda é Shearim, como a v0.1.2 deixou: `~/shearim` com o compose do projeto
 * `shearim`, o `.env` com `SHEARIM_*`, os volumes `shearim_*` com dados e, no Mac, o
 * `com.shearim.acordado`.
 */
async function shearimInstallation({ env }: { env?: string } = {}) {
  const w = await world();
  const dir = join(w.home, "shearim");
  for (const sub of ["deploy", "secrets", "backups"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(
    join(dir, "compose.yaml"),
    [
      "name: shearim",
      "services:",
      "  app:",
      `    image: \${SHEARIM_IMAGE:-ghcr.io/rfl-designer/shearim}:\${SHEARIM_VERSION:-0.1.2}`,
      "    environment:",
      `      SHEARIM_VAPID_CONTACT: \${SHEARIM_VAPID_CONTACT:?rode deploy/setup.sh (falta SHEARIM_VAPID_CONTACT no .env)}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "deploy/update.sh"), "# o updater antigo\n");
  for (const secret of ["ts_authkey", "postgres_password", "master_key"])
    writeFileSync(join(dir, "secrets", secret), `${secret}-de-antes\n`);
  writeFileSync(
    join(dir, ".env"),
    env ??
      "SHEARIM_VAPID_CONTACT=mailto:rafa@example.com\nSHEARIM_MAX_PROCESSES=4\nSHEARIM_BACKUP_AT=04:30\nTZ=America/Sao_Paulo\n",
  );
  const volume = (name: string) => join(w.state, "volumes", name);
  const put = (file: string, content: string, mode: number) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    chmodSync(file, mode);
  };
  put(join(volume("shearim_pgdata"), "18/docker/PG_VERSION"), "18\n", 0o600);
  chmodSync(join(volume("shearim_pgdata"), "18/docker"), 0o700);
  put(join(volume("shearim_contas"), "m-1001/.credentials.json"), '{"conta":"da Juliana"}\n', 0o600);
  put(join(volume("shearim_ts-state"), "tailscaled.state"), '{"no":"shearim"}\n', 0o600);
  mkdirSync(volume("shearim_ts-socket"), { recursive: true });
  put(join(w.home, OLD_PLIST), "<plist>com.shearim.acordado</plist>\n", 0o644);
  w.set("launchagent");
  w.set("running/shearim");

  const installer = await w.release("1.3.0");
  w.set("latest", "v1.3.0");
  return { w, dir, installer, volume };
}

const read = (file: string) => readFileSync(file, "utf8");

describe("a migração do nome (install.sh --update numa Instalação Shearim)", () => {
  test("com --yes: o .env passa a REGENTS_*, os volumes vão para regents_* e o projeto regents sobe", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).not.toContain("[s/N]");

    const env = read(join(dir, ".env"));
    expect(env).toContain("REGENTS_VAPID_CONTACT=mailto:rafa@example.com\n");
    expect(env).not.toMatch(/^SHEARIM_/m);
    expect(read(join(volume("regents_pgdata"), "18/docker/PG_VERSION"))).toBe("18\n");
    expect(read(join(volume("regents_contas"), "m-1001/.credentials.json"))).toContain("da Juliana");
    expect(read(join(dir, "compose.yaml"))).toContain("name: regents");
    expect(w.calls().filter((c) => c === "docker compose up -d")).toHaveLength(1);
  });

  test("antes de mudar algo, mostra o que muda e o que fica e pede o sim", async () => {
    const { w, dir, installer } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir], { answers: ["s"] });
    expect(r.code, r.output).toBe(0);
    const plan = r.stdout.slice(0, r.stdout.indexOf("[s/N]"));
    for (const changes of [".env", "SHEARIM_* para REGENTS_*", "shearim_pgdata", "regents_pgdata", "projeto regents"])
      expect(plan).toContain(changes);
    for (const stays of ["hostname shearim", "a URL", "tag:shearim", "banco shearim"]) expect(plan).toContain(stays);
  });

  test("com o não (ou sem terminal e sem --yes), nada muda", async () => {
    for (const answers of [["n"], undefined]) {
      const { w, dir, installer } = await shearimInstallation();
      const before = [".env", "compose.yaml"].map((f) => read(join(dir, f)));

      const r = await w.run(installer, ["--update", "--dir", dir], { answers });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Nada mudou");
      expect(r.stderr).toContain("--yes");
      expect([".env", "compose.yaml"].map((f) => read(join(dir, f)))).toEqual(before);
      expect(w.calls().filter((c) => /docker (run|volume create)|compose .*(down|up|pull|exec)/.test(c))).toEqual([]);
    }
  });

  test("faz um backup com o app antigo de pé, antes de parar o projeto shearim", async () => {
    const { w, dir, installer } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const calls = w.calls();
    const dump = calls.findIndex((c) => /compose .*antes\/compose\.yaml exec -T postgres pg_dump/.test(c));
    const down = calls.findIndex((c) => /compose .*antes\/compose\.yaml down/.test(c));
    expect(dump, calls.join("\n")).toBeGreaterThanOrEqual(0);
    expect(dump).toBeLessThan(down);
    expect(calls[dump]).toContain("-U shearim -d shearim");

    const backups = readdirSync(join(dir, "backups"));
    expect(backups).toEqual([expect.stringMatching(/^shearim-pre-migracao-\d{8}T\d{6}Z\.dump$/)]);
    const backup = backups[0] as string;
    expect(read(join(dir, "backups", backup))).toBe("dump falso\n");
    expect(r.stdout).toContain(backup);
  });

  test("para o projeto shearim sem apagar volumes e copia os quatro para regents_*, com as mesmas permissões", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const calls = w.calls();
    const downs = calls.filter((c) => / down/.test(c));
    expect(downs).toHaveLength(1);
    expect(downs[0]).not.toMatch(/ (-v|--volumes)\b/);
    for (const v of VOLUMES) {
      expect(calls).toContain(
        `docker volume create --label com.docker.compose.project=regents --label com.docker.compose.volume=${v} regents_${v}`,
      );
      expect(existsSync(volume(`regents_${v}`))).toBe(true);
    }
    const mode = (file: string) => statSync(file).mode & 0o777;
    expect(mode(join(volume("regents_pgdata"), "18/docker"))).toBe(0o700);
    expect(mode(join(volume("regents_pgdata"), "18/docker/PG_VERSION"))).toBe(0o600);
    expect(mode(join(volume("regents_contas"), "m-1001/.credentials.json"))).toBe(0o600);
    expect(read(join(volume("regents_ts-state"), "tailscaled.state"))).toBe('{"no":"shearim"}\n');
  });

  test("os volumes shearim_* ficam intactos, e a pasta da Instalação fica onde está", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();
    const files = ["shearim_pgdata/18/docker/PG_VERSION", "shearim_contas/m-1001/.credentials.json"];
    const before = files.map((f) => read(volume(f)));

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(files.map((f) => read(volume(f)))).toEqual(before);
    expect(w.calls().filter((c) => /volume rm|volume prune/.test(c))).toEqual([]);
    expect(read(join(dir, "secrets/master_key"))).toBe("master_key-de-antes\n");
    expect(existsSync(join(w.home, "regents"))).toBe(false);
  });

  test("no .env novo, cada SHEARIM_<sufixo> vira REGENTS_<sufixo> com o mesmo valor, e a versão fixada continua com o aviso", async () => {
    const { w, dir, installer } = await shearimInstallation({
      env: "# minhas configurações\nSHEARIM_VAPID_CONTACT=mailto:rafa@example.com\nSHEARIM_MAX_PROCESSES=4\nSHEARIM_BACKUP_AT=04:30\nTZ=America/Sao_Paulo\nSHEARIM_VERSION=1.3.0\n",
    });

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const env = read(join(dir, ".env"));
    expect(env).toStartWith(
      "# minhas configurações\nREGENTS_VAPID_CONTACT=mailto:rafa@example.com\nREGENTS_MAX_PROCESSES=4\nREGENTS_BACKUP_AT=04:30\nTZ=America/Sao_Paulo\nREGENTS_VERSION=1.3.0\n",
    );
    expect(env).not.toContain("SHEARIM_");
    expect(r.stdout).toContain("AVISO: o .env fixa REGENTS_VERSION=1.3.0");
  });

  test("o .env novo guarda o hostname, a tag e o papel e o banco de antes, e o .env antigo fica ao lado", async () => {
    const old = "SHEARIM_VAPID_CONTACT=mailto:rafa@example.com\nSHEARIM_MAX_PROCESSES=4\n";
    for (const [extra, host] of [
      ["", "shearim"],
      ["TS_HOSTNAME=extraevo\n", "extraevo"],
    ] as const) {
      const { w, dir, installer } = await shearimInstallation({ env: old + extra });

      const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
      expect(r.code, r.output).toBe(0);
      const env = read(join(dir, ".env"));
      for (const line of [
        `TS_HOSTNAME=${host}`,
        "REGENTS_TAILNET_TAG=tag:shearim",
        "REGENTS_POSTGRES_USER=shearim",
        "REGENTS_POSTGRES_DB=shearim",
      ]) {
        const key = line.slice(0, line.indexOf("=") + 1);
        expect(env.split("\n").filter((l) => l.startsWith(key))).toEqual([line]);
      }
      expect(read(join(dir, ".env.shearim"))).toBe(old + extra);
    }
  });

  test("no Mac, com.shearim.acordado sai e com.regents.acordado entra", async () => {
    const { w, dir, installer } = await shearimInstallation();
    const uid = process.getuid?.();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(existsSync(join(w.home, OLD_PLIST))).toBe(false);
    expect(read(join(w.home, NEW_PLIST))).toContain("<string>com.regents.acordado</string>");
    const calls = w.calls();
    expect(calls).toContain(`launchctl bootout gui/${uid}/com.shearim.acordado`);
    expect(calls).toContain(`launchctl bootstrap gui/${uid} ${join(w.home, NEW_PLIST)}`);
  });

  test("o projeto regents sobe depois da cópia e do .env novo, e o instalador espera o app responder", async () => {
    const { w, dir, installer } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const calls = w.calls();
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const order = [
      at(/ down$/),
      at(/^docker run .*regents_contas/),
      at(/^docker compose config -q$/),
      at(/^docker compose pull$/),
      at(/^docker compose up -d$/),
      at(/^docker compose ps app --format/),
    ];
    expect(
      order.every((i) => i >= 0),
      calls.join("\n"),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.stdout).toContain("ok: o Shearim 0.1.2 agora é o Regents 1.3.0");
  });

  test("no fim, diz quais volumes antigos ficaram, como apagá-los e como trocar o hostname depois", async () => {
    const { w, dir, installer } = await shearimInstallation();

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const end = r.stdout.slice(r.stdout.indexOf("ok: o Shearim 0.1.2 agora é o Regents"));
    for (const v of VOLUMES) expect(end).toContain(`shearim_${v}`);
    expect(end).toContain(`docker volume rm ${VOLUMES.map((v) => `shearim_${v}`).join(" ")}`);
    expect(end).toContain("TS_HOSTNAME");
    for (const stops of ["a URL", "Tela de Início", "push", "GitHub App"]) expect(end).toContain(stops);
  });

  test("reconhece a Instalação antiga também pelo volume shearim_pgdata, com o .env já em REGENTS_*", async () => {
    const { w, dir, installer, volume } = await shearimInstallation({
      env: "REGENTS_VAPID_CONTACT=mailto:rafa@example.com\n",
    });

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(read(join(volume("regents_pgdata"), "18/docker/PG_VERSION"))).toBe("18\n");
    expect(read(join(dir, ".env"))).toContain("REGENTS_POSTGRES_DB=shearim\n");
  });

  test("uma segunda atualização é uma atualização comum, sem migração", async () => {
    const { w, dir, installer } = await shearimInstallation();
    expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).toBe(0);
    const env = read(join(dir, ".env"));
    await w.release("1.3.1");
    w.set("latest", "v1.3.1");
    const n = w.calls().length;

    const r = await w.run(join(dir, "deploy/update.sh"));
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).toContain("ok: Regents atualizado de 1.3.0 para 1.3.1");
    expect(callsSince(w, n).filter((c) => /docker (run|volume create)|compose .*down/.test(c))).toEqual([]);
    expect(read(join(dir, ".env"))).toBe(env);
  });
});

/**
 * A migração do nome que falha ou para no meio (ADR 0003): uma falha deixa o Shearim de pé, com o
 * motivo; uma interrupção pode rodar de novo e terminar, sem metade em cada nome.
 */
describe("a migração do nome que falha ou para no meio", () => {
  const failures = [
    ["o app novo não responde", "não respondeu", (w: World) => w.set("health", "unhealthy")],
    ["o docker compose up -d falha", "docker compose up -d", (w: World) => w.set("fail-on", "docker compose up -d")],
  ] as const;
  for (const [how, reason, failure] of failures) {
    test(`se ${how}: volta o compose, o deploy/ e o .env de antes, sobe o projeto shearim e sai com o motivo`, async () => {
      const { w, dir, installer } = await shearimInstallation();
      const before = deployFiles(dir);
      const env = read(join(dir, ".env"));
      failure(w);

      const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("a migração do nome parou");
      expect(r.stderr).toContain(reason);
      expect(deployFiles(dir)).toEqual(before);
      expect(read(join(dir, ".env"))).toBe(env);
      expect(running(w)).toEqual(["shearim"]);
    });
  }

  test("os volumes regents_* da tentativa que falhou ficam, mesmo incompletos", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();
    w.set("fail-on", "docker run *regents_contas*");

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("não consegui copiar o volume shearim_contas para regents_contas");
    expect(read(join(volume("regents_pgdata"), "18/docker/PG_VERSION"))).toBe("18\n");
    expect(existsSync(volume("regents_contas"))).toBe(true);
    expect(w.calls().filter((c) => /volume rm|volume prune/.test(c))).toEqual([]);
    expect(running(w)).toEqual(["shearim"]);
  });

  test("uma nova tentativa depois da falha termina a migração", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();
    w.set("fail-on", "docker run *regents_contas*");
    expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).not.toBe(0);
    w.set("fail-on", "nada");

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).toContain("ok: o Shearim 0.1.2 agora é o Regents 1.3.0");
    expect(read(join(volume("regents_contas"), "m-1001/.credentials.json"))).toContain("da Juliana");
    expect(read(join(dir, ".env"))).toContain("REGENTS_VAPID_CONTACT=mailto:rafa@example.com\n");
    expect(running(w)).toEqual(["regents"]);
    expect(existsSync(join(dir, ".migracao-regents"))).toBe(false);
  });

  const copies = (calls: string[], v: string) =>
    calls.filter((c) => c.startsWith("docker run") && c.includes(`regents_${v}:`));

  test("interrompida na cópia, uma nova execução não copia de novo um volume que já está completo", async () => {
    const { w, dir, installer, volume } = await shearimInstallation();
    w.set("interrupt-on", "docker run *regents_contas*");
    expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).not.toBe(0);
    const n = w.calls().length;

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    const calls = callsSince(w, n);
    for (const v of ["ts-state", "ts-socket", "pgdata"]) expect(copies(calls, v)).toEqual([]);
    expect(copies(calls, "contas")).toHaveLength(1);
    expect(read(join(volume("regents_contas"), "m-1001/.credentials.json"))).toContain("da Juliana");
  });

  // Depois de uma volta, o Shearim rodou de novo e escreveu nos shearim_* (o banco, as Contas): uma
  // cópia anterior a isso perderia o que ele escreveu.
  test("depois de uma volta para o Shearim, a nova tentativa copia de novo os volumes", async () => {
    const { w, dir, installer } = await shearimInstallation();
    w.set("health", "unhealthy");
    expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).not.toBe(0);
    w.set("health", "healthy");
    const n = w.calls().length;

    const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
    expect(r.code, r.output).toBe(0);
    for (const v of VOLUMES) expect(copies(callsSince(w, n), v)).toHaveLength(1);
  });

  const ONCE =
    "REGENTS_VAPID_CONTACT=mailto:rafa@example.com\nREGENTS_MAX_PROCESSES=4\nREGENTS_BACKUP_AT=04:30\nTZ=America/Sao_Paulo\n";
  const keys = (env: string) =>
    env.split("\n").flatMap((l) => (/^[A-Z_]+=/.test(l) ? [l.slice(0, l.indexOf("="))] : []));

  /** Tudo no nome novo: o .env, o compose, os volumes, o projeto de pé e, no Mac, o LaunchAgent. */
  function allRegents(w: World, dir: string, volume: (name: string) => string) {
    const env = read(join(dir, ".env"));
    expect(env).toStartWith(ONCE);
    expect(env).not.toContain("SHEARIM_");
    expect(env).toContain("REGENTS_POSTGRES_DB=shearim\n");
    expect(new Set(keys(env)).size).toBe(keys(env).length);
    expect(read(join(dir, "compose.yaml"))).toContain("name: regents");
    expect(read(join(volume("regents_pgdata"), "18/docker/PG_VERSION"))).toBe("18\n");
    expect(read(join(volume("regents_contas"), "m-1001/.credentials.json"))).toContain("da Juliana");
    expect(read(join(volume("regents_ts-state"), "tailscaled.state"))).toBe('{"no":"shearim"}\n');
    expect(running(w)).toEqual(["regents"]);
    expect(existsSync(join(w.home, OLD_PLIST))).toBe(false);
    expect(existsSync(join(w.home, NEW_PLIST))).toBe(true);
    expect(existsSync(join(dir, ".migracao-regents"))).toBe(false);
  }

  const steps = [
    ["no download", "curl *regents-compose.tar.gz*"],
    ["no backup", "docker compose *pg_dump*"],
    ["ao parar o projeto shearim", "docker compose * down"],
    ["ao criar um volume", "docker volume create *regents_pgdata"],
    ["na cópia de um volume", "docker run *regents_pgdata*"],
    ["depois do .env novo", "docker compose config -q"],
    ["ao tirar o com.shearim.acordado", "launchctl bootout *com.shearim.acordado"],
    ["ao pôr o com.regents.acordado", "launchctl bootstrap *"],
    ["no pull", "docker compose pull"],
    ["ao subir o projeto regents", "docker compose up -d"],
  ] as const;
  for (const [where, call] of steps) {
    test(`interrompida ${where}, uma nova execução termina com tudo no nome novo`, async () => {
      const { w, dir, installer, volume } = await shearimInstallation();
      w.set("interrupt-on", call);
      const stopped = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
      expect(stopped.code).not.toBe(0);
      expect(stopped.output).not.toContain("a migração do nome parou");
      expect(existsSync(join(w.state, "interrupt-on"))).toBe(false);

      const r = await w.run(installer, ["--update", "--dir", dir, "--yes"]);
      expect(r.code, r.output).toBe(0);
      expect(r.stdout).toContain("ok: o Shearim 0.1.2 agora é o Regents 1.3.0");
      allRegents(w, dir, volume);
    });
  }

  test("uma nova tentativa não reescreve o .env duas vezes: nenhuma linha REGENTS_* duplicada", async () => {
    for (const stop of [
      (w: World) => w.set("interrupt-on", "docker compose config -q"),
      (w: World) => w.set("health", "unhealthy"),
    ]) {
      const { w, dir, installer, volume } = await shearimInstallation();
      stop(w);
      expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).not.toBe(0);
      w.set("health", "healthy");

      expect((await w.run(installer, ["--update", "--dir", dir, "--yes"])).code).toBe(0);
      allRegents(w, dir, volume);
      expect(read(join(dir, ".env.shearim"))).toStartWith("SHEARIM_VAPID_CONTACT=");
    }
  });
});
