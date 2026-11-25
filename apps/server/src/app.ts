import { EVENTS_PATH } from "@shearim/contracts";
import type { Server } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { accountPushes } from "./account-pushes";
import { type AccountHooks, type AccountsConfig, createAccounts } from "./accounts";
import { processTracker } from "./accounts/claude-cli";
import { adminPushes } from "./admin-pushes";
import { createAgentPoster } from "./agent-posts";
import { agentRoutes } from "./agents";
import { approvalRoutes } from "./approvals";
import type { Clock } from "./clock";
import { conversationRoutes } from "./conversations";
import type { Db } from "./db/client";
import { dmRoutes } from "./dms";
import { createEventHub } from "./events";
import { createExecutions, type ExecutionHooks, type ExecutionLimits } from "./executions";
import { createGitHub, type GitHubConfig } from "./github/connector";
import { githubRoutes } from "./github/routes";
import { githubTools } from "./github/tools";
import type { Identity, IdentityPort } from "./identity/port";
import { IdentityUnavailableError } from "./identity/whois";
import { createInstallation, type InstallationConfig } from "./installation/status";
import { type JoinRequestHooks, joinRequestAdminRoutes, myJoinRequestRoutes } from "./join-requests";
import { createKeyLedger, type KeyHooks } from "./key-budget";
import { memberAdminRoutes } from "./member-admin";
import { type Env, listMembers, memberFor } from "./members";
import { accountBrain } from "./model/account";
import { keyBrain } from "./model/key";
import { createModelPort, type ModelBrain } from "./model/port";
import { noIdentityPage } from "./no-identity-page";
import { createPresence } from "./presence";
import { profileRoutes } from "./profile";
import { createPush, type PushConfig } from "./push";
import { createReading, unreadOf } from "./reading";
import type { SecretBox } from "./secrets";
import { threadRoutes } from "./threads";
import { createConnectors } from "./tools/connectors";
import { createMcpEndpoint } from "./tools/mcp";
import { createToolPort, type ToolDefinition } from "./tools/port";
import { agentToolRoutes } from "./tools/routes";
import { WEB_TOOLS } from "./tools/web";
import { WORKSPACE_TOOLS } from "./tools/workspace";
import { workspaceContextRoutes } from "./workspace-context";
import { workspaceKeyRoutes } from "./workspace-key";

export interface AppDeps {
  db: Db;
  identity: IdentityPort;
  clock: Clock;
  /** Binário `claude` e pasta-raiz das Contas (nos testes, o `fake-claude` e uma pasta temporária). */
  accounts: AccountsConfig;
  /** Cifra a Chave do Workspace com a chave mestra de `./secrets`. */
  secrets: SecretBox;
  /** Onde fica a Messages API (padrão: a da Anthropic). Os testes apontam para a falsa. */
  anthropicBaseUrl?: string;
  /**
   * Troca o cérebro da Chave (padrão: a Messages API em `anthropicBaseUrl`). Só para os testes
   * do que a Messages API falsa não sabe dizer (o `api_retry` do Claude Code, o progresso no meio).
   */
  keyBrain?: ModelBrain;
  /** Rotas só de desenvolvimento (`/dev/*`), vindas do adaptador de identidade de dev. */
  devRoutes?: Hono;
  /**
   * Ganchos de domínio de fora (os testes). Os do próprio app rodam antes: os pushes do Admin e
   * da Conta (#34) e o da falha (#32).
   */
  hooks?: AppHooks;
  /** O `sub` do VAPID e, nos testes, o agente HTTPS do coletor de push. */
  push: PushConfig;
  /** A versão que está rodando e de onde vem o vencimento da chave do nó (seção Instalação). */
  installation?: InstallationConfig;
  /** Os tetos de concorrência das execuções (padrão: 2 por Conta, 4 na Chave, 8 processos). */
  limits?: Partial<ExecutionLimits>;
  /**
   * A porta de Ferramentas: o prazo padrão de uma chamada (`SHEARIM_TOOL_TIMEOUT_S`), o teto de
   * turnos de Ferramenta de uma resposta (`SHEARIM_TOOL_MAX_TURNS`, padrão 20) e o catálogo
   * (padrão: as Ferramentas do Workspace; os testes juntam Ferramentas que travam ou falham).
   */
  tools?: { timeoutMs?: number; maxTurns?: number; definitions?: readonly ToolDefinition[] };
  /** Onde fica o GitHub (padrão: github.com). Os testes apontam para o falso. */
  github?: Partial<GitHubConfig>;
  /** O Pedido de aprovação: o prazo até expirar (`SHEARIM_APPROVAL_TTL_H`; padrão 24 h). */
  approvals?: { ttlMs?: number };
}

export type AppHooks = JoinRequestHooks & ExecutionHooks & KeyHooks & AccountHooks;

/** Os ganchos do próprio app (os pushes) e, depois deles, os que vieram de fora (os testes). */
function chain(own: AppHooks, extra: AppHooks = {}): AppHooks {
  type Hook = (...args: unknown[]) => void;
  const keys = new Set([...Object.keys(own), ...Object.keys(extra)]) as Set<keyof AppHooks>;
  const out: Record<string, Hook> = {};
  for (const key of keys) {
    out[key] = (...args) => {
      (own[key] as Hook | undefined)?.(...args);
      (extra[key] as Hook | undefined)?.(...args);
    };
  }
  return out as AppHooks;
}

const UNAVAILABLE = Symbol("identity_unavailable");

/**
 * O seam dos testes: tudo o que o app usa de fora entra por `deps`.
 * Nada de singleton global. `main.ts` monta as dependências reais.
 */
export function createApp(deps: AppDeps) {
  const { db, identity, clock, secrets } = deps;
  const app = new Hono<Env>();
  const { hub: events, route: eventsRoute, closeForRestart } = createEventHub();
  // A Presença diz ao push quem está vendo cada conversa; o push zera o "3 novas" de quem a abre.
  const presence = createPresence({ db, events });
  const push = createPush({
    events,
    db,
    clock,
    presence: presence.presence,
    config: deps.push,
    badgeOf: async (memberId) => (await unreadOf(db, memberId)).total,
  });
  presence.onOpened(push.conversationOpened);
  // Os pushes do Admin e da Conta (#34) e o da falha de vez ao autor (#32).
  const hooks = chain(
    {
      ...adminPushes({ db, notify: push.notify }),
      ...accountPushes({ db, clock, notify: push.notify }),
      executionFailed: push.executionFailed,
    },
    deps.hooks,
  );
  const accounts = createAccounts({ db, clock, events, config: deps.accounts, hooks });
  // Pela Conta, um `claude -p` por execução (ADR 0006); os processos vivos morrem no `close`.
  const runs = processTracker();
  // As Ferramentas pela Conta: o `claude -p` as lista e chama neste endpoint, só no loopback.
  const mcp = createMcpEndpoint();
  const model = createModelPort({
    key: deps.keyBrain ?? keyBrain({ baseURL: deps.anthropicBaseUrl }),
    account: accountBrain({
      claudeBin: deps.accounts.claudeBin,
      procs: runs,
      stopGrace: deps.accounts.stopGrace,
      mcp,
    }),
  });
  const reading = createReading({ db, clock, events });
  const ledger = createKeyLedger({ db, clock, events, hooks });
  // Os Conectores trazem as Ferramentas deles ao catálogo, lidas a cada uso.
  const connectors = createConnectors({ db, clock, secrets });
  // O GitHub, o Conector embutido (ADR 0010): as Ferramentas dele vêm depois das fixas.
  const github = createGitHub({ db, clock, secrets, config: deps.github });
  const tools = createToolPort({
    db,
    clock,
    definitions: [...(deps.tools?.definitions ?? [...WORKSPACE_TOOLS, ...WEB_TOOLS]), ...githubTools(github)],
    extra: connectors.definitions,
    timeoutMs: deps.tools?.timeoutMs,
  });
  // As mensagens novas (de pessoa e as respostas de Agente) vão ao push pelo mesmo `messageCreated`.
  const executions = createExecutions({
    db,
    clock,
    events,
    model,
    secrets,
    accounts,
    hooks,
    reading,
    push,
    ledger,
    tools,
    limits: deps.limits,
    maxToolTurns: deps.tools?.maxTurns,
    approvalTtlMs: deps.approvals?.ttlMs,
  });
  // A volta da Conta (ou a troca da Chave, ou do orçamento) solta quem espera por ela na fila.
  const reconsider = (memberId?: string) => void executions.reconsider(memberId).catch(() => {});
  accounts.onChanged(reconsider);

  const installation = createInstallation({ db, clock, events, push, config: deps.installation });

  /** Pergunta à porta; tailscaled fora do ar é falha da Instalação, não "sem identidade": vai para o log. */
  async function whoAmI(c: { req: { raw: Request }; env: unknown }): Promise<Identity | typeof UNAVAILABLE> {
    // O `env` do Hono no Bun é o servidor; sem ele (testes pelo `app.fetch`), não há peer.
    const peer = (c.env as Server<unknown> | undefined)?.requestIP?.(c.req.raw)?.address;
    try {
      return await identity.whoAmI(c.req.raw, peer);
    } catch (err) {
      if (!(err instanceof IdentityUnavailableError)) throw err;
      console.error(`shearim: ${err.message}`);
      return UNAVAILABLE;
    }
  }

  app.get("/api/health", (c) => c.json({ ok: true }));
  if (deps.devRoutes) app.route("/dev", deps.devRoutes);

  // Fora de /api e /dev é o PWA (servido pelo main.ts). Sem identidade, no lugar dele vem
  // a página estática com o motivo (ADR 0007). Com identidade, segue para o PWA.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/dev/")) return next();
    const who = await whoAmI(c);
    if (who === UNAVAILABLE) return c.text("O Shearim não conseguiu falar com o tailscaled. Veja o log do app.", 503);
    if (who.kind === "none") return c.html(noIdentityPage(who.reason), 403);
    await next();
  });

  // Toda rota em /api (menos a saúde) exige identidade.
  app.use("/api/*", async (c, next) => {
    const who = await whoAmI(c);
    if (who === UNAVAILABLE) return c.json({ error: "identity_unavailable" }, 503);
    if (who.kind === "none") return c.json({ error: "no_identity", reason: who.reason }, 403);
    c.set("who", who);
    const member = await memberFor(db, clock, who);
    if (member) c.set("member", member);
    await next();
  });

  // O próprio Pedido de entrada é a única coisa que quem ainda não é Membro alcança.
  app.route("/api/join-request", myJoinRequestRoutes({ db, clock, events, hooks }));

  // Daqui em diante, só Membro.
  app.use("/api/*", async (c, next) => {
    if (!c.get("member")) return c.json({ error: "not_a_member" }, 403);
    await next();
  });

  app.route("/api/me", profileRoutes({ db, clock, events }));
  app.get("/api/members", async (c) => c.json(await listMembers(db)));
  app.route("/api", memberAdminRoutes({ db, clock, events, executions, accounts, push }));
  app.get(EVENTS_PATH, eventsRoute);
  app.route("/api/join-requests", joinRequestAdminRoutes({ db, clock, events, hooks }));
  app.route("/api", conversationRoutes({ db, clock, events, executions, reading, push }));
  app.route("/api", presence.routes);
  app.route("/api", push.routes);
  app.route("/api", dmRoutes({ db, clock, events }));
  app.route("/api", reading.routes);
  app.route("/api", threadRoutes({ db }));
  app.route("/api", accounts.routes);
  app.route("/api", agentRoutes({ db, clock, ledger, tools, onBudgetChanged: () => reconsider() }));
  app.route("/api", agentToolRoutes({ db, tools }));
  app.route("/api", connectors.routes);
  app.route(
    "/api",
    approvalRoutes({
      db,
      clock,
      events,
      tools,
      // A escrita aprovada posta como o Agente, sem Desfecho e sem acionar Agente.
      post: createAgentPoster({ db, clock, events, reading, push }),
      continueAfter: executions.continueAfter,
    }),
  );
  app.route("/api", workspaceKeyRoutes({ db, clock, secrets, onChanged: () => reconsider() }));
  app.route("/api", workspaceContextRoutes({ db }));
  app.route("/api", githubRoutes({ github }));
  app.route("/api", installation.routes);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  /**
   * `websocket` vai no `Bun.serve` junto com `app.fetch`; `events` é onde se publica.
   * `start()` faz a subida e põe a fila para andar; `executions.stop()` a para; `close` encerra o
   * que o app deixou rodando (os processos do `claude`).
   *
   * `drain` é o SIGTERM: fecha os WebSockets com 1012 (o PWA mostra "Atualizando o Shearim") e
   * espera a fila até `ms`. `halt` é o SIGINT: fecha os WebSockets igual e para a fila na hora.
   */
  return {
    app,
    websocket,
    events,
    executions,
    drain: (ms?: number) => {
      closeForRestart();
      return executions.drain(ms);
    },
    halt: () => {
      closeForRestart();
      return executions.stop();
    },
    push,
    /**
     * A subida: limpa as pastas de Conta (pastas de login órfãs, lock de renovação), liga a releitura
     * diária da validade das Contas, põe a fila para
     * andar e, com `installation.watch`, a verificação do backup e da chave do nó.
     */
    async start() {
      await accounts.recover();
      accounts.watch();
      executions.start();
      if (deps.installation?.watch) installation.start();
    },
    close: async () => {
      await installation.stop();
      await accounts.close();
      // Depois do `executions.stop()` não sobra nenhum; isto é só a rede de segurança.
      await runs.killAll();
      await mcp.stop();
      await push.idle();
    },
  };
}
