import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { parse } from "hono/utils/cookie";
import type { Identity, IdentityPort } from "./port";

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
 */
export function createDevIdentity(opts: { defaultUser: DevPerson }) {
  const identity: IdentityPort = {
    async whoAmI(req): Promise<Identity> {
      const raw = parse(req.headers.get("cookie") ?? "", COOKIE)[COOKIE];
      const person = decode(raw) ?? opts.defaultUser;
      return {
        kind: "user",
        userId: person.id,
        login: `${person.id}@dev.local`,
        displayName: person.name,
        sharee: false,
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

  return { identity, routes };
}

function decode(raw: string | undefined): DevPerson | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<DevPerson>;
    return typeof p.id === "string" && typeof p.name === "string" ? { id: p.id, name: p.name } : undefined;
  } catch {
    return undefined;
  }
}
