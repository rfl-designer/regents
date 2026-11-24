import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { parse } from "hono/utils/cookie";
import type { Identity, IdentityPort, NoIdentityReason } from "./port";

const COOKIE = "dev_user";

export interface DevPerson {
  id: string;
  name: string;
}

/**
 * Identidade de desenvolvimento, para `bun run dev` e o e2e. Nunca em produção.
 *
 * Quem é vem do cookie `dev_user`; sem cookie, é a pessoa padrão. A rota
 * `GET /dev/como/:id?nome=Fulana` troca a pessoa da aba e volta para `/`.
 * Assim duas abas (ou dois contextos do navegador) são duas pessoas.
 * `GET /dev/sem-identidade/:motivo` (`tagged`, `funnel`, `unknown`) faz o navegador
 * chegar sem identidade, para ver a página com o motivo.
 */
export function createDevIdentity(opts: { defaultUser: DevPerson }) {
  const identity: IdentityPort = {
    async whoAmI(req): Promise<Identity> {
      const raw = parse(req.headers.get("cookie") ?? "", COOKIE)[COOKIE];
      const person = decode(raw) ?? opts.defaultUser;
      if ("none" in person) return { kind: "none", reason: person.none };
      return {
        kind: "user",
        userId: person.id,
        login: `${person.id}@dev.local`,
        displayName: person.name,
        sharee: false,
        device: "navegador de dev",
      };
    },
  };

  const routes = new Hono();
  routes.get("/como/:id", (c) => {
    const id = c.req.param("id");
    const person: DevPerson = { id, name: c.req.query("nome") ?? `Pessoa ${id}` };
    setCookie(c, COOKIE, JSON.stringify(person), { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.redirect("/", 302);
  });
  routes.get("/sem-identidade/:motivo", (c) => {
    const motivo = c.req.param("motivo");
    const none: NoIdentityReason = REASONS.includes(motivo as NoIdentityReason)
      ? (motivo as NoIdentityReason)
      : "unknown";
    setCookie(c, COOKIE, JSON.stringify({ none }), { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.redirect("/", 302);
  });

  return { identity, routes };
}

const REASONS: NoIdentityReason[] = ["tagged", "funnel", "unknown"];

function decode(raw: string | undefined): DevPerson | { none: NoIdentityReason } | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<DevPerson> & { none?: NoIdentityReason };
    if (p.none && REASONS.includes(p.none)) return { none: p.none };
    return typeof p.id === "string" && typeof p.name === "string" ? { id: p.id, name: p.name } : undefined;
  } catch {
    return undefined;
  }
}
