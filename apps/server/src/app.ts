import { EVENTS_PATH } from "@shearim/contracts";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type AccountsConfig, createAccounts } from "./accounts";
import { processTracker } from "./accounts/claude-cli";
import { agentRoutes } from "./agents";
import type { Clock } from "./clock";
import { conversationRoutes } from "./conversations";
import type { Db } from "./db/client";
import { dmRoutes } from "./dms";
import { createEventHub } from "./events";
import { createExecutions, type ExecutionHooks, type ExecutionLimits } from "./executions";
import type { Identity, IdentityPort } from "./identity/port";
import { IdentityUnavailableError } from "./identity/whois";
import { createInstallation, type InstallationConfig } from "./installation/status";
import { type JoinRequestHooks, joinRequestAdminRoutes, myJoinRequestRoutes, type TailnetUser } from "./join-requests";
import { listMembers, type Member, memberFor } from "./members";
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
  /** Ganchos de domínio (ex.: push aos Admins a cada Pedido de entrada, #34; push da falha ao autor, #32). */
  hooks?: JoinRequestHooks & ExecutionHooks;
  /** O `sub` do VAPID e, nos testes, o agente HTTPS do coletor de push. */
  push: PushConfig;
  /** A versão que está rodando e de onde vem o vencimento da chave do nó (seção Instalação). */
  installation?: InstallationConfig;
  /** Os tetos de concorrência das execuções (padrão: 2 por Conta, 4 na Chave, 8 processos). */
  limits?: Partial<ExecutionLimits>;
}

type Env = { Variables: { who: TailnetUser; member: Member } };

const UNAVAILABLE = Symbol("identity_unavailable");

/**
 * O seam dos testes: tudo o que o app usa de fora entra por `deps`.
 * Nada de singleton global. `main.ts` monta as dependências reais.
 */
export function createApp(deps: AppDeps) {
  const { db, identity, clock, hooks, secrets } = deps;
  const app = new Hono<Env>();
  const { hub: events, route: eventsRoute, closeForRestart } = createEventHub();
  // A volta da Conta (ou a troca da Chave) solta quem espera por ela na fila.
  const accounts = createAccounts({
    db,
    clock,
    events,
    config: deps.accounts,
    onChanged: (memberId) => void executions.reconsider(memberId).catch(() => {}),
  });
  // Pela Conta, um `claude -p` por execução (ADR 0006); os processos vivos morrem no `close`.
  const runs = processTracker();
  const model = createModelPort({
    key: deps.keyBrain ?? keyBrain({ baseURL: deps.anthropicBaseUrl }),
    account: accountBrain({ claudeBin: deps.accounts.claudeBin, procs: runs, stopGrace: deps.accounts.stopGrace }),
  });
  const reading = createReading({ db, clock, events });
  const executions = createExecutions({
    db,
    clock,
    events,
    model,
    secrets,
    accounts,
    hooks,
    reading,
    limits: deps.limits,
  });
  // A Presença avisa o push quando uma conversa fica à vista; o push pergunta a ela antes de mandar.
  const presence = createPresence({ db, events, onOpened: (m, conv) => push.conversationOpened(m, conv) });
  const push = createPush({
    events,
    db,
    clock,
    presence: presence.presence,
    config: deps.push,
    badgeOf: async (memberId) => (await unreadOf(db, memberId)).total,
  });

  const installation = createInstallation({ db, clock, events, push, config: deps.installation });

  /** Pergunta à porta; tailscaled fora do ar é falha da Instalação, não "sem identidade": vai para o log. */
  async function whoAmI(req: Request): Promise<Identity | typeof UNAVAILABLE> {
    try {
      return await identity.whoAmI(req);
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
    const who = await whoAmI(c.req.raw);
    if (who === UNAVAILABLE) return c.text("O Shearim não conseguiu falar com o tailscaled. Veja o log do app.", 503);
    if (who.kind === "none") return c.html(noIdentityPage(who.reason), 403);
    await next();
  });

  // Toda rota em /api (menos a saúde) exige identidade.
  app.use("/api/*", async (c, next) => {
    const who = await whoAmI(c.req.raw);
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
  app.get(EVENTS_PATH, eventsRoute);
  app.route("/api/join-requests", joinRequestAdminRoutes({ db, clock, events, hooks }));
  app.route("/api", conversationRoutes({ db, clock, events, executions, reading, push }));
  app.route("/api", presence.routes);
  app.route("/api", push.routes);
  app.route("/api", dmRoutes({ db, clock, events }));
  app.route("/api", reading.routes);
  app.route("/api", threadRoutes({ db }));
  app.route("/api", accounts.routes);
  app.route("/api", agentRoutes({ db, clock }));
  app.route(
    "/api",
    workspaceKeyRoutes({ db, clock, secrets, onChanged: () => void executions.reconsider().catch(() => {}) }),
  );
  app.route("/api", workspaceContextRoutes({ db }));
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
     * A subida: limpa as pastas de Conta (pastas de login órfãs, lock de renovação), põe a fila para
     * andar e, com `installation.watch`, a verificação do backup e da chave do nó.
     */
    async start() {
      await accounts.recover();
      executions.start();
      if (deps.installation?.watch) installation.start();
    },
    close: async () => {
      await installation.stop();
      await accounts.close();
      // Depois do `executions.stop()` não sobra nenhum; isto é só a rede de segurança.
      await runs.killAll();
      await push.idle();
    },
  };
}
