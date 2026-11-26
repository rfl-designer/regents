import { WORKSPACE_CONTEXT_MAX, type WorkspaceContextDto } from "@regents/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, schema } from "./db/client";
import type { Env } from "./members";

const { workspaceSettings } = schema;

/**
 * O Contexto do Workspace (Spec, história 50): um texto curto do Admin sobre quem é o Workspace
 * e como ele fala. Entra em toda execução, em todo Canal e DM (`context.ts`).
 */
export function workspaceContextRoutes(deps: { db: Db }) {
  const { db } = deps;
  const routes = new Hono<Env>();

  routes.use("/workspace-context", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.get("/workspace-context", async (c) => c.json({ context: await readWorkspaceContext(db) }));

  routes.put("/workspace-context", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof input?.context !== "string") {
      return c.json({ error: "invalid_input", message: "O Contexto do Workspace é um texto." }, 400);
    }
    if (input.context.length > WORKSPACE_CONTEXT_MAX) {
      return c.json(
        {
          error: "invalid_input",
          message: `O Contexto do Workspace tem no máximo ${WORKSPACE_CONTEXT_MAX} caracteres.`,
        },
        400,
      );
    }
    const context = input.context;
    await db
      .insert(workspaceSettings)
      .values({ id: 1, context })
      .onConflictDoUpdate({ target: workspaceSettings.id, set: { context } });
    return c.json({ context } satisfies WorkspaceContextDto);
  });

  return routes;
}

/** O Contexto do Workspace como está agora (vazio se o Admin nunca escreveu). */
export async function readWorkspaceContext(db: Db): Promise<string> {
  const [row] = await db
    .select({ context: workspaceSettings.context })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, 1));
  return row?.context ?? "";
}
