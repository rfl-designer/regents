import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const ATUALIZANDO = "Atualizando o Shearim";

/** Uma porta livre agora, para o Shearim próprio deste teste subir e voltar nela. */
function freePort() {
  return new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("sem porta"))));
    });
  });
}

/**
 * Um Shearim só deste teste (o da execução é de todos e não pode cair), num PGlite em disco
 * para sobreviver ao reinício. `update()` é o `docker compose stop`: SIGTERM e espera sair.
 * `start()` é a versão nova subindo na mesma porta.
 */
const updateTest = test.extend<{
  shearim: { url: string; update(): Promise<void>; start(): Promise<void> };
}>({
  // biome-ignore lint/correctness/noEmptyPattern: o runner exige `({}, use)` num fixture sem dependências.
  shearim: async ({}, use) => {
    const port = await freePort();
    const data = mkdtempSync(join(tmpdir(), "shearim-e2e-atualizacao-"));
    let proc: ChildProcess | undefined;
    const url = `http://127.0.0.1:${port}`;

    const log = join(data, "app.log");
    const start = async () => {
      const out = openSync(log, "a");
      proc = spawn("bun", [resolve(import.meta.dirname, "../serve.ts")], {
        env: {
          ...process.env,
          SHEARIM_IDENTITY: "dev",
          HOST: "127.0.0.1",
          PORT: String(port),
          SHEARIM_PGLITE_DIR: join(data, "pglite"),
          SHEARIM_ACCOUNTS_DIR: join(data, "contas"),
        },
        stdio: ["ignore", out, out],
      });
      closeSync(out);
      const healthy = () =>
        fetch(`${url}/api/health`).then(
          (r) => r.ok,
          () => false,
        );
      // Até 60 s: com a máquina carregada, as migrações num PGlite em disco demoram.
      for (let i = 0; i < 300; i++) {
        if (await healthy()) return;
        if (proc.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`o Shearim do teste não subiu em ${url}:\n${readFileSync(log, "utf8").slice(-2_000)}`);
    };
    const update = async () => {
      const running = proc;
      if (!running || running.exitCode !== null) return;
      const exited = new Promise((r) => running.once("exit", r));
      running.kill("SIGTERM");
      await exited;
    };

    await start();
    await use({ url, update, start });
    proc?.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  },
});

describe("atualização do Shearim", () => {
  updateTest(
    'mostra a faixa "Atualizando o Shearim" enquanto o servidor reinicia',
    async ({ app, screen, shearim }) => {
      await app.open(`${shearim.url}/`);
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");

      await shearim.update();

      await expect(screen.getByText(ATUALIZANDO)).toBeVisible();
    },
  );

  updateTest("a faixa some quando a versão nova sobe", async ({ app, screen, shearim }) => {
    await app.open(`${shearim.url}/`);
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    await shearim.update();
    await screen.getByText(ATUALIZANDO).waitFor();

    await shearim.start();

    await expect(screen.getByText(ATUALIZANDO)).toBeHidden();
  });
});
