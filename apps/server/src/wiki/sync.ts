import {
  WIKI_INDEX_SLUG,
  WIKI_LOG_SLUG,
  WIKI_SYNC_OPEN_STATES,
  WIKIS_PATH,
  type WikiSyncDto,
  type WikiSyncStepDto,
} from "@shearim/contracts";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { articuladoraOf } from "../articuladora";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { EventHub } from "../events";
import type { KeyLedger } from "../key-budget";
import {
  failureReason,
  finalReason,
  isRetryable,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type Spent,
  STALL_MS,
  STALL_TEXT,
  streamCall,
} from "../model/call";
import type { ModelPort, Payer, TerminalModelEvent } from "../model/port";
import { accountCallEnded, accountOrKey, keyCallEnded, type PayingAccounts } from "../payer";
import type { Push } from "../push";
import type { SecretBox } from "../secrets";
import type { ExecutionTools } from "../tools/port";
import { Draft, type DraftSource, draftTools, reviewTools } from "./draft";
import { DEFAULT_PART_MAX_CHARS, sourceParts } from "./parts";
import { removalPrompt, reviewPrompt, syncPrompt, syncSystem } from "./rules";
import { lockWiki } from "./sources";
import { syncDto } from "./sync-state";
import { currentVersionId, logTime, pagesOfVersion, publishVersion, sourcesOfVersion } from "./versions";
import { findWiki, pendingOf, toWikiDto, wikiAudience } from "./wikis";

const { wikiSyncs, wikiSources, members } = schema;

/** O teto de turnos de Ferramenta de cada chamada da Sincronização (`SHEARIM_WIKI_SYNC_MAX_TURNS`). */
export const DEFAULT_SYNC_MAX_TURNS = 40;

/** O motivo da vigia numa chamada da Sincronização. */
const SYNC_STALL_REASON = `a Articuladora ficou ${STALL_TEXT} sem responder`;

/** O motivo da Sincronização que o servidor encontrou em curso ao subir. */
const RESTART_REASON = "o servidor reiniciou";

/**
 * O que uma chamada pede à Articuladora: o texto (montado antes da 1ª tentativa; a nova tentativa
 * e a troca no meio voltam o rascunho ao mesmo ponto, então o texto vale de novo) e as Ferramentas
 * internas sobre o rascunho.
 */
type SyncCall = { prompt: string; tools: ExecutionTools };

/** A Sincronização em curso, como as chamadas dela a veem. */
type SyncRun = { id: string; startedBy: { id: string; name: string }; wiki: { name: string; description: string } };

/** Espera `ms` no relógio do Shearim; `false` se o `signal` abortou antes (cancelada, parada). */
function pause(clock: Clock, ms: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const stop = () => {
      cancel();
      resolve(false);
    };
    const cancel = clock.after(ms, () => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    });
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Por que o pedido de Sincronização foi recusado, com o motivo em pt-BR. */
export type SyncRefusal = { error: "nothing_to_sync" | "sync_running"; message: string };

/**
 * O que a próxima Sincronização faz: as Fontes "a remover" e as novas, cada lista na ordem em que
 * subiram, e as Fontes que a versão nova vai refletir.
 */
async function planOf(db: Db, wikiId: string) {
  const version = await currentVersionId(db, wikiId);
  const reflected = await sourcesOfVersion(db, version);
  const all = await db
    .select({ id: wikiSources.id, fileName: wikiSources.fileName, state: wikiSources.state })
    .from(wikiSources)
    .where(eq(wikiSources.wikiId, wikiId))
    .orderBy(asc(wikiSources.seq));
  const news = all.filter((s) => pendingOf(s, reflected) === "new");
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
  /**
   * O Admin cancelou: a Sincronização em curso na Wiki termina em `canceled` e a chamada em curso é
   * interrompida (o rascunho é descartado). `undefined` quando não há nenhuma em curso.
   */
  cancel(wikiId: string): Promise<WikiSyncDto | undefined>;
  /**
   * A subida: nenhuma Sincronização sobrevive a um reinício (o rascunho estava na memória). Toda
   * que ficou em `running` ou `queued` termina em `failed` ("o servidor reiniciou"), sem nova
   * tentativa: a Wiki ficou como estava, e o Admin sincroniza de novo.
   */
  recover(): Promise<void>;
  /**
   * Para na hora (o servidor está parando): interrompe as que estão rodando e as deixa em
   * `running`, sem gravar nada; a próxima subida as encerra (`recover`).
   */
  stop(): Promise<void>;
}

/**
 * A Sincronização é um trabalho próprio do Shearim, e não uma execução: não tem Canal nem mensagem
 * de origem. A Articuladora leva cada Fonte pendente para as páginas, uma chamada de modelo por
 * Fonte, pelas Ferramentas internas do rascunho (`draft.ts`); o Shearim publica a versão no fim,
 * numa transação só (`versions.ts`). O modelo é o da Articuladora, e o gasto conta no orçamento dela.
 *
 * Quem paga é decidido a cada chamada (`call`): a Conta do Admin que iniciou, com a Chave do
 * Workspace como reserva (`payer.ts`). Cada chamada tem a vigia das execuções (`model/call.ts`) e
 * uma nova tentativa automática; a segunda falha encerra a Sincronização com o motivo, e o Admin
 * que iniciou recebe push em `done` e em `failed`. O Admin cancela (`cancel`); ao subir, o servidor
 * encerra a que ficou em curso (`recover`). Falha, cancelamento e reinício descartam o rascunho.
 */
export function createWikiSyncs(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  model: ModelPort;
  secrets: SecretBox;
  ledger: KeyLedger;
  /** As Contas: o que a chamada pela Conta viu (limite, login caído) e a pasta segura enquanto roda. */
  accounts: PayingAccounts;
  /** O teto de turnos de Ferramenta de cada chamada (padrão: `DEFAULT_SYNC_MAX_TURNS`). */
  maxToolTurns?: number;
  /** O tamanho de parte de uma Fonte grande, em caracteres (padrão: `DEFAULT_PART_MAX_CHARS`). */
  partMaxChars?: number;
  /** O push fora de conversa (`push.notify`): o fim, para o Admin que iniciou. */
  notify?: Push["notify"];
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
    return { sync, wiki };
  }

  /**
   * Anuncia o fim e avisa por push o Admin que iniciou, em `done` e em `failed` (spec #74). O
   * cancelamento não avisa: foi o próprio Admin.
   */
  async function finished(syncId: string) {
    const seen = await publish(syncId);
    if (seen) deps.notify?.(seen.sync.startedBy.id, syncNotice(seen.wiki.name, seen.sync));
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
      .where(and(eq(wikiSyncs.id, syncId), inArray(wikiSyncs.state, [...WIKI_SYNC_OPEN_STATES])))
      .returning({ id: wikiSyncs.id });
    if (failed) await finished(syncId);
  }

  /** Grava quem paga a chamada que vai sair e anuncia, se mudou (o "pela Chave do Workspace"). */
  async function paidBy(syncId: string, payer: Payer["kind"]) {
    const [changed] = await db
      .update(wikiSyncs)
      .set({ payer })
      .where(
        and(
          eq(wikiSyncs.id, syncId),
          eq(wikiSyncs.state, "running"),
          or(isNull(wikiSyncs.payer), ne(wikiSyncs.payer, payer)),
        ),
      )
      .returning({ id: wikiSyncs.id });
    if (changed) await publish(syncId);
  }

  /**
   * A nova tentativa de uma chamada que falhou (ADR 0003): o motivo e a tentativa ficam à vista
   * enquanto ela espera (`attempt` 2); `attempt` 1 e sem motivo quando uma chamada vai bem.
   */
  async function attemptOf(syncId: string, n: number, reason: string | null) {
    const [changed] = await db
      .update(wikiSyncs)
      .set({ attempt: n, reason })
      .where(and(eq(wikiSyncs.id, syncId), eq(wikiSyncs.state, "running"), ne(wikiSyncs.attempt, n)))
      .returning({ id: wikiSyncs.id });
    if (changed) await publish(syncId);
  }

  /**
   * Uma tentativa de uma chamada, por quem `payer` diz. A vigia aborta só esta tentativa
   * (`stalled`); o cancelamento e a parada do servidor chegam pelo `controller` da Sincronização.
   */
  async function attempt(
    sync: SyncRun,
    controller: AbortController,
    asked: SyncCall,
    payer: Payer,
    articuladora: { id: string; model: string },
  ): Promise<{ end: TerminalModelEvent | undefined; stalled: boolean }> {
    const own = new AbortController();
    const forward = () => own.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", forward, { once: true });
    if (controller.signal.aborted) forward();
    const spent: Spent = { startedAt: clock.now() };
    let end: TerminalModelEvent | undefined;
    try {
      await paidBy(sync.id, payer.kind);
      ({ end } = await streamCall({
        model,
        clock,
        controller: own,
        spent,
        stallMs: STALL_MS,
        request: {
          model: articuladora.model,
          system: syncSystem(sync.wiki),
          messages: [{ role: "user", content: asked.prompt }],
          payer,
          tools: asked.tools,
          maxToolTurns: deps.maxToolTurns ?? DEFAULT_SYNC_MAX_TURNS,
        },
      }));
    } finally {
      controller.signal.removeEventListener("abort", forward);
      // O uso que a API informou conta no orçamento da Articuladora, chegando ou não ao fim.
      if (payer.kind === "key") {
        await keyCallEnded(ledger, { agentId: articuladora.id, wikiSyncId: sync.id }, spent, end);
      }
    }
    return { end, stalled: own.signal.reason === "stalled" && !controller.signal.aborted };
  }

  /**
   * Uma chamada de modelo sobre o rascunho (tirar uma Fonte removida, levar uma Fonte nova; #87: a
   * revisão, com outro `prompt` e outras `tools`). Devolve se terminou bem;
   * senão, a Sincronização já foi encerrada com o motivo (ou foi cancelada, ou o servidor está
   * parando).
   *
   * Quem paga é decidido antes de cada tentativa (`accountOrKey`): a Conta de quem iniciou, Ligada;
   * senão a Chave utilizável; senão a Sincronização falha "sem quem pague", sem nova tentativa.
   * Pela Conta, as Ferramentas internas vão pela sessão do endpoint MCP que o cérebro da Conta abre
   * para este `claude -p` e fecha quando ele sai. Troca no meio: se a Conta bate no limite ou cai, a
   * chamada é refeita inteira por quem a tabela disser agora, na mesma tentativa.
   *
   * Uma falha (a vigia inclusive) desfaz o que a tentativa escreveu no rascunho e tenta de novo uma
   * vez, 10 s depois, como nas execuções; a segunda falha encerra a Sincronização com o motivo.
   */
  async function call(sync: SyncRun, controller: AbortController, draft: Draft, asked: SyncCall): Promise<boolean> {
    const articuladora = await articuladoraOf(db);
    const before = draft.snapshot();
    let tries = 1;
    let previous: string | undefined;
    for (;;) {
      if (controller.signal.aborted) return false;
      const payer = await accountOrKey({ db, clock, secrets, ledger }, sync.startedBy.id, articuladora.id);
      if (payer.kind === "none") {
        await fail(
          sync.id,
          `sem quem pague: a Conta do Claude de ${sync.startedBy.name} ${payer.account}, e ${payer.key}`,
        );
        return false;
      }
      // A pasta da Conta fica segura até o fim do `claude -p`; se ela acabou de sair de uso (a Conta
      // foi ligada de novo), decide de novo.
      const release = payer.kind === "account" ? deps.accounts.lease(payer.configDir) : undefined;
      if (release === null) continue;
      let ended: Awaited<ReturnType<typeof attempt>>;
      try {
        ended = await attempt(sync, controller, asked, payer, articuladora);
      } finally {
        release?.();
      }
      const { end, stalled } = ended;
      // Cancelada (o estado já foi gravado) ou o servidor está parando (a subida a encerra).
      if (controller.signal.aborted) return false;
      if (
        !stalled &&
        payer.kind === "account" &&
        (await accountCallEnded(deps.accounts, payer, end)) === "decide_again"
      ) {
        draft.restore(before);
        continue;
      }
      if (!stalled && end?.type === "done") {
        if (tries > 1) await attemptOf(sync.id, 1, null);
        return true;
      }
      draft.restore(before);
      const reason = stalled ? SYNC_STALL_REASON : failureReason(end);
      if ((stalled || isRetryable(end)) && tries < MAX_ATTEMPTS) {
        tries += 1;
        previous = reason;
        // A espera conta da falha: ela já corre quando a tela mostra a nova tentativa.
        const waited = pause(clock, RETRY_DELAY_MS, controller.signal);
        await attemptOf(sync.id, tries, reason);
        if (!(await waited)) return false;
        continue;
      }
      await fail(sync.id, finalReason(reason, reason === previous));
      return false;
    }
  }

  /**
   * O trabalho, num rascunho: uma chamada por Fonte removida (as que nenhuma página cita não
   * precisam), uma por parte de cada Fonte nova, a revisão, e a publicação no fim, com a conferência
   * no relatório.
   */
  async function work(syncId: string, controller: AbortController) {
    const [row] = await db
      .update(wikiSyncs)
      .set({ state: "running", startedAt: clock.now() })
      .where(and(eq(wikiSyncs.id, syncId), eq(wikiSyncs.state, "queued")))
      .returning();
    if (!row) return;
    const wiki = (await findWiki(db, row.wikiId))!;
    const [who] = await db
      .select({ name: members.displayName })
      .from(members)
      .where(eq(members.id, row.startedByMemberId));
    const starter = { id: row.startedByMemberId, name: who?.name ?? "" };
    const plan = await planOf(db, wiki.id);
    const draft = new Draft(await pagesOfVersion(db, plan.version), plan.target);
    const run = { id: syncId, startedBy: starter, wiki };
    const total = plan.removals.length + plan.news.length;
    // As Fontes "a remover" primeiro (#88): o Shearim tira do rascunho as páginas que vinham só
    // dela e a Fonte das outras; a Articuladora reescreve essas e arruma o índice. Uma Fonte que
    // nenhuma página cita não precisa de chamada.
    for (const [i, removal] of plan.removals.entries()) {
      const position = { current: i + 1, total };
      await step(syncId, { kind: "source", ...position, fileName: removal.fileName });
      const index = draft.pages.get(WIKI_INDEX_SLUG)?.body ?? null;
      const touched = draft.takeOut(removal.id);
      if (touched.removed.length + touched.rewrite.length === 0) continue;
      const asked = {
        prompt: removalPrompt({ index, source: removal, ...touched, ...position }),
        tools: draftTools(draft),
      };
      if (!(await call(run, controller, draft, asked))) return;
    }
    // Cada Fonte nova, uma chamada por parte (#87): uma Fonte acima do tamanho de parte vai em
    // partes, e cada parte vê o índice que a anterior deixou no rascunho.
    for (const [i, news] of plan.news.entries()) {
      const position = { current: plan.removals.length + i + 1, total };
      const [source] = await db
        .select({ id: wikiSources.id, fileName: wikiSources.fileName, text: wikiSources.text })
        .from(wikiSources)
        .where(eq(wikiSources.id, news.id));
      const parts = sourceParts(source!.text, deps.partMaxChars ?? DEFAULT_PART_MAX_CHARS);
      for (const [j, text] of parts.entries()) {
        const part = parts.length > 1 ? { current: j + 1, total: parts.length } : undefined;
        await step(syncId, { kind: "source", ...position, fileName: news.fileName, ...(part && { part }) });
        const index = draft.pages.get(WIKI_INDEX_SLUG)?.body ?? null;
        const asked = {
          prompt: syncPrompt({ index, source: source!, text, ...position, part }),
          tools: draftTools(draft, source!),
        };
        if (!(await call(run, controller, draft, asked))) return;
      }
    }
    // A revisão (o lint, #87): uma chamada sobre o rascunho inteiro, que corrige links e o índice e
    // aponta as contradições. O que sobrar quebrado, a conferência em código (`draft.report()`) põe
    // no relatório, sem impedir a publicação.
    await step(syncId, { kind: "review" });
    const pages = [...draft.pages]
      .filter(([slug]) => slug !== WIKI_INDEX_SLUG && slug !== WIKI_LOG_SLUG)
      .map(([slug, p]) => ({ slug, title: p.title }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const review = {
      prompt: reviewPrompt({
        index: draft.pages.get(WIKI_INDEX_SLUG)?.body ?? null,
        pages,
        brokenLinks: draft.check().brokenLinks,
      }),
      tools: reviewTools(draft),
    };
    if (!(await call(run, controller, draft, review))) return;
    await step(syncId, { kind: "publishing" });
    const report = draft.report();
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
        logEntry: (number) =>
          logEntry({ number, by: starter.name, at: now, news: plan.news, removals: plan.removals, report }),
        now,
      });
      return true;
    });
    if (!published) return;
    await finished(syncId);
    await publishWiki(wiki.id);
  }

  return {
    async request(wikiId, by) {
      const plan = await planOf(db, wikiId);
      if (plan.news.length + plan.removals.length === 0) {
        return { error: "nothing_to_sync", message: "Nada a sincronizar: nenhuma Fonte está pendente nesta Wiki." };
      }
      const id = crypto.randomUUID();
      // Pela trava da Wiki: uma remoção de Fonte (#88) termina antes, ou vê esta em curso e recusa.
      const [created] = await db.transaction(async (tx) => {
        await lockWiki(tx, wikiId);
        return tx
          .insert(wikiSyncs)
          .values({ id, wikiId, startedByMemberId: by, createdAt: clock.now() })
          .onConflictDoNothing()
          .returning({ id: wikiSyncs.id });
      });
      if (!created) {
        const [open] = await db
          .select({ name: members.displayName })
          .from(wikiSyncs)
          .innerJoin(members, eq(members.id, wikiSyncs.startedByMemberId))
          .where(and(eq(wikiSyncs.wikiId, wikiId), inArray(wikiSyncs.state, [...WIKI_SYNC_OPEN_STATES])));
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

    async cancel(wikiId) {
      // O estado primeiro: a chamada interrompida (ou a que acabou no último instante) já não grava
      // nada, porque o trabalho só escreve numa Sincronização `running`.
      const [canceled] = await db
        .update(wikiSyncs)
        .set({ state: "canceled", step: null, reason: null, finishedAt: clock.now() })
        .where(and(eq(wikiSyncs.wikiId, wikiId), inArray(wikiSyncs.state, [...WIKI_SYNC_OPEN_STATES])))
        .returning({ id: wikiSyncs.id });
      if (!canceled) return undefined;
      running.get(canceled.id)?.controller.abort("cancelled");
      await publish(canceled.id);
      return syncDto(db, canceled.id);
    },

    async recover() {
      const open = await db
        .select({ id: wikiSyncs.id })
        .from(wikiSyncs)
        .where(inArray(wikiSyncs.state, [...WIKI_SYNC_OPEN_STATES]));
      for (const { id } of open) {
        if (!running.has(id)) await fail(id, RESTART_REASON);
      }
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
  removals: readonly { fileName: string }[];
  report: { created: { slug: string }[]; updated: { slug: string }[]; removed: { slug: string }[] };
}) {
  const when = logTime(input.at);
  const links = (refs: { slug: string }[]) => refs.map((r) => `[[${r.slug}]]`).join(", ");
  const names = (sources: readonly { fileName: string }[]) => sources.map((s) => s.fileName).join(", ");
  const lines = [`## Versão ${input.number} · ${when} · ${input.by}`];
  if (input.news.length) lines.push(`- Fontes novas: ${names(input.news)}`);
  if (input.removals.length) lines.push(`- Fontes removidas: ${names(input.removals)}`);
  if (input.report.created.length) lines.push(`- Páginas criadas: ${links(input.report.created)}`);
  if (input.report.updated.length) lines.push(`- Páginas alteradas: ${links(input.report.updated)}`);
  if (input.report.removed.length)
    lines.push(`- Páginas removidas: ${input.report.removed.map((r) => r.slug).join(", ")}`);
  return lines.join("\n");
}

/** "2 páginas criadas", "1 página alterada": o que mudou, para o push. */
function pagesText(n: number, what: string) {
  return n === 1 ? `1 página ${what}` : `${n} páginas ${what}s`;
}

/**
 * O push do fim (`done` ou `failed`) para o Admin que iniciou: a versão e o que mudou, ou o
 * motivo. Leva à tela das Wikis; um por Wiki (o novo toma o lugar do anterior).
 */
function syncNotice(wikiName: string, sync: WikiSyncDto): Parameters<Push["notify"]>[1] {
  const common = { path: WIKIS_PATH, tag: `wiki-sync-${sync.wikiId}` };
  if (sync.state === "done") {
    const { created = [], updated = [], removed = [] } = sync.report ?? {};
    const changes = [
      created.length ? pagesText(created.length, "criada") : null,
      updated.length ? pagesText(updated.length, "alterada") : null,
      removed.length ? pagesText(removed.length, "removida") : null,
    ].filter(Boolean);
    return {
      ...common,
      title: `Sincronização concluída: ${wikiName}`,
      body: `Versão ${sync.version} publicada${changes.length ? `: ${changes.join(", ")}` : ""}.`,
      urgency: "normal",
    };
  }
  return {
    ...common,
    title: `A Sincronização de ${wikiName} falhou`,
    body: sync.reason ?? "sem motivo",
    urgency: "high",
  };
}
