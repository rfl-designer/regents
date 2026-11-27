/**
 * O instalador de uma linha (`deploy/install.sh`; Spec, histórias 1 a 6, módulo 13). Roda o
 * instalador que a release publica, numa máquina de mentira (`world.ts`): nada é instalado de
 * verdade. O instalador real em Mac e Linux fica para o smoke manual.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { composeTag, download, REPO_ROOT, SETUP_ENV, tailnetStatus, world } from "./world";

const PLIST = "Library/LaunchAgents/com.regents.acordado.plist";

/** As linhas do checklist "Mantê-lo rodando" marcadas ([x]) e não marcadas ([ ]). */
function checklist(output: string) {
  const at = output.indexOf("Mantê-lo rodando");
  if (at < 0) throw new Error(`sem o checklist "Mantê-lo rodando":\n${output}`);
  const lines = output.slice(at).split("\n");
  return {
    done: lines.filter((l) => l.includes("[x]")).join("\n"),
    todo: lines.filter((l) => l.includes("[ ]")).join("\n"),
  };
}

function inOrder(calls: string[], expected: string[]) {
  let at = 0;
  for (const want of expected) {
    const found = calls.findIndex((c, i) => i >= at && c.startsWith(want));
    if (found < 0) throw new Error(`faltou "${want}" (depois da chamada ${at}) em:\n${calls.join("\n")}`);
    at = found + 1;
  }
}

describe("no Mac", () => {
  test("com o Docker Desktop rodando: baixa a release pública, faz o setup, sobe e mantém o Mac acordado", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");

    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code, r.output).toBe(0);

    const calls = w.calls();
    inOrder(calls, [
      download("v1.2.3"),
      "docker compose up -d tailscale",
      "docker compose pull",
      "docker compose up -d",
      "launchctl bootstrap",
    ]);
    // A imagem é pública: nada de conta no GitHub nem docker login.
    expect(calls.filter((c) => /^gh |docker login/.test(c))).toEqual([]);
    // Usa o Docker que existe: não instala nada.
    expect(calls.filter((c) => /^(brew|colima|sudo|open) /.test(c))).toEqual([]);

    // A Instalação: o compose da release (tag fixa), os segredos gerados e o .env.
    expect(readFileSync(join(w.installDir, "compose.yaml"), "utf8")).toContain(composeTag("1.2.3"));
    for (const secret of ["ts_authkey", "postgres_password", "master_key"])
      expect(existsSync(join(w.installDir, "secrets", secret))).toBe(true);
    const env = readFileSync(join(w.installDir, ".env"), "utf8");
    expect(env).toContain("REGENTS_VAPID_CONTACT=mailto:rafa@example.com");
    expect(env).not.toMatch(/shearim/i);

    // O LaunchAgent que segura o sono enquanto o Docker responde.
    const plist = readFileSync(join(w.home, PLIST), "utf8");
    expect(plist).toContain("/usr/bin/caffeinate -i");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(calls).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${join(w.home, PLIST)}`);

    const { done, todo } = checklist(r.stdout);
    expect(done).toContain("O Mac não dorme com o Docker de pé");
    expect(done).toContain("MagicDNS");
    expect(done).toContain("HTTPS");
    expect(done).toContain("O Regents respondeu");
    expect(todo).toContain("Docker Desktop");
    expect(todo).toContain("./backups e ./secrets");
    expect(r.stdout).toContain("https://regents.tail1234.ts.net");
  });

  test("sem Docker: pergunta e, com o sim, instala o Colima pelo Homebrew e o deixa subir a cada login", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("docker");
    w.hide("colima");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["s"] });
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).toContain("Instalar o Colima");
    inOrder(w.calls(), [
      "brew install colima docker docker-compose",
      "brew services start colima",
      download("v1.2.3"),
      "docker compose up -d",
    ]);
    const { done } = checklist(r.stdout);
    expect(done).toContain("O Colima sobe quando você entra no Mac");
    expect(done).toContain("O Mac não dorme com o Docker de pé");
  });

  test("sem Docker, com o não (ou sem terminal para perguntar): não instala nada e diz o que fazer", async () => {
    for (const answers of [["n"], undefined]) {
      const w = await world();
      const installer = await w.release("1.2.3");
      w.hide("docker");
      w.hide("colima");
      rmSync(join(w.state, "docker-up"));

      const r = await w.run(installer, [], { env: SETUP_ENV, answers });
      expect(r.code, r.output).not.toBe(0);
      expect(r.stderr).toContain("Docker Desktop, OrbStack ou Colima");
      expect(w.calls().filter((c) => /^(brew|curl|launchctl)/.test(c))).toEqual([]);
      expect(existsSync(w.installDir)).toBe(false);
    }
  });

  test("--yes instala o Colima sem perguntar", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("docker");
    w.hide("colima");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, ["--yes"], { env: SETUP_ENV });
    expect(r.code, r.output).toBe(0);
    expect(w.calls()).toContain("brew install colima docker docker-compose");
  });

  test("sem Docker e sem Homebrew: diz como instalar o Homebrew e não instala nada", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("docker");
    w.hide("colima");
    w.hide("brew");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["s"] });
    expect(r.code, r.output).not.toBe(0);
    expect(r.stderr).toContain("https://brew.sh");
    expect(w.calls().filter((c) => /^(curl|launchctl)/.test(c))).toEqual([]);
  });

  test("com o OrbStack instalado e parado: pergunta, abre o OrbStack e espera o Docker", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("colima");
    rmSync(join(w.state, "docker-up"));
    w.set("docker-os", "OrbStack");
    mkdirSync(join(w.root, "Applications/OrbStack.app"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["s"] });
    expect(r.code, r.output).toBe(0);
    inOrder(w.calls(), ["open -a OrbStack", "docker info", download("v1.2.3")]);
    expect(w.calls().filter((c) => c.startsWith("brew "))).toEqual([]);
    expect(checklist(r.stdout).todo).toContain("OrbStack");
  });

  test("o checklist marca o que o pmset e o login automático já dizem, sem mudar nada", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.set("pmset", " sleep 0\n autorestart 1\n");
    w.set("autologin");

    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code, r.output).toBe(0);
    const { done } = checklist(r.stdout);
    expect(done).toContain("O Mac liga sozinho depois de uma falta de luz");
    expect(done).toContain("O Mac entra sozinho na sua sessão");
    // Só leitura: nenhuma configuração de energia mudou.
    expect(w.calls().filter((c) => c.startsWith("pmset"))).toEqual(["pmset -g"]);
    expect(
      w
        .calls()
        .filter((c) => c.startsWith("defaults"))
        .every((c) => c.startsWith("defaults read")),
    ).toBe(true);
  });
});

describe("no Linux", () => {
  test("sem Docker: pergunta, instala o Docker Engine pelo script oficial e segue com sudo nesta sessão", async () => {
    const w = await world({ os: "Linux" });
    const installer = await w.release("1.2.3");
    w.hide("docker");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["s"] });
    expect(r.code, r.output).toBe(0);
    expect(r.stdout).toContain("get.docker.com");
    inOrder(w.calls(), [
      "curl -fsSL https://get.docker.com",
      "sudo sh",
      "sudo usermod -aG docker quem-instala",
      download("v1.2.3"),
      "sudo ",
      "docker compose pull",
      "docker compose up -d",
    ]);
    // Sem LaunchAgent nem nada do Mac.
    expect(w.calls().filter((c) => /^(launchctl|pmset|brew|open) /.test(c))).toEqual([]);
    expect(existsSync(join(w.home, PLIST))).toBe(false);

    const { done, todo } = checklist(r.stdout);
    expect(done).toContain("O Docker sobe com o computador");
    expect(todo).toContain("falta de luz");
    expect(todo).toContain("não suspende");
  });

  test("sem Docker, com o não: não instala nada", async () => {
    const w = await world({ os: "Linux" });
    const installer = await w.release("1.2.3");
    w.hide("docker");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["n"] });
    expect(r.code, r.output).not.toBe(0);
    expect(r.stderr).toContain("https://docs.docker.com/engine/install/");
    expect(w.calls().filter((c) => /^(curl|sudo)/.test(c))).toEqual([]);
  });

  test("com o Docker parado: pergunta e o inicia e habilita no boot", async () => {
    const w = await world({ os: "Linux" });
    const installer = await w.release("1.2.3");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["s"] });
    expect(r.code, r.output).toBe(0);
    inOrder(w.calls(), ["sudo systemctl enable --now docker", download("v1.2.3")]);
    expect(w.calls().filter((c) => c.startsWith("curl -fsSL https://get.docker.com"))).toEqual([]);
  });

  test("com o Docker sem o Compose: instala o plugin", async () => {
    const w = await world({ os: "Linux" });
    const installer = await w.release("1.2.3");
    w.set("no-compose");
    w.set("docker-enabled");

    const r = await w.run(installer, ["--yes"], { env: SETUP_ENV });
    expect(r.code, r.output).toBe(0);
    inOrder(w.calls(), ["sudo apt-get install -y docker-compose-plugin", download("v1.2.3")]);
    expect(checklist(r.stdout).done).toContain("O Docker sobe com o computador");
  });
});

describe("a Instalação nova", () => {
  /** O que o Compose de verdade sobe na pasta (`docker compose config`; não precisa do daemon). */
  async function composeConfig(dir: string) {
    const proc = Bun.spawn([docker ?? "docker", "compose", "config", "--format", "json"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, err, config: code === 0 ? JSON.parse(out) : undefined };
  }
  const docker = Bun.which("docker");

  test.skipIf(!docker)(
    "fica em ~/regents e nada nela tem o nome antigo: projeto, imagem, hostname, tag e banco",
    async () => {
      const w = await world();
      const installer = await w.release("1.2.3");
      const r = await w.run(installer, [], { env: SETUP_ENV });
      expect(r.code, r.output).toBe(0);
      expect(w.installDir).toBe(join(w.home, "regents"));

      const { config, err } = await composeConfig(w.installDir);
      expect(config, err).toBeDefined();
      expect(config.name).toBe("regents");
      expect(config.services.app.image).toBe("ghcr.io/rfl-designer/regents:1.2.3");
      expect(config.services.backup.image).toBe("ghcr.io/rfl-designer/regents:1.2.3");
      expect(config.services.tailscale.hostname).toBe("regents");
      expect(config.services.tailscale.environment.TS_HOSTNAME).toBe("regents");
      expect(config.services.tailscale.environment.TS_EXTRA_ARGS).toBe("--advertise-tags=tag:regents");
      expect(config.services.postgres.environment).toMatchObject({ POSTGRES_USER: "regents", POSTGRES_DB: "regents" });
      expect(config.services.app.environment.DATABASE_URL).toBe("postgres://regents@postgres:5432/regents");
      expect(config.services.app.environment.REGENTS_VAPID_CONTACT).toBe("mailto:rafa@example.com");
      expect(JSON.stringify(config)).not.toMatch(/shearim/i);
    },
  );

  test.skipIf(!docker)("o hostname, a tag e o papel e o banco do Postgres vêm do .env", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    expect((await w.run(installer, [], { env: SETUP_ENV })).code).toBe(0);
    const env = join(w.installDir, ".env");
    await Bun.write(
      env,
      `${readFileSync(env, "utf8")}TS_HOSTNAME=shearim\nREGENTS_TAILNET_TAG=tag:shearim\nREGENTS_POSTGRES_USER=shearim\nREGENTS_POSTGRES_DB=shearim\n`,
    );

    const { config, err } = await composeConfig(w.installDir);
    expect(config, err).toBeDefined();
    expect(config.services.tailscale.hostname).toBe("shearim");
    expect(config.services.tailscale.environment.TS_EXTRA_ARGS).toBe("--advertise-tags=tag:shearim");
    expect(config.services.postgres.environment).toMatchObject({ POSTGRES_USER: "shearim", POSTGRES_DB: "shearim" });
    expect(config.services.postgres.healthcheck.test).toEqual(["CMD", "pg_isready", "-U", "shearim", "-d", "shearim"]);
    expect(config.services.app.environment.DATABASE_URL).toBe("postgres://shearim@postgres:5432/shearim");
    expect(config.services.backup.environment.DATABASE_URL).toBe("postgres://shearim@postgres:5432/shearim");
  });

  test.skipIf(!docker)(
    "sem REGENTS_VAPID_CONTACT no .env, o compose não fecha e diz para rodar o instalador novo com --update",
    async () => {
      const w = await world();
      const installer = await w.release("1.2.3");
      expect((await w.run(installer, [], { env: SETUP_ENV })).code).toBe(0);
      await Bun.write(join(w.installDir, ".env"), "SHEARIM_VAPID_CONTACT=mailto:rafa@example.com\n");

      const { code, err } = await composeConfig(w.installDir);
      expect(code).not.toBe(0);
      expect(err).toContain("REGENTS_VAPID_CONTACT");
      expect(err).toContain("rode o instalador novo com --update (veja o README)");
    },
  );

  test("a tailnet sem a tag: o setup diz para pôr tag:regents nos tagOwners", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.set("tailnet.json", tailnetStatus({ tagged: false }));

    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("FALTA: o nó não tem a tag tag:regents");
    expect(r.stdout).toMatch(/tag:regents.*tagOwners|tagOwners.*tag:regents/);
    expect(w.calls()).not.toContain("docker compose pull");
  });

  test("as mensagens do instalador e do setup dizem Regents", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("docker");
    w.hide("colima");
    rmSync(join(w.state, "docker-up"));

    const r = await w.run(installer, [], { env: SETUP_ENV, answers: ["n"] });
    expect(r.stderr).toContain("o Regents roda no Docker");
    expect(r.output).not.toMatch(/shearim/i);
  });
});

describe("em qualquer sistema", () => {
  test("sem o curl: para antes de tudo e diz o que falta", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.hide("curl");

    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("falta o curl");
    expect(w.calls()).toEqual(["uname -s"]);
  });

  test("uma release que não existe: diz o endereço que falhou e não cria a Instalação", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");

    const r = await w.run(installer, ["--version", "v9.9.9"], { env: SETUP_ENV });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("releases/download/v9.9.9/regents-compose.tar.gz");
    expect(existsSync(w.installDir)).toBe(false);
  });

  test("com a tailnet sem MagicDNS e HTTPS: não sobe o app, e o checklist mostra o que falta", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.set("tailnet.json", tailnetStatus({ magicDNS: false, https: false }));

    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("FALTA: MagicDNS");
    const { todo } = checklist(r.stdout);
    expect(todo).toContain("MagicDNS ligado na tailnet");
    expect(todo).toContain("HTTPS ligado na tailnet");
    expect(todo).toContain("O Regents respondeu");
    expect(w.calls()).not.toContain("docker compose pull");
    expect(r.stdout).toContain(`sh ${join(w.installDir, "deploy/install.sh")}`);
  });

  test("rodar de novo não troca os segredos nem o .env", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    expect((await w.run(installer, [], { env: SETUP_ENV })).code).toBe(0);
    const read = (f: string) => readFileSync(join(w.installDir, f), "utf8");
    const before = ["secrets/master_key", "secrets/postgres_password", ".env"].map(read);

    const r = await w.run(installer, [], { env: { ...SETUP_ENV, REGENTS_CONTACT_EMAIL: "outra@example.com" } });
    expect(r.code, r.output).toBe(0);
    expect(["secrets/master_key", "secrets/postgres_password", ".env"].map(read)).toEqual(before);
  });

  test("o instalador do repositório (sem tag) instala a última release; --version escolhe outra", async () => {
    const w = await world();
    await w.release("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    const fromRepo = join(REPO_ROOT, "deploy/install.sh");

    const latest = await w.run(fromRepo, [], { env: SETUP_ENV });
    expect(latest.code, latest.output).toBe(0);
    expect(w.calls().some((c) => c.startsWith(download()))).toBe(true);
    expect(latest.stdout).toContain("ok: release v1.3.0");
    expect(readFileSync(join(w.installDir, "compose.yaml"), "utf8")).toContain(composeTag("1.3.0"));

    const pinned = await w.run(fromRepo, ["--version", "v1.2.3", "--dir", join(w.root, "outra")], { env: SETUP_ENV });
    expect(pinned.code, pinned.output).toBe(0);
    expect(w.calls().some((c) => c.startsWith(download("v1.2.3")))).toBe(true);
    expect(readFileSync(join(w.root, "outra/compose.yaml"), "utf8")).toContain(composeTag("1.2.3"));
  });

  test("sem terminal e sem TS_AUTHKEY: diz como passar a auth key e o e-mail, antes de mexer no Docker", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");

    const r = await w.run(installer, []);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("TS_AUTHKEY=");
    expect(r.stderr).toContain("REGENTS_CONTACT_EMAIL=");
    expect(w.calls().filter((c) => c.startsWith("docker compose"))).toEqual([]);
  });

  test("recusa um sistema que não é Mac nem Linux", async () => {
    const w = await world();
    const installer = await w.release("1.2.3");
    w.set("os", "FreeBSD");
    const r = await w.run(installer, [], { env: SETUP_ENV });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Mac ou Linux");
  });
});
