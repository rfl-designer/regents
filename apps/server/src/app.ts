import { EVENTS_PATH } from "@shearim/contracts";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type AccountsConfig, createAccounts } from "./accounts";
import { agentRoutes } from "./agents";
import type { Clock } from "./clock";
import { conversationRoutes } from "./conversations";
import type { Db } from "./db/client";
import { dmRoutes } from "./dms";
import { createEventHub } from "./events";
import { createExecutions } from "./executions";
import type { Identity, IdentityPort } from "./identity/port";
import { IdentityUnavailableError } from "./identity/whois";
import { type JoinRequestHooks, joinRequestAdminRoutes, myJoinRequestRoutes, type TailnetUser } from "./join-requests";
import { listMembers, type Member, memberFor } from "./members";
import { keyBrain } from "./model/key";
import { createModelPort } from "./model/port";
import { noIdentityPage } from "./no-identity-page";
import { profileRoutes } from "./profile";
import type { SecretBox } from "./secrets";
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
  /** Rotas só de desenvolvimento (`/dev/*`), vindas do adaptador de identidade de dev. */
  devRoutes?: Hono;
  /** Ganchos de domínio (ex.: push aos Admins a cada Pedido de entrada, #34). */
  hooks?: JoinRequestHooks;
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
  const { hub: events, route: eventsRoute } = createEventHub();
  const accounts = createAccounts({ db, clock, events, config: deps.accounts });
  const model = createModelPort({ key: keyBrain({ baseURL: deps.anthropicBaseUrl }) });
  const executions = createExecutions({ db, clock, events, model, secrets });

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
  app.route("/api", conversationRoutes({ db, clock, events, executions }));
  app.route("/api", dmRoutes({ db, clock, events }));
  app.route("/api", accounts.routes);
  app.route("/api", agentRoutes({ db, clock }));
  app.route("/api", workspaceKeyRoutes({ db, clock, secrets }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  /**
   * `websocket` vai no `Bun.serve` junto com `app.fetch`; `events` é onde se publica.
   * `executions.start()` põe a fila para andar e `stop()` a para; `close` encerra o que o app
   * deixou rodando (os processos do `claude`).
   */
  return { app, websocket, events, executions, close: () => accounts.close() };
}
