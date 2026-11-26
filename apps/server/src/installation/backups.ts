import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { BACKUP_RETENTION_DAYS } from "@regents/contracts";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import { stamp } from "./commands";
import type { Dumper } from "./dumper";

const { backups } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;
/** O nome de um backup noturno: `shearim-20261124T030000Z.dump`. */
const NIGHTLY = /^shearim-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\./;

/** A próxima vez que dá `hour:minute` na hora local do container (`TZ`), depois de `now`. */
export function nextAt(now: Date, hour: number, minute: number): Date {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * O backup noturno (Spec, módulo 13; história 11): o serviço `backup` do compose roda isto no
 * mesmo banco do app. Um `pg_dump` por noite em `./backups`, guardado por 14 dias. Ao subir, se
 * não houve backup bom nas últimas 24 h, faz um na hora (a Instalação nova já começa com um).
 * Cada tentativa vai para a tabela `backups`, que o app lê para a seção Instalação e os avisos.
 */
export function createNightlyBackups(deps: {
  db: Db;
  clock: Clock;
  dumper: Dumper;
  /** `./backups` (no compose, `/backups`). */
  dir: string;
  /** A hora da noite, na hora local do container (padrão 03:00). */
  at?: { hour: number; minute: number };
  log: (line: string) => void;
}) {
  const { db, clock, dumper, dir } = deps;
  const at = deps.at ?? { hour: 3, minute: 0 };
  let cancel: (() => void) | undefined;
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();

  async function runNow() {
    const startedAt = clock.now();
    const file = join(dir, `shearim-${stamp(startedAt)}.${dumper.extension}`);
    let row: typeof backups.$inferInsert;
    try {
      const { bytes } = await dumper.dump(file);
      row = { id: crypto.randomUUID(), startedAt, finishedAt: clock.now(), ok: true, file: basename(file), bytes };
    } catch (err) {
      row = { id: crypto.randomUUID(), startedAt, finishedAt: clock.now(), ok: false, error: (err as Error).message };
    }
    await db.insert(backups).values(row);
    if (row.ok) prune();
    deps.log(row.ok ? `backup em ${file} (${row.bytes} bytes)` : `o backup falhou: ${row.error}`);
    return row;
  }

  /** Apaga os backups noturnos com 14 dias ou mais (uma hora de folga para a noite que vira). */
  function prune() {
    const limit = clock.now().getTime() - BACKUP_RETENTION_DAYS * DAY_MS + 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      const m = NIGHTLY.exec(name);
      if (!m) continue;
      const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
      if (Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) < limit) rmSync(join(dir, name), { force: true });
    }
  }

  function track<T>(work: () => Promise<T>) {
    const p = running.then(work, work);
    running = p.catch((err) => deps.log(`o backup falhou: ${String(err)}`));
    return p;
  }

  function schedule() {
    if (stopped) return;
    const now = clock.now();
    cancel = clock.after(nextAt(now, at.hour, at.minute).getTime() - now.getTime(), () => {
      void track(runNow).finally(schedule);
    });
  }

  return {
    runNow: () => track(runNow),
    /** Põe o backup noturno para andar (e faz um na hora se o último bom tem mais de 24 h). */
    start() {
      stopped = false;
      void track(async () => {
        const since = new Date(clock.now().getTime() - DAY_MS);
        const [recent] = await db
          .select({ id: backups.id })
          .from(backups)
          .where(and(eq(backups.ok, true), gt(backups.finishedAt, since)))
          .orderBy(desc(backups.finishedAt))
          .limit(1);
        if (!recent) await runNow();
      });
      schedule();
    },
    async stop() {
      stopped = true;
      cancel?.();
      await running;
    },
  };
}
