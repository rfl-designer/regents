/**
 * O app do e2e com os dublês nas pontas: sobe a Messages API falsa (que responde devagar, para a
 * bolha "escrevendo" ficar à vista) e o servidor de verdade apontado para ela, com uma chave
 * mestra temporária. O runner do e2e chama `bun serve.ts` e encerra com SIGTERM.
 *
 * Variáveis: as do servidor (PORT, HOST...) passam direto; `FAKE_MESSAGES_API_DELAY_MS` é a
 * espera entre pedaços da resposta (padrão 400 ms).
 *
 * Uma mensagem com `[falhe Nx]` no texto recebe a sobrecarga da Anthropic (529) nas N primeiras
 * chamadas e a resposta padrão depois: `[falhe 2x]` passa pelas duas tentativas e chega ao
 * cartão de falha com "Tentar de novo".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lastUserText, startFakeMessagesApi } from "../apps/server/test/fakes/messages-api";

const delayMs = Number(process.env.FAKE_MESSAGES_API_DELAY_MS ?? 400);
const failures = new Map<string, number>();
const anthropic = await startFakeMessagesApi({
  defaultReply: (req) => {
    const text = lastUserText(req.body);
    const times = Number(text.match(/\[falhe (\d+)x\]/)?.[1] ?? 0);
    const failed = failures.get(text) ?? 0;
    if (failed < times) {
      failures.set(text, failed + 1);
      return { status: 529, errorType: "overloaded_error", errorMessage: "Overloaded" };
    }
    return { text: "Oi! Tudo certo por aqui: o prazo é sexta-feira.", delayMs };
  },
});
const secretsDir = mkdtempSync(join(tmpdir(), "shearim-e2e-secrets-"));
const masterKeyFile = join(secretsDir, "master_key");
writeFileSync(masterKeyFile, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });

const server = Bun.spawn(["bun", resolve(import.meta.dir, "../apps/server/src/main.ts"), "serve"], {
  env: { ...process.env, SHEARIM_ANTHROPIC_BASE_URL: anthropic.url, SHEARIM_MASTER_KEY_FILE: masterKeyFile },
  stdio: ["inherit", "inherit", "inherit"],
});

let stopping = false;
async function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  await server.exited;
  await anthropic.stop();
  rmSync(secretsDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const code = await server.exited;
if (!stopping) {
  await anthropic.stop();
  rmSync(secretsDir, { recursive: true, force: true });
  process.exit(code);
}
