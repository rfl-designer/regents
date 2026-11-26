import { WIKI_INDEX_SLUG, type WikiSyncDto, type WikiSyncStepDto } from "@shearim/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { articuladoraOf } from "../articuladora";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { EventHub } from "../events";
import type { KeyLedger } from "../key-budget";
import { failureReason, type Spent, STALL_MS, streamCall } from "../model/call";
import type { ModelPort } from "../model/port";
import { keyCallEnded, keyPayer } from "../payer";
import type { SecretBox } from "../secrets";
import { Draft, type DraftSource, draftTools } from "./draft";
import { syncPrompt, syncSystem } from "./rules";
import { syncDto } from "./sync-state";
import { currentVersionId, pagesOfVersion, publishVersion, sourcesOfVersion } from "./versions";
import { findWiki, pendingOf, toWikiDto, wikiAudience } from "./wikis";

const { wikiSyncs, wikiSources, members } = schema;

/** O teto de turnos de Ferramenta de cada chamada da Sincronização (`SHEARIM_WIKI_SYNC_MAX_TURNS`). */
export const DEFAULT_SYNC_MAX_TURNS = 40;

/** O motivo da vigia numa chamada da Sincronização. */
const SYNC_STALL_REASON = "a Articuladora ficou 2 minutos sem responder";

/** Por que o pedido de Sincronização foi recusado, com o motivo em pt-BR. */
export type SyncRefusal = { error: "nothing_to_sync" | "sync_running"; message: string };

/** O que a próxima Sincronização faz: as Fontes novas, na ordem em que subiram. */
async function planOf(db: Db, wikiId: string) {
  const version = await currentVersionId(db, wikiId);
  const reflected = await sourcesOfVersion(db, version);
  const all = await db
    .select({ id: wikiSources.id, fileName: wikiSources.fileName, state: wikiSources.state })
    .from(wikiSources)
    .where(eq(wikiSources.wikiId, wikiId))
    .orderBy(asc(wikiSources.seq));
  const news = all.filter((s) => pendingOf(s, reflected) === "new");
  // As Fontes "a remover" (#88) entram no plano antes das novas, uma chamada por Fonte.
  const removals = all.filter((s) => pendingOf(s, reflected) === "removal");
  /** As Fontes que a versão nova vai refletir: as ativas (as de antes e as novas). */
  const target: DraftSource[] = all.filter((s) => s.state === "active").map(({ id, fileName }) => ({ id, fileName }));
  return { version, news, removals, target };
}

/** As Sincronizações (ADR 0015): o pedido do Admin, o trabalho num rascunho e a publicação. */
export interface WikiSyncs {
  /**
   * O Admin apertou "Sincronizar": a Sincronização entra (`queued`) e começa na hora. Recusada se
   * já há uma em curso na Wiki ou se não há nada pendente.
   */
  request(wikiId: string, by: string): Promise<WikiSyncDto | SyncRefusal>;
  /** Para na hora: interrompe as que estão rodando (o rascunho é descartado). */
  stop(): Promise<void>;
}

/**
 * A Sincronização é um trabalho próprio do Shearim, e não uma execução: não tem Canal nem mensagem
 * de origem. A Articuladora leva cada Fonte pendente para as páginas, uma chamada de modelo por
 * Fonte, pelas Ferramentas internas do rascunho (`draft.ts`); o Shearim publica a versão no fim,
 * numa transação só (`versions.ts`). O modelo é o da Articuladora, e o gasto conta no orçamento dela.
 *
 * Quem paga é decidido a cada chamada. Hoje, a Chave do Workspace (`payer.ts`); a Conta do Admin
 * que iniciou, com a Chave como reserva, vem no #80 (`accountCallEnded`, sessão MCP). A vigia de
 * cada chamada é a das execuções (`model/call.ts`); a nova tentativa, o cancelamento e o reinício
 * vêm no #86.
 */
export function createWikiSyncs(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  model: ModelPort;
  secrets: SecretBox;
  ledger: KeyLedger;
  /** O teto de turnos de Ferramenta de cada chamada (padrão: `DEFAULT_SYNC_MAX_TURNS`). */
  maxToolTurns?: number;
}): WikiSyncs {
  const { db, clock, events, model, secrets, ledger } = deps;
  /** As que estão rodando neste processo: o controle da chamada em curso e o fim do trabalho. */
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  /** Anuncia a Sincronização como ela está agora, a quem vê a Wiki (relida: chega em ordem). */
  async function publish(syncId: string) {
    const sync = await syncDto(db, syncId);
    if (!sync) return;
    const wiki = await findWiki(db, sync.wikiId);
    if (!wiki) return;
    events.publish(await wikiAudience(db, wiki), { type: "wiki_sync.updated", sync });
  }

  async function publishWiki(wikiId: string) {
    const wiki = await findWiki(db, wikiId);
    if (!wiki) return;
    events.publish(await wikiAudience(db, wiki), { type: "wiki.updated", wiki: await toWikiDto(db, wiki) });
  }

  /** Troca o passo de uma Sincronização em curso e anuncia. */
  async function step(syncId: string, next: WikiSyncStepDto) {
    await db
      .update(wikiSyncs)
      .set({ step: next })
      .where(and(eq(wikiSyncs.id, syncId), eq(wikiSyncs.state, "running")));
    await publish(syncId);
  }

  /** Encerra em falha, com o motivo; o rascunho é descartado (a Wiki fica como estava). */
  async function fail(syncId: string, reason: string) {
    const [failed] = await db
      .update(wikiSyncs)
      .set({ state: "failed", step: null, reason, finishedAt: clock.now() })
      .where(and(eq(wikiSyncs.id, syncId), inArray(wikiSyncs.state, ["queued", "running"])))
      .returning({ id: wikiSyncs.id });
    if (failed) await publish(syncId);
  }

  /**
   * Uma chamada de modelo: a Articuladora leva uma Fonte para o rascunho. Devolve se terminou bem;
   * senão, a Sincronização já foi encerrada com o motivo (ou o servidor está parando).
   */
  async function call(
    sync: { id: string; wiki: { name: string; description: string } },
    controller: AbortController,
    draft: Draft,
    source: DraftSource & { text: string },
    position: { current: number; total: number },
  ): Promise<boolean> {
    const articuladora = await articuladoraOf(db);
    const payer = await keyPayer({ db, secrets, ledger }, articuladora.id);
    if (payer.kind === "none") {
      await fail(sync.id, payer.reason);
      return false;
    }
    const spent: Spent = { startedAt: clock.now() };
    let end: Awaited<ReturnType<typeof streamCall>>["end"];
    try {
      ({ end } = await streamCall({
        model,
        clock,
        controller,
        spent,
        stallMs: STALL_MS,
        request: {
          model: articuladora.model,
          system: syncSystem(sync.wiki),
          messages: [
            {
              role: "user",
              content: syncPrompt({ index: draft.pages.get(WIKI_INDEX_SLUG)?.body ?? null, source, ...position }),
            },
          ],
          payer,
          tools: draftTools(draft, source),
          maxToolTurns: deps.maxToolTurns ?? DEFAULT_SYNC_MAX_TURNS,
        },
      }));
    } finally {
      // O uso que a API informou conta no orçamento da Articuladora, chegando ou não ao fim.
      await keyCallEnded(ledger, { agentId: articuladora.id, wikiSyncId: sync.id }, spent, end);
    }
    if (controller.signal.aborted) {
      if (controller.signal.reason === "stalled") await fail(sync.id, SYNC_STALL_REASON);
      return false;
    }
    if (end?.type !== "done") {
      await fail(sync.id, failureReason(end));
      return false;
    }
    return true;
  }

  /** O trabalho: uma chamada por Fonte nova, num rascunho, e a publicação no fim. */
  async function work(syncId: string, controller: AbortController) {
    const [row] = await db
      .update(wikiSyncs)
      .set({ state: "running", startedAt: clock.now() })
      .where(and(eq(wikiSyncs.id, syncId), eq(wikiSyncs.state, "queued")))
      .returning();
    if (!row) return;
    const wiki = (await findWiki(db, row.wikiId))!;
    const plan = await planOf(db, wiki.id);
    const draft = new Draft(await pagesOfVersion(db, plan.version), plan.target);
    const total = plan.news.length;
    for (const [i, news] of plan.news.entries()) {
      const position = { current: i + 1, total };
      await step(syncId, { kind: "source", ...position, fileName: news.fileName });
      const [source] = await db
        .select({ id: wikiSources.id, fileName: wikiSources.fileName, text: wikiSources.text })
        .from(wikiSources)
        .where(eq(wikiSources.id, news.id));
      if (!(await call({ id: syncId, wiki }, controller, draft, source!, position))) return;
    }
    await step(syncId, { kind: "publishing" });
    const report = draft.report();
    const [starter] = await db
      .select({ name: members.displayName })
      .from(members)
      .where(eq(members.id, row.startedByMemberId));
    const now = clock.now();
    const published = await db.transaction(async (tx) => {
      // A Sincronização pode ter sido encerrada enquanto publicava: aí nada muda.
      const [still] = await tx
        .update(wikiSyncs)
        .set({ state: "done", step: null, report, finishedAt: now })
        .where(and(eq(wikiSyncs.id, syncId), eq(wikiSyncs.state, "running")))
        .returning({ id: wikiSyncs.id });
      if (!still) return false;
      await publishVersion(tx, {
        wikiId: wiki.id,
        syncId,
        pages: draft.pages,
        sources: plan.target.map((s) => s.id),
        report,
        logEntry: (number) => logEntry({ number, by: starter?.name ?? "", at: now, news: plan.news, report }),
        now,
      });
      return true;
    });
    if (!published) return;
    await publish(syncId);
    await publishWiki(wiki.id);
  }

  return {
    async request(wikiId, by) {
      const plan = await planOf(db, wikiId);
      // A remoção de Fonte (#88) também conta como pendência quando entrar no trabalho.
      if (plan.news.length === 0) {
        return { error: "nothing_to_sync", message: "Nada a sincronizar: nenhuma Fonte está pendente nesta Wiki." };
      }
      const id = crypto.randomUUID();
      const [created] = await db
        .insert(wikiSyncs)
        .values({ id, wikiId, startedByMemberId: by, createdAt: clock.now() })
        .onConflictDoNothing()
        .returning({ id: wikiSyncs.id });
      if (!created) {
        const [open] = await db
          .select({ name: members.displayName })
          .from(wikiSyncs)
          .innerJoin(members, eq(members.id, wikiSyncs.startedByMemberId))
          .where(and(eq(wikiSyncs.wikiId, wikiId), inArray(wikiSyncs.state, ["queued", "running"])));
        const who = open ? `, iniciada por ${open.name}` : "";
        return {
          error: "sync_running",
          message: `Já há uma Sincronização em curso nesta Wiki${who}. Espere ela terminar.`,
        };
      }
      await publish(id);
      const controller = new AbortController();
      const done = work(id, controller)
        .catch(async (err) => {
          console.error("shearim: a Sincronização da Wiki falhou", err);
          await fail(id, "erro inesperado no Shearim").catch(() => {});
        })
        .finally(() => running.delete(id));
      running.set(id, { controller, done });
      return (await syncDto(db, id))!;
    },

    async stop() {
      const all = [...running.values()];
      for (const r of all) r.controller.abort("shutdown");
      await Promise.all(all.map((r) => r.done));
    },
  };
}

/** A entrada do `log` desta Sincronização: a versão, quando, quem, as Fontes e o que mudou. */
function logEntry(input: {
  number: number;
  by: string;
  at: Date;
  news: readonly { fileName: string }[];
  report: { created: { slug: string }[]; updated: { slug: string }[]; removed: { slug: string }[] };
}) {
  const when = `${input.at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const links = (refs: { slug: string }[]) => refs.map((r) => `[[${r.slug}]]`).join(", ");
  const lines = [`## Versão ${input.number} · ${when} · ${input.by}`];
  if (input.news.length) lines.push(`- Fontes novas: ${input.news.map((s) => s.fileName).join(", ")}`);
  if (input.report.created.length) lines.push(`- Páginas criadas: ${links(input.report.created)}`);
  if (input.report.updated.length) lines.push(`- Páginas alteradas: ${links(input.report.updated)}`);
  if (input.report.removed.length)
    lines.push(`- Páginas removidas: ${input.report.removed.map((r) => r.slug).join(", ")}`);
  return lines.join("\n");
}
