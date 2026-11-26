/**
 * O empacotamento da release (`deploy/release.sh`, rodado pelo workflow de release): o que o
 * instalador e a atualização baixam com o `curl`, das releases públicas. Spec, módulo 13 ("Imagem" e "Distribuição").
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, sandbox } from "./sandbox";

const RELEASE = join(REPO_ROOT, "deploy/release.sh");

async function unpack(s: ReturnType<typeof sandbox>, out: string) {
  const r = await s.run("-c", [`mkdir -p x && tar -xzf ${out}/regents-compose.tar.gz -C x && find x -type f | sort`]);
  return r.stdout.split("\n").filter(Boolean);
}

describe("deploy/release.sh", () => {
  test("empacota o compose com a tag fixa da versão, sem build, e o que a Instalação precisa", async () => {
    const s = sandbox();
    const out = join(s.root, "dist");
    const r = await s.run(RELEASE, ["1.2.3", out]);
    expect(r.code, r.output).toBe(0);

    expect(await unpack(s, out)).toEqual([
      "x/compose.yaml",
      "x/deploy/install.sh",
      "x/deploy/setup.sh",
      "x/deploy/tailscale/serve.json",
      "x/deploy/update.sh",
    ]);
    const compose = readFileSync(join(s.root, "x/compose.yaml"), "utf8");
    expect(compose).toContain(`image: \${REGENTS_IMAGE:-ghcr.io/rfl-designer/regents}:\${REGENTS_VERSION:-1.2.3}`);
    expect(compose).toContain(`REGENTS_VERSION: \${REGENTS_VERSION:-1.2.3}`);
    expect(compose).not.toContain(":-local}");
    expect(compose).not.toMatch(/^\s*build:/m);

    // O updater antigo, de uma Instalação que ainda é Shearim, baixa o pacote pelo nome antigo.
    expect(readFileSync(join(out, "shearim-compose.tar.gz"))).toEqual(
      readFileSync(join(out, "regents-compose.tar.gz")),
    );

    // O instalador da release instala a própria versão.
    const installer = readFileSync(join(out, "install.sh"), "utf8");
    expect(installer).toContain('RELEASE_TAG="v1.2.3"');
    expect(readFileSync(join(s.root, "x/deploy/install.sh"), "utf8")).toBe(installer);
  });

  test("recusa latest e o que não é uma versão", async () => {
    const s = sandbox();
    for (const bad of ["latest", "", "v1.2.3", "1.2"]) {
      const r = await s.run(RELEASE, [bad, join(s.root, "dist")]);
      expect(r.code, `versão "${bad}"`).not.toBe(0);
      expect(r.stderr).toContain("versão");
    }
  });
});

describe("compose.yaml", () => {
  const compose = readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8");
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1] ?? "");

  test("as imagens de terceiros ficam fixadas por versão e digest", () => {
    const third = images.filter((i) => !i.includes("REGENTS_IMAGE"));
    expect(third.map((i) => i.split(":")[0])).toEqual(["tailscale/tailscale", "postgres"]);
    for (const image of third) expect(image).toMatch(/^[a-z/]+:v?\d+\.\d+(\.\d+)?[-a-z]*@sha256:[0-9a-f]{64}$/);
  });

  test("nenhuma imagem usa latest", () => {
    for (const image of images) expect(image).not.toMatch(/latest/);
  });
});

describe("scripts de deploy/", () => {
  const shellcheck = Bun.which("shellcheck");
  test.skipIf(!shellcheck)("passam limpos no shellcheck", async () => {
    const scripts = ["install.sh", "update.sh", "setup.sh", "release.sh"].map((f) => join(REPO_ROOT, "deploy", f));
    const proc = Bun.spawn([shellcheck ?? "shellcheck", "--shell=sh", ...scripts], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited, out).toBe(0);
  });
});

describe(".github/workflows/release.yml", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");

  test("publica no GHCR só a tag da versão e anexa o que o instalador baixa", () => {
    const tags = [...workflow.matchAll(/^\s*tags:\s*(ghcr\.io.+)$/gm)].map((m) => m[1]);
    expect(tags).toEqual([`ghcr.io/\${{ github.repository }}:\${{ steps.version.outputs.version }}`]);
    const code = workflow.replace(/#.*$/gm, "");
    expect(code).not.toContain("latest");
    expect(workflow).toContain(`deploy/release.sh "\${{ steps.version.outputs.version }}" dist`);
    expect(workflow).toContain("dist/shearim-compose.tar.gz dist/install.sh");
  });
});
