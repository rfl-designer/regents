import { Hono } from "hono";
import { findAgent } from "../agents";
import type { Db } from "../db/client";
import { adminOnly, type Env } from "../members";
import type { ToolPort } from "./port";

/**
 * As Ferramentas de cada Agente, na tela do Agente (só Admin): ver as do Workspace, com leitura ou
 * escrita, e conceder ou retirar cada uma. Vale também para a Articuladora.
 */
export function agentToolRoutes(deps: { db: Db; tools: ToolPort }) {
  const { db, tools } = deps;
  const routes = new Hono<Env>();

  const agentExists = async (id: string) => (await findAgent(db, id)).length > 0;

  routes.get("/agents/:id/tools", adminOnly, async (c) => {
    const id = c.req.param("id");
    if (!(await agentExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json(await tools.forAgent(id));
  });

  for (const method of ["put", "delete"] as const) {
    routes[method]("/agents/:id/tools/:tool", adminOnly, async (c) => {
      const id = c.req.param("id");
      const tool = c.req.param("tool");
      if (!(await agentExists(id)) || !(await tools.exists(tool))) return c.json({ error: "not_found" }, 404);
      if (method === "put") {
        if (!(await tools.grant(id, tool))) return c.json({ error: "not_found" }, 404);
      } else await tools.revoke(id, tool);
      return c.json(await tools.forAgent(id));
    });
  }

  return routes;
}
