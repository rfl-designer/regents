import type { BackupRunDto, InstallationDto, NodeKeyDto } from "@shearim/contracts";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { Member } from "../members";
import { migrationState } from "./migrations";

type Env = { Variables: { member: Member } };

const { backups } = schema;

export interface InstallationConfig {
  /** A versão que está rodando (a tag da imagem, `SHEARIM_VERSION`). */
  version?: string;
}

/**
 * O estado da Instalação para o Admin (Spec, módulo 13; história 13): a versão, a migração do
 * banco, o último backup e o vencimento da chave do nó.
 */
export function createInstallation(deps: { db: Db; clock: Clock; config?: InstallationConfig }) {
  const { db } = deps;
  const version = deps.config?.version ?? "dev";

  async function lastBackups() {
    const [last] = await db.select().from(backups).orderBy(desc(backups.finishedAt)).limit(1);
    const [good] = await db
      .select({ at: backups.finishedAt })
      .from(backups)
      .where(and(eq(backups.ok, true)))
      .orderBy(desc(backups.finishedAt))
      .limit(1);
    return { last, lastGoodAt: good?.at ?? null };
  }

  async function snapshot(): Promise<InstallationDto> {
    const state = await migrationState(db);
    const { last, lastGoodAt } = await lastBackups();
    const nodeKey: NodeKeyDto = { kind: "unknown", reason: "sem tailnet" };
    return {
      version,
      migration: state.kind === "current" || state.kind === "behind" ? state.tag : "",
      backup: {
        last: last
          ? ({
              at: last.finishedAt.toISOString(),
              ok: last.ok,
              file: last.file,
              bytes: last.bytes,
              error: last.error,
            } satisfies BackupRunDto)
          : null,
        lastGoodAt: lastGoodAt?.toISOString() ?? null,
      },
      nodeKey,
      alerts: [],
    };
  }

  const routes = new Hono<Env>();
  routes.use("/installation", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });
  routes.get("/installation", async (c) => c.json(await snapshot()));

  return { routes, snapshot };
}
