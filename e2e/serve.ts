/**
 * O app do e2e com os dublês nas pontas: sobe a Messages API falsa (que responde devagar, para a
 * bolha "escrevendo" ficar à vista) e o servidor de verdade apontado para ela, com uma chave
 * mestra temporária. O runner do e2e chama `bun serve.ts` e encerra com SIGTERM.
 *
 * Variáveis: as do servidor (PORT, HOST...) passam direto; `FAKE_MESSAGES_API_DELAY_MS` é a
 * espera entre pedaços da resposta (padrão 400 ms).
 *
 * O servidor aceita o certificado do push service falso que os testes sobem
 * (`support/push-service.ts`), para o "parou em" de um aparelho sair de um `410` de verdade.
 *
 * Uma mensagem com `[falhe Nx]` no texto recebe a sobrecarga da Anthropic (529) nas N primeiras
 * chamadas e a resposta padrão depois: `[falhe 2x]` passa pelas duas tentativas e chega ao
 * cartão de falha com "Tentar de novo". Com `[chave recusada]`, a Anthropic recusa a Chave (401
 * `authentication_error`): abre o incidente da Chave, que a próxima resposta bem-sucedida encerra.
 *
 * O roteamento da Articuladora (o pedido com `output_config`) nunca falha: uma mensagem com
 * `[delegar]` é passada aos dois primeiros Agentes do Canal; as outras recebem o Desfecho "nenhum".
 *
 * As Contas usam o `fake-claude` (nunca o binário `claude` de verdade): o login aceita
 * `FAKE_LOGIN_CODE` e entra numa conta cujo login vence daqui a 4 dias (a validade, 3 dias antes,
 * cai amanhã: "Minha Conta" já abre em destaque, com o selo no menu pessoal).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeClaude } from "../apps/server/test/fake-claude";
import {
  type FakeReply,
  lastUserText,
  type RecordedRequest,
  startFakeMessagesApi,
} from "../apps/server/test/fakes/messages-api";
import { pushServiceCert } from "../apps/server/test/fakes/push-cert";

const delayMs = Number(process.env.FAKE_MESSAGES_API_DELAY_MS ?? 400);
const failures = new Map<string, number>();
const anthropic = await startFakeMessagesApi({
  defaultReply: (req) => {
    if (req.body.output_config) return desfecho(req);
    // O contexto leva as mensagens recentes num só `user`, uma por parágrafo, e fecha com
    // "Responda à última mensagem…": a de origem é o penúltimo parágrafo.
    const text = lastUserText(req.body).split("\n\n").at(-2) ?? "";
    if (text.includes("[chave recusada]")) {
      return { status: 401, errorType: "authentication_error", errorMessage: "invalid x-api-key" };
    }
    const times = Number(text.match(/\[falhe (\d+)x\]/)?.[1] ?? 0);
    const failed = failures.get(text) ?? 0;
    if (failed < times) {
      failures.set(text, failed + 1);
      return { status: 529, errorType: "overloaded_error", errorMessage: "Overloaded" };
    }
    return { text: "Oi! Tudo certo por aqui: o prazo é sexta-feira.", delayMs };
  },
});
/** O Desfecho do roteamento, pelo marcador no texto da mensagem e pelos Agentes do Canal no `system`. */
function desfecho(req: RecordedRequest): FakeReply {
  const system = typeof req.body.system === "string" ? req.body.system : "";
  const canal = system.split("## Agentes do Canal")[1]?.split("\n## ")[0] ?? "";
  const handles = [...canal.matchAll(/^- @(\w+)/gm)].map((m) => m[1]!).slice(0, 2);
  if (lastUserText(req.body).includes("[delegar]") && handles.length) {
    return {
      json: {
        decisao: "delegar",
        agentes: handles.map((agente) => ({ agente, cobrir: `A parte de @${agente}.` })),
        motivo: "Cada um cobre uma parte.",
      },
      delayMs: 0,
    };
  }
  return { json: { decisao: "nenhum", agentes: [], motivo: "É conversa entre pessoas." } };
}

const claude = fakeClaude({
  login: { account: { loginExpiresAt: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString() } },
});

const secretsDir = mkdtempSync(join(tmpdir(), "shearim-e2e-secrets-"));
const masterKeyFile = join(secretsDir, "master_key");
writeFileSync(masterKeyFile, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });

const server = Bun.spawn(["bun", resolve(import.meta.dir, "../apps/server/src/main.ts"), "serve"], {
  env: {
    ...process.env,
    SHEARIM_ANTHROPIC_BASE_URL: anthropic.url,
    SHEARIM_MASTER_KEY_FILE: masterKeyFile,
    SHEARIM_CLAUDE_BIN: claude.bin,
    // O push service falso dos testes (`support/push-service.ts`) fala HTTPS com este certificado.
    NODE_EXTRA_CA_CERTS: pushServiceCert().certFile,
  },
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
  claude.dispose();
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const code = await server.exited;
if (!stopping) {
  await anthropic.stop();
  rmSync(secretsDir, { recursive: true, force: true });
  claude.dispose();
  process.exit(code);
}
