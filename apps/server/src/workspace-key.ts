import type { SetWorkspaceKeyInput, WorkspaceKeyDto } from "@shearim/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import { openIncident } from "./key-budget";
import type { Member } from "./members";
import type { SecretBox } from "./secrets";

type Env = { Variables: { member: Member } };

const { workspaceSettings } = schema;

/**
 * A Chave do Workspace (ADR 0002): opcional, gravada pelo Admin, cifrada com a chave mestra.
 * Ela sai daqui só para a porta de modelo (`readWorkspaceKey`); nenhuma rota a devolve.
 */
export function workspaceKeyRoutes(deps: {
  db: Db;
  clock: Clock;
  secrets: SecretBox;
  /** A Chave foi gravada: quem espera na fila por quem pague decide de novo. */
  onChanged?(): void;
}) {
  const { db, clock, secrets } = deps;
  const routes = new Hono<Env>();

  routes.use("/workspace-key", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.get("/workspace-key", async (c) => c.json(await keyStatus(db)));

  routes.put("/workspace-key", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<SetWorkspaceKeyInput> | null;
    const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey) return c.json({ error: "invalid_input", message: "Cole a chave da API da Anthropic." }, 400);
    const sealed = await secrets.seal(apiKey);
    const values = { keyCiphertext: sealed.ciphertext, keyIv: sealed.iv, keyUpdatedAt: clock.now() };
    await db
      .insert(workspaceSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: workspaceSettings.id, set: values });
    deps.onChanged?.();
    return c.json(await keyStatus(db));
  });

  return routes;
}

async function keyStatus(db: Db): Promise<WorkspaceKeyDto> {
  const [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, 1));
  const incident = await openIncident(db);
  return row?.keyCiphertext
    ? { configured: true, updatedAt: row.keyUpdatedAt?.toISOString() ?? null, incident }
    : { configured: false, updatedAt: null, incident };
}

/** Se o Workspace tem Chave (sem abri-la). */
export async function hasWorkspaceKey(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ key: workspaceSettings.keyCiphertext })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, 1));
  return Boolean(row?.key);
}

/** A Chave em texto puro, para a porta de modelo, ou `null` se o Workspace não tem Chave. */
export async function readWorkspaceKey(db: Db, secrets: SecretBox): Promise<string | null> {
  const [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, 1));
  if (!row?.keyCiphertext || !row.keyIv) return null;
  return secrets.open({ ciphertext: row.keyCiphertext, iv: row.keyIv });
}
