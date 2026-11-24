import {
  BACKUP_STALE_HOURS,
  type BackupRunDto,
  INSTALLATION_PATH,
  type InstallationAlertDto,
  type InstallationDto,
  NODE_KEY_WARNING_DAYS,
  type NodeKeyDto,
} from "@shearim/contracts";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { EventHub } from "../events";
import type { Member } from "../members";
import type { Push } from "../push";
import { migrationState } from "./migrations";
import { type NodeKeyPort, noNodeKey } from "./node-key";

type Env = { Variables: { member: Member } };

const { backups, installation, installationAlerts, members } = schema;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** De quanto em quanto tempo o app olha o backup (que outro processo grava) e a chave do nó. */
export const INSTALLATION_CHECK_MS = 15 * 60 * 1000;

export interface InstallationConfig {
  /** A versão que está rodando (a tag da imagem, `SHEARIM_VERSION`). */
  version?: string;
  /** Liga a verificação periódica com os pushes do Admin (o `main.ts` liga; nos testes, opcional). */
  watch?: boolean;
  /** O vencimento da chave do nó (padrão: sem tailnet). */
  nodeKey?: NodeKeyPort;
}

/**
 * O estado da Instalação para o Admin (Spec, módulo 13; histórias 13 a 15): a versão, a migração
 * do banco, o último backup e o vencimento da chave do nó, mais os avisos. O backup noturno roda
 * em outro processo (o serviço `backup`) e grava em `backups`; o app olha a cada 15 min e, quando
 * o backup falha ou fica 36 h sem um bom, manda push a cada Admin (uma vez por ocorrência,
 * guardada em `installation_alerts`) e publica `installation.updated` (a faixa).
 */
export function createInstallation(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  push: Push;
  config?: InstallationConfig;
}) {
  const { db, clock, events, push } = deps;
  const version = deps.config?.version ?? "dev";
  const nodeKeyPort = deps.config?.nodeKey ?? noNodeKey;

  async function backupState() {
    const [last] = await db.select().from(backups).orderBy(desc(backups.finishedAt)).limit(1);
    const [good] = await db
      .select({ at: backups.finishedAt })
      .from(backups)
      .where(eq(backups.ok, true))
      .orderBy(desc(backups.finishedAt))
      .limit(1);
    const [since] = await db.select({ at: installation.createdAt }).from(installation).where(eq(installation.id, 1));
    return { last, lastGoodAt: good?.at ?? null, installedAt: since?.at ?? null };
  }

  /** Os avisos de agora, cada um com o que o identifica (para o push sair uma vez só). */
  function alertsOf(state: Awaited<ReturnType<typeof backupState>>) {
    const alerts: { alert: InstallationAlertDto; ref: string }[] = [];
    const { last, lastGoodAt, installedAt } = state;
    if (last && !last.ok) {
      alerts.push({
        alert: { kind: "backup_failed", at: last.finishedAt.toISOString(), error: last.error ?? "" },
        ref: last.id,
      });
    }
    const since = lastGoodAt ?? installedAt;
    if (since && clock.now().getTime() - since.getTime() > BACKUP_STALE_HOURS * HOUR_MS) {
      alerts.push({
        alert: { kind: "backup_stale", lastGoodAt: lastGoodAt?.toISOString() ?? null },
        ref: lastGoodAt?.toISOString() ?? "nunca",
      });
    }
    return alerts;
  }

  async function snapshot(): Promise<InstallationDto> {
    const migration = await migrationState(db);
    const state = await backupState();
    const { last, lastGoodAt } = state;
    const nodeKey: NodeKeyDto = await nodeKeyPort.read();
    return {
      version,
      migration: migration.kind === "current" || migration.kind === "behind" ? migration.tag : "",
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
      alerts: alertsOf(state).map((a) => a.alert),
    };
  }

  async function admins() {
    return (await db.select({ id: members.id }).from(members).where(eq(members.role, "admin"))).map((m) => m.id);
  }

  /** Marca o aviso como enviado; `true` só na primeira vez. */
  async function firstTime(kind: string, ref: string) {
    const inserted = await db
      .insert(installationAlerts)
      .values({ kind, ref, sentAt: clock.now() })
      .onConflictDoNothing()
      .returning({ kind: installationAlerts.kind });
    return inserted.length > 0;
  }

  async function notifyAdmins(n: { title: string; body: string; tag: string; urgency: "high" | "normal" }) {
    for (const id of await admins()) push.notify(id, { ...n, path: INSTALLATION_PATH });
  }

  let published: string | undefined;
  /** Uma verificação: pushes novos e, se o que a faixa mostra mudou, `installation.updated`. */
  async function check() {
    await db.insert(installation).values({ id: 1, createdAt: clock.now() }).onConflictDoNothing();
    const state = await backupState();
    for (const { alert, ref } of alertsOf(state)) {
      if (!(await firstTime(alert.kind, ref))) continue;
      if (alert.kind === "backup_failed") {
        await notifyAdmins({
          title: "O backup do Shearim falhou",
          body: alert.error,
          tag: "instalacao-backup",
          urgency: "high",
        });
      } else {
        await notifyAdmins({
          title: `Faz ${BACKUP_STALE_HOURS} h sem um backup bom`,
          body: alert.lastGoodAt
            ? `O último backup bom foi em ${dayAndTime(new Date(alert.lastGoodAt))}. Veja a seção Instalação.`
            : "Ainda não houve nenhum backup bom. Veja a seção Instalação.",
          tag: "instalacao-backup",
          urgency: "high",
        });
      }
    }
    const dto = await snapshot();
    if (dto.nodeKey.kind === "expires") {
      const expiresAt = new Date(dto.nodeKey.expiresAt);
      const left = expiresAt.getTime() - clock.now().getTime();
      if (
        left > 0 &&
        left <= NODE_KEY_WARNING_DAYS * DAY_MS &&
        (await firstTime("node_key_expiring", dto.nodeKey.expiresAt))
      ) {
        const days = Math.ceil(left / DAY_MS);
        await notifyAdmins({
          title: days === 1 ? "A chave do nó vence amanhã" : `A chave do nó vence em ${days} dias`,
          body:
            `Em ${dayAndTime(expiresAt)} a Instalação sai da tailnet e o Shearim para de abrir. ` +
            "Renove a chave do nó (ou desligue o vencimento) no painel do Tailscale, em Machines.",
          tag: "instalacao-chave-do-no",
          urgency: "normal",
        });
      }
    }
    const signature = JSON.stringify([dto.backup, dto.alerts, dto.nodeKey]);
    if (signature !== published) {
      published = signature;
      events.publish({ members: await admins() }, { type: "installation.updated", installation: dto });
    }
  }

  let cancel: (() => void) | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = true;
  function tick() {
    running = running
      .then(check)
      .catch((err) => console.error("shearim: a verificação da Instalação falhou", err))
      .finally(() => {
        if (!stopped) cancel = clock.after(INSTALLATION_CHECK_MS, tick);
      });
  }

  const routes = new Hono<Env>();
  routes.use("/installation", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });
  routes.get("/installation", async (c) => c.json(await snapshot()));

  return {
    routes,
    snapshot,
    /** Verifica agora e a cada 15 min. */
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    async stop() {
      stopped = true;
      cancel?.();
      await running;
    },
  };
}

/** `24/11 às 03:00`, na hora local do servidor (`TZ`). */
function dayAndTime(at: Date) {
  const f = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}
