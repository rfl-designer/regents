/**
 * A atualização (`deploy/update.sh`; Spec, história 8): baixa o compose da release, mantém as
 * configurações no `.env` (e os segredos) e roda `docker compose pull` e `docker compose up -d`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeTag, SETUP_ENV, type World, world } from "./world";

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
    const order = [
      "gh release download v1.3.0",
      "docker compose config -q",
      "docker login ghcr.io",
      "docker compose pull",
      "docker compose up -d",
    ].map((want) => calls.findIndex((c) => c.startsWith(want)));
    expect(
      order.every((i) => i >= 0),
      calls.join("\n"),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nem setup de novo, nem nada instalado.
    expect(calls.filter((c) => /^(brew|sudo|curl|launchctl)|up -d tailscale/.test(c))).toEqual([]);

    expect(compose(w)).toContain(composeTag("1.3.0"));
    expect(snapshot(w)).toEqual(before);
    expect(r.stdout).toContain("de 1.2.3 para 1.3.0");
  });

  test("com uma versão: vai para ela", async () => {
    const w = await installed("1.2.3");
    await w.release("1.2.4");

    const r = await w.run(join(w.installDir, "deploy/update.sh"), ["v1.2.4"]);
    expect(r.code, r.output).toBe(0);
    expect(compose(w)).toContain(composeTag("1.2.4"));
  });

  test("avisa quando o .env fixa SHEARIM_VERSION", async () => {
    const w = await installed("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    const env = join(w.installDir, ".env");
    await Bun.write(env, `${readFileSync(env, "utf8")}SHEARIM_VERSION=1.2.3\n`);

    const r = await w.run(join(w.installDir, "deploy/update.sh"));
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("SHEARIM_VERSION=1.2.3");
  });

  test("se o compose novo não fecha com o .env: volta o de antes e não reinicia nada", async () => {
    const w = await installed("1.2.3");
    await w.release("1.3.0");
    w.set("latest", "v1.3.0");
    w.set("config-fails");
    const n = w.calls().length;

    const r = await w.run(join(w.installDir, "deploy/update.sh"));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("SHEARIM_VAPID_CONTACT");
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
