import { EVENTS_PATH } from "@shearim/contracts";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import type { Clock } from "./clock";
import { conversationRoutes } from "./conversations";
import type { Db } from "./db/client";
import { createEventHub } from "./events";
import type { Identity, IdentityPort } from "./identity/port";
import { IdentityUnavailableError } from "./identity/whois";
import { listMembers, type Member, memberFor, toMeDto } from "./members";

export interface AppDeps {
  db: Db;
  identity: IdentityPort;
  clock: Clock;
  /** Rotas só de desenvolvimento (`/dev/*`), vindas do adaptador de identidade de dev. */
  devRoutes?: Hono;
}

type Env = { Variables: { member: Member } };

/**
 * O seam dos testes: tudo o que o app usa de fora entra por `deps`.
 * Nada de singleton global. `main.ts` monta as dependências reais.
 */
export function createApp(deps: AppDeps) {
  const { db, identity, clock } = deps;
  const app = new Hono<Env>();
  const { hub: events, route: eventsRoute } = createEventHub();

  app.get("/api/health", (c) => c.json({ ok: true }));
  if (deps.devRoutes) app.route("/dev", deps.devRoutes);

  // Toda rota em /api (menos a saúde) exige identidade e Membro.
  app.use("/api/*", async (c, next) => {
    let who: Identity;
    try {
      who = await identity.whoAmI(c.req.raw);
    } catch (err) {
      if (!(err instanceof IdentityUnavailableError)) throw err;
      // Falha da Instalação (tailscaled fora do ar), não "sem identidade": fica no log e na resposta.
      console.error(`shearim: ${err.message}`);
      return c.json({ error: "identity_unavailable" }, 503);
    }
    if (who.kind === "none") return c.json({ error: "no_identity", reason: who.reason }, 403);
    const member = await memberFor(db, clock, who);
    if (!member) return c.json({ error: "not_a_member" }, 403);
    c.set("member", member);
    await next();
  });

  app.get("/api/me", (c) => c.json(toMeDto(c.get("member"))));
  app.get("/api/members", async (c) => c.json(await listMembers(db)));
  app.get(EVENTS_PATH, eventsRoute);
  app.route("/api", conversationRoutes({ db, clock, events }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  /** `websocket` vai no `Bun.serve` junto com `app.fetch`; `events` é onde se publica. */
  return { app, websocket, events };
}
