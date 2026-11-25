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
 * Com `[listar agentes]`, o Agente que tem a Ferramenta "listar Agentes" a pede; a resposta
 * seguinte começa por "Pela Ferramenta:" e traz a primeira linha do resultado. Com `[postar]`, o
 * Agente que tem "postar mensagem" pede para postar "Aviso: a reunião mudou." no #geral, o que vira
 * Pedido de aprovação; a continuação responde o padrão.
 *
 * Sobe também um CRM falso (servidor MCP remoto, `startRemoteMcp`) que aceita o token `crm-e2e`, com
 * a leitura `buscar_cliente`, e oferece login (OAuth: o `/authorize` dele aprova na hora); o
 * endereço e o token ficam em `.e2e/crm-<PORT>.json`, para o teste adicionar o Conector. Com `[crm]`, o Agente que tem a Ferramenta dele a pede, e a resposta seguinte sai bem
 * devagar (2 s por pedaço), para o Andamento com o uso dela ficar à vista.
 *
 * O roteamento da Articuladora (o pedido com `output_config`) nunca falha: uma mensagem com
 * `[delegar]` é passada aos dois primeiros Agentes do Canal; as outras recebem o Desfecho "nenhum".
 *
 * A extração da Memória (reconhecida pelo schema, `operacoes`) não guarda nada, a não ser que a
 * mensagem de pessoa que o Agente respondeu traga `[lembrar: <texto>]`: aí ela guarda o texto na
 * Memória da Conversa.
 *
 * O GitHub é o falso dos testes do servidor (`test/fakes/github-api.ts`), com `time/site` e
 * `time/infra` na conta do time: criar o App e instalá-lo passam por ele (o "navegador do Admin"
 * pode ser um `fetch` que segue os redirecionamentos à mão).
 *
 * As Contas usam o `fake-claude` (nunca o binário `claude` de verdade): o login aceita
 * `FAKE_LOGIN_CODE` e entra numa conta cujo login vence daqui a 4 dias (a validade, 3 dias antes,
 * cai amanhã: "Minha Conta" já abre em destaque, com o selo no menu pessoal).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeClaude } from "../apps/server/test/fake-claude";
import { startFakeGitHub } from "../apps/server/test/fakes/github-api";
import {
  type FakeReply,
  lastUserText,
  type RecordedRequest,
  startFakeMessagesApi,
  toolResults,
} from "../apps/server/test/fakes/messages-api";
import { pushServiceCert } from "../apps/server/test/fakes/push-cert";
import { startRemoteMcp } from "../apps/server/test/fakes/remote-mcp";

const crm = startRemoteMcp({
  token: "crm-e2e",
  // Ele também oferece login (OAuth): "Ligar pelo login" vai ao `/authorize` dele e volta ao app.
  oauth: {},
  tools: [
    {
      name: "buscar_cliente",
      title: "buscar cliente",
      description: "Busca um cliente pelo nome.",
      readOnlyHint: true,
      handler: () => "Cliente Acme: plano Ouro.",
    },
  ],
});
mkdirSync(".e2e", { recursive: true });
// Um arquivo por app (pela porta): o runner pode subir mais de um ao mesmo tempo.
writeFileSync(`.e2e/crm-${process.env.PORT}.json`, JSON.stringify({ url: crm.url, token: "crm-e2e" }));

const delayMs = Number(process.env.FAKE_MESSAGES_API_DELAY_MS ?? 400);
const failures = new Map<string, number>();
const anthropic = await startFakeMessagesApi({
  defaultExtraction: lembrar,
  defaultReply: (req) => {
    if (req.body.output_config) return desfecho(req);
    const [resultado] = toolResults(req.body);
    if (resultado) {
      // Só o resultado da Ferramenta do CRM (bem ou mal): o de "listar Agentes" pode citar "buscar cliente".
      // O resultado bem-sucedido vem marcado como dado (`<resultado_de_ferramenta …>`): a primeira linha é o conteúdo.
      const content = resultado.content.replace(/^<resultado_de_ferramenta[^>]*>\n/, "");
      const slow = /^(Cliente |A Ferramenta buscar cliente )/.test(content);
      return { text: `Pela Ferramenta: ${content.split("\n")[0]}`, delayMs: slow ? 2000 : delayMs };
    }
    // O contexto leva as mensagens recentes num só `user`, uma por parágrafo, e fecha com
    // "Responda à última mensagem…": a de origem é o penúltimo parágrafo.
    const text = lastUserText(req.body).split("\n\n").at(-2) ?? "";
    if (text.includes("[chave recusada]")) {
      return { status: 401, errorType: "authentication_error", errorMessage: "invalid x-api-key" };
    }
    const tools = (req.body.tools as { name: string }[] | undefined) ?? [];
    if (text.includes("[listar agentes]") && tools.some((t) => t.name === "listar_agentes")) {
      return { toolUse: [{ name: "listar_agentes" }], delayMs };
    }
    const doCrm = tools.find((t) => t.name.endsWith("__buscar_cliente"));
    if (text.includes("[crm]") && doCrm) return { toolUse: [{ name: doCrm.name, input: { nome: "Acme" } }], delayMs };
    if (text.includes("[postar]") && tools.some((t) => t.name === "postar_mensagem")) {
      return {
        toolUse: [{ name: "postar_mensagem", input: { conversa: "#geral", texto: "Aviso: a reunião mudou." } }],
        delayMs,
      };
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
/**
 * A extração da Memória: guarda o `[lembrar: …]` da última mensagem de pessoa da troca (a que o
 * Agente respondeu). A entrada traz as mensagens de pessoa, uma por parágrafo, antes da resposta.
 */
function lembrar(req: RecordedRequest): FakeReply {
  const pessoas = lastUserText(req.body).split("## A resposta de")[0] ?? "";
  const ultima = pessoas.trim().split("\n\n").at(-1) ?? "";
  const texto = ultima.match(/\[lembrar: ([^\]]+)\]/)?.[1];
  return { json: { operacoes: texto ? [{ acao: "criar", texto }] : [] }, delayMs: 0 };
}

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

// O GitHub falso, com dois repositórios na conta do time: a instalação alcança os dois.
const github = await startFakeGitHub();
github.repo({ fullName: "time/site", files: { "README.md": "# Site" } });
github.repo({ fullName: "time/infra", files: { "main.tf": "# infra" } });

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
    SHEARIM_GITHUB_URL: github.config.webUrl,
    SHEARIM_GITHUB_API_URL: github.config.apiUrl,
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
  await crm.stop();
  github.stop();
  rmSync(secretsDir, { recursive: true, force: true });
  claude.dispose();
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const code = await server.exited;
if (!stopping) {
  await anthropic.stop();
  await crm.stop();
  github.stop();
  rmSync(secretsDir, { recursive: true, force: true });
  claude.dispose();
  process.exit(code);
}
