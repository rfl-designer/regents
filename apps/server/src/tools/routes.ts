import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, isUuid, schema } from "../db/client";
import type { Env } from "../members";
import type { ToolPort } from "./port";

/**
 * As Ferramentas de cada Agente, na tela do Agente (só Admin): ver as do Workspace, com leitura ou
 * escrita, e conceder ou retirar cada uma. Vale também para a Articuladora.
 */
export function agentToolRoutes(deps: { db: Db; tools: ToolPort }) {
  const { db, tools } = deps;
  const routes = new Hono<Env>();

  async function agentExists(id: string) {
    if (!isUuid(id)) return false;
    const [row] = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, id));
    return Boolean(row);
  }

  routes.get("/agents/:id/tools", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    if (!(await agentExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json(await tools.forAgent(id));
  });

  for (const method of ["put", "delete"] as const) {
    routes[method]("/agents/:id/tools/:tool", async (c) => {
      if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
      const id = c.req.param("id");
      const tool = c.req.param("tool");
      if (!(await agentExists(id)) || !(await tools.exists(tool))) return c.json({ error: "not_found" }, 404);
      if (method === "put") await tools.grant(id, tool);
      else await tools.revoke(id, tool);
      return c.json(await tools.forAgent(id));
    });
  }

  return routes;
}
