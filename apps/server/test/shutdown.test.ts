import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EVENTS_CLOSE_UPDATING, EVENTS_PATH } from "@regents/contracts";
import { onCleanup, throwawayAccounts } from "./harness";

const MAIN = resolve(import.meta.dir, "../src/main.ts");

/** O servidor de verdade (`main.ts serve`), com a identidade de dev e um PGlite em memória. */
async function realServer() {
  const { config } = throwawayAccounts();
  const secrets = mkdtempSync(join(tmpdir(), "shearim-shutdown-"));
  onCleanup(() => rmSync(secrets, { recursive: true, force: true }));
  const masterKey = join(secrets, "master_key");
  writeFileSync(masterKey, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));

  const proc = Bun.spawn(["bun", MAIN, "serve"], {
    env: {
      ...process.env,
      REGENTS_IDENTITY: "dev",
      HOST: "127.0.0.1",
      PORT: "0",
      REGENTS_PGLITE_DIR: "memory://",
      REGENTS_WEB_DIST: join(secrets, "sem-pwa"),
      REGENTS_CLAUDE_BIN: config.claudeBin,
      REGENTS_ACCOUNTS_DIR: config.root,
      REGENTS_MASTER_KEY_FILE: masterKey,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  onCleanup(() => proc.kill("SIGKILL"));

  // A linha "ouvindo em http://127.0.0.1:<porta>" diz a porta que o sistema deu.
  const reader = proc.stdout.getReader();
  let out = "";
  let origin: string | undefined;
  while (!origin) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`o servidor saiu antes de ouvir:\n${out}`);
    out += new TextDecoder().decode(value);
    origin = out.match(/ouvindo em http:\/\/([\d.]+:\d+)/)?.[1];
  }
  reader.releaseLock();
  return { proc, origin };
}

describe("encerramento do processo", () => {
  test("no SIGTERM com WebSocket aberto, o cliente recebe 1012 e o processo sai logo", async () => {
    const { proc, origin } = await realServer();
    // A Pessoa Dev entra (vira Membro) e abre o WebSocket de eventos.
    expect((await fetch(`http://${origin}/api/me`)).status).toBe(200);
    const ws = new WebSocket(`ws://${origin}${EVENTS_PATH}`);
    await new Promise((r) => ws.addEventListener("message", r, { once: true }));
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code), { once: true }));

    const inicio = Date.now();
    proc.kill("SIGTERM");
    const code = await closed;
    const exitCode = await proc.exited;

    expect(code).toBe(EVENTS_CLOSE_UPDATING);
    expect(exitCode).toBe(0);
    // Sem o 1012, o `server.stop()` ficava esperando a conexão e o processo levava mais de 8 s.
    expect(Date.now() - inicio).toBeLessThan(5_000);
  }, 60_000);
});
