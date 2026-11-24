import type { ExecutionDto, ExecutionState, ExecutionStep } from "@shearim/contracts";
import { and, asc, eq, inArray, isNotNull, lte, min, ne, or, type SQL, sql } from "drizzle-orm";
import type { Agent } from "./agents";
import { ROUTING_MODEL } from "./articuladora";
import type { Clock } from "./clock";
import { buildContext, type Call } from "./context";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import { findMessage } from "./messages";
import type { ModelEvent, ModelPort, ModelRequest, Payer, TerminalModelEvent } from "./model/port";
import { outcomeOf, recordOutcome } from "./outcomes";
import { audienceOf } from "./participation";
import type { Reading } from "./reading";
import { buildRouting, parseDecision, ROUTING_SCHEMA } from "./routing";
import type { SecretBox } from "./secrets";
import { readWorkspaceKey } from "./workspace-key";

const { executions, agents, channels, messages } = schema;
type Row = typeof executions.$inferSelect;
/**
 * O tipo de uma execução: `mention` (Agente mencionado), `dm` (o Agente de uma DM com Agente),
 * `route` (o roteamento da Articuladora), `reply` (ela responde) ou `delegated` (um delegado dela).
 */
export type ExecutionKind = Row["kind"];

/** Vigia (ADR 0003): quanto um passo pode ficar sem progresso antes de virar falha. */
export const STALL_MS = 2 * 60_000;
/** A nova tentativa automática sai 10 s depois da falha. */
export const RETRY_DELAY_MS = 10_000;
/** No `SIGTERM`, quanto o dreno espera o que está rodando terminar. */
export const DRAIN_MS = 20_000;
/** A original e a nova tentativa automática. */
const MAX_ATTEMPTS = 2;

/** O motivo da vigia, por passo ("Faro não respondeu: ficou 2 minutos sem escrever nada"). */
const STALL_REASON: Record<ExecutionStep, string> = {
  deciding: "ficou 2 minutos sem dar o Desfecho",
  writing: "ficou 2 minutos sem escrever nada",
};
const RESTART_REASON = "o servidor reiniciou";

/** Por que uma execução em andamento foi interrompida (o `reason` do `AbortSignal`). */
type Interruption = "stalled" | "cancelled" | "shutdown";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Os estados em que a execução ainda não terminou: o autor pode cancelar. */
const OPEN_STATES: ExecutionState[] = ["queued", "running", "retrying"];

/** Ganchos de domínio das execuções. */
export interface ExecutionHooks {
  /**
   * Uma execução falhou de vez (depois da nova tentativa automática, ou sem ela, quando a falha
   * não vale nova tentativa). Roda depois de gravar e anunciar: é onde o push ao autor (#32) se pendura.
   */
  executionFailed?(execution: ExecutionDto): void;
}

/**
 * Execuções (Spec, módulo 6): a fila fica no Postgres e sobrevive ao reinício; um trabalhador
 * por processo pega uma de cada vez, na ordem de chegada.
 *
 * Nenhuma termina no limbo (ADR 0003): cada passo tem a vigia de 2 min sem progresso; a falha
 * é tentada de novo sozinha uma vez, 10 s depois (decidindo de novo quem paga e relendo o
 * contexto), e só então aparece com o motivo; ao subir, o que estava em andamento vira
 * "o servidor reiniciou" e segue a nova tentativa.
 *
 * Fica para depois, com o seam indicado:
 * - quem paga (Conta do autor, fila "até HH:MM", orçamento) (#27): `choosePayer`;
 * - ordem por Agente e conversa, paralelismo e tetos (#42): `claim` e o laço em `work`;
 * - incidente da Chave em `auth_failed`/`billing_failed` e o gasto por Agente (#28): `settle`;
 * - push da falha ao autor (#32): `hooks.executionFailed`.
 */
export interface Executions {
  /**
   * Põe na fila uma execução por chamada (Agente mencionado, Agente da DM), na ordem dada.
   * Chame depois de gravar a mensagem.
   */
  enqueue(
    origin: { id: string; channelId: string },
    calls: readonly { agent: Pick<Agent, "id">; kind: ExecutionKind }[],
  ): Promise<void>;
  /** O Andamento das execuções de uma conversa que ainda não viraram resposta. */
  openIn(channelId: string): Promise<ExecutionDto[]>;
  /**
   * Cancela, por quem escreveu, as execuções da mensagem que ainda não terminaram, em qualquer
   * passo: a que está rodando é interrompida. Devolve as canceladas (vazio: nada a cancelar).
   * A conferência de que é o autor fica com quem chama.
   */
  cancel(originMessageId: string): Promise<ExecutionDto[]>;
  /**
   * "Tentar de novo" de uma falha: refaz só esta execução (o passo que falhou), do começo, com
   * o contexto relido e o pagador decidido de novo (marcada como do autor, para o #27). Devolve
   * o Andamento na fila, ou nada se ela não está em falha. A conferência do autor fica com quem chama.
   */
  retry(executionId: string): Promise<ExecutionDto | undefined>;
  /** Começa a pegar trabalho. Ao subir, o que estava em andamento vira "o servidor reiniciou". */
  start(): void;
  /**
   * Para na hora: não pega mais trabalho e interrompe o que estiver rodando, que fica em
   * andamento até a próxima subida (onde vira "o servidor reiniciou").
   */
  stop(): Promise<void>;
  /** Dreno (`SIGTERM`): não pega mais trabalho, espera o que está rodando até `ms` e então para. */
  drain(ms?: number): Promise<void>;
}

export function createExecutions(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  model: ModelPort;
  secrets: SecretBox;
  hooks?: ExecutionHooks;
  /** A resposta conta como não-lida para quem participa da conversa. */
  reading: Pick<Reading, "messageCreated">;
}): Executions {
  const { db, clock, events, model, secrets, hooks, reading } = deps;

  async function publish(id: string) {
    const [dto] = await selectDtos(db, eq(executions.id, id));
    const [channel] = await db.select().from(channels).where(eq(channels.id, dto!.channelId));
    events.publish(await audienceOf(db, channel!), { type: "execution.updated", execution: dto! });
    return dto!;
  }

  /** Ao subir: toda execução em andamento ficou sem processo vivo e vira "o servidor reiniciou". */
  async function recover() {
    const orphans = await db.select().from(executions).where(eq(executions.state, "running"));
    for (const job of orphans) await fail(job, RESTART_REASON);
  }

  /** A próxima da fila (ou cuja nova tentativa venceu), por ordem de chegada, já em andamento. */
  async function claim(): Promise<Row | undefined> {
    const now = clock.now();
    return db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(or(eq(executions.state, "queued"), and(eq(executions.state, "retrying"), lte(executions.retryAt, now))))
        .orderBy(asc(executions.arrivedAt), asc(executions.seq))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return undefined;
      const [claimed] = await tx
        .update(executions)
        .set({
          state: "running",
          // O roteamento é o passo "decidindo"; o resto, "escrevendo".
          step: sql`case when ${executions.kind} = 'route' then 'deciding' else 'writing' end`,
          since: now,
          retryAt: null,
          apiRetryAttempt: null,
          apiRetryMax: null,
          attempt: sql`${executions.attempt} + 1`,
        })
        .where(eq(executions.id, next.id))
        .returning();
      return claimed;
    });
  }

  /** Quando sai a próxima nova tentativa automática, se houver. */
  async function nextRetryAt(): Promise<Date | null> {
    const [row] = await db
      .select({ at: min(executions.retryAt) })
      .from(executions)
      .where(and(eq(executions.state, "retrying"), isNotNull(executions.retryAt)));
    return row?.at ?? null;
  }

  /**
   * Quem paga esta execução, decidido de novo a cada tentativa. Hoje só a Chave; sem ela,
   * "Agentes não agem". O #27 completa a tabela; `job.retriedByAuthor` diz que é o "Tentar de
   * novo" do autor, que a Spec quer pago pela Conta dele.
   */
  async function choosePayer(_job: Row): Promise<{ kind: "key"; apiKey: string } | { kind: "none"; reason: string }> {
    const apiKey = await readWorkspaceKey(db, secrets);
    return apiKey ? { kind: "key", apiKey } : { kind: "none", reason: "o Workspace não tem Chave" };
  }

  /**
   * Encerra uma execução em andamento. Só vale se ela ainda está em andamento (um cancelamento
   * pode ter chegado antes); devolve se encerrou.
   */
  async function close(
    job: Row,
    state: Extract<ExecutionState, "done" | "failed" | "not_acting">,
    extra: { reason?: string; replyMessageId?: string } = {},
    tx: Db | Tx = db,
  ) {
    const now = clock.now();
    const updated = await tx
      .update(executions)
      .set({
        state,
        step: null,
        since: now,
        finishedAt: now,
        retryAt: null,
        apiRetryAttempt: null,
        apiRetryMax: null,
        reason: extra.reason ?? null,
        replyMessageId: extra.replyMessageId ?? null,
      })
      .where(and(eq(executions.id, job.id), eq(executions.state, "running")))
      .returning({ id: executions.id });
    return updated.length > 0;
  }

  /** Encerra e anuncia; devolve o Andamento final, ou nada se ela já não estava em andamento. */
  async function settle(
    job: Row,
    state: Extract<ExecutionState, "failed" | "not_acting">,
    extra: { reason?: string } = {},
  ) {
    return (await close(job, state, extra)) ? publish(job.id) : undefined;
  }

  /**
   * Uma tentativa falhou. Se ainda cabe a nova tentativa automática (e a falha vale uma), ela sai
   * em 10 s; senão, a falha aparece com o motivo ("nas duas tentativas" quando se repetiu).
   */
  async function fail(job: Row, reason: string, opts: { retryable?: boolean } = {}) {
    if (opts.retryable !== false && job.attempt < MAX_ATTEMPTS) {
      const now = clock.now();
      const updated = await db
        .update(executions)
        .set({
          state: "retrying",
          step: null,
          since: now,
          apiRetryAttempt: null,
          apiRetryMax: null,
          reason,
          retryAt: new Date(now.getTime() + RETRY_DELAY_MS),
        })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")))
        .returning({ id: executions.id });
      if (updated.length) await publish(job.id);
      wake();
      return;
    }
    const repeated = job.attempt > 1 && job.reason === reason;
    const failed = await settle(job, "failed", { reason: repeated ? `${reason}, nas duas tentativas` : reason });
    if (failed) hooks?.executionFailed?.(failed);
  }

  async function run(job: Row, controller: AbortController) {
    const payer = await choosePayer(job);
    if (payer.kind === "none") return void (await settle(job, "not_acting", { reason: payer.reason }));
    await db.update(executions).set({ payer: "key" }).where(eq(executions.id, job.id));
    await publish(job.id);

    const [agent] = await db.select().from(agents).where(eq(agents.id, job.agentId));
    if (job.kind === "route") return route(job, controller, agent!, payer);
    const context = await buildContext(db, agent!, job.originMessageId, await callOf(job));
    const result = await complete(job, controller, { model: agent!.model, ...context, payer });
    if (!result) return;
    const { text, end } = result;

    if (end?.type !== "done") return fail(job, failureReason(end), { retryable: isRetryable(end) });
    if (!text.trim()) return fail(job, "a resposta veio vazia");

    // A resposta e o fim juntos: um cancelamento que chegou no último instante ganha, e nada sai.
    const reply = { id: crypto.randomUUID(), createdAt: clock.now() };
    const delivered = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: executions.state })
        .from(executions)
        .where(eq(executions.id, job.id))
        .for("update");
      if (row?.state !== "running") return false;
      await tx.insert(messages).values({
        id: reply.id,
        channelId: job.channelId,
        authorAgentId: agent!.id,
        originMessageId: job.originMessageId,
        body: text.trim(),
        createdAt: reply.createdAt,
      });
      return close(job, "done", { replyMessageId: reply.id }, tx);
    });
    if (!delivered) return;
    const [channel] = await db.select().from(channels).where(eq(channels.id, job.channelId));
    const replyDto = (await findMessage(db, reply.id))!;
    events.publish(await audienceOf(db, channel!), { type: "message.created", message: replyDto });
    await reading.messageCreated(replyDto);
    await publish(job.id);
  }

  /**
   * Roda um pedido sob a vigia, com o "tentando de novo (n/m)" à vista. Devolve o texto inteiro e
   * o evento que encerrou, ou nada quando a execução foi interrompida (a vigia já registrou a falha).
   */
  async function complete(job: Row, controller: AbortController, request: ModelRequest) {
    const { signal } = controller;
    const step = (job.step as ExecutionStep | null) ?? "writing";
    const watchdog = stallWatch(clock, STALL_MS, () => controller.abort("stalled" satisfies Interruption));
    let text = "";
    let end: TerminalModelEvent | undefined;
    let apiRetrying = false;
    /** "tentando de novo (n/m)" aparece, e some quando a resposta volta a andar. */
    async function showApiRetry(retry: { attempt: number; max: number } | null) {
      apiRetrying = retry !== null;
      await db
        .update(executions)
        .set({ apiRetryAttempt: retry?.attempt ?? null, apiRetryMax: retry?.max ?? null })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")));
      await publish(job.id);
    }
    try {
      for await (const event of model.run(request, signal)) {
        if (isProgress(event)) watchdog.reset();
        if (event.type === "api_retry") await showApiRetry(event);
        else if ((event.type === "text" || event.type === "thinking") && apiRetrying) await showApiRetry(null);
        if (event.type === "text") text += event.text;
        else if (event.type !== "thinking" && event.type !== "api_retry") end = event;
      }
    } finally {
      watchdog.cancel();
    }
    if (signal.aborted) {
      // Na vigia, é falha. No cancelamento, já está gravado. No reinício, continua "em andamento"
      // até a próxima subida.
      if ((signal.reason as Interruption) === "stalled") await fail(job, STALL_REASON[step]);
      return undefined;
    }
    return { text, end };
  }

  /** Por que o Agente foi chamado (o preâmbulo do contexto). */
  async function callOf(job: Row): Promise<Call> {
    if (job.kind === "mention" || job.kind === "dm") return { kind: job.kind };
    const outcome = await outcomeOf(db, job.originMessageId);
    if (job.kind === "reply") return { kind: "reply", reason: outcome?.reason ?? "" };
    const cover = outcome?.delegates.find((d) => d.agent.id === job.agentId)?.cover ?? "";
    return { kind: "delegated", by: outcome?.by.displayName ?? "A Articuladora", cover };
  }

  /**
   * O roteamento (Spec, módulo 4): a Articuladora dá o Desfecho com o modelo barato fixo, pago
   * como qualquer execução dela. Depois de gravado e anunciado, "responder" põe na fila a
   * resposta dela e "delegar" a de cada delegado; quem entra na fila mantém a hora de chegada.
   */
  async function route(job: Row, controller: AbortController, articuladora: Agent, payer: Payer) {
    const { team, ...request } = await buildRouting(db, articuladora, job.originMessageId);
    const result = await complete(job, controller, {
      model: ROUTING_MODEL,
      ...request,
      output: { schema: ROUTING_SCHEMA },
      payer,
    });
    if (!result) return;
    const { text, end } = result;
    if (end?.type !== "done") return fail(job, failureReason(end), { retryable: isRetryable(end) });
    const decided = parseDecision(text, team);
    if (!decided) return fail(job, "a Articuladora não devolveu um Desfecho válido");

    // O Desfecho e o fim do roteamento juntos: um cancelamento que chegou antes ganha.
    const origin = { id: job.originMessageId, channelId: job.channelId };
    const delivered = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: executions.state })
        .from(executions)
        .where(eq(executions.id, job.id))
        .for("update");
      if (row?.state !== "running") return false;
      return close(job, "done", {}, tx);
    });
    if (!delivered) return;
    const outcome = await recordOutcome(db, origin, decided, clock.now());
    const [channel] = await db.select().from(channels).where(eq(channels.id, job.channelId));
    events.publish(await audienceOf(db, channel!), { type: "outcome.created", outcome });
    await publish(job.id);
    const next =
      decided.decision === "reply"
        ? [{ agent: articuladora, kind: "reply" as const }]
        : decided.delegates.map((d) => ({ agent: { id: d.agentId }, kind: "delegated" as const }));
    await insert(origin, next, job.arrivedAt);
  }

  /** Põe as chamadas na fila, chegando em `arrivedAt`, e acorda o trabalhador. */
  async function insert(
    origin: { id: string; channelId: string },
    calls: readonly { agent: Pick<Agent, "id">; kind: ExecutionKind }[],
    arrivedAt: Date,
  ) {
    if (calls.length === 0) return;
    const now = clock.now();
    const rows = calls.map(({ agent, kind }) => ({
      id: crypto.randomUUID(),
      kind,
      channelId: origin.channelId,
      originMessageId: origin.id,
      agentId: agent.id,
      state: "queued" as const,
      since: now,
      arrivedAt,
    }));
    await db.insert(executions).values(rows);
    for (const r of rows) await publish(r.id);
    wake();
  }

  // ---------- o trabalhador ----------

  let loop: Promise<void> | undefined;
  let stopping = false;
  let pending = false;
  let wakeUp: (() => void) | undefined;
  let alarm: (() => void) | undefined;
  const running = new Map<string, AbortController>();

  function wake() {
    pending = true;
    wakeUp?.();
  }

  async function idle() {
    if (pending || stopping) return;
    await new Promise<void>((resolve) => {
      wakeUp = resolve;
    });
    wakeUp = undefined;
  }

  /** Arma o despertador para a próxima nova tentativa; devolve `true` se ela já venceu. */
  async function armRetryAlarm() {
    alarm?.();
    alarm = undefined;
    const at = await nextRetryAt();
    if (!at) return false;
    const wait = at.getTime() - clock.now().getTime();
    if (wait <= 0) return true;
    alarm = clock.after(wait, wake);
    return false;
  }

  async function work() {
    await recover();
    while (!stopping) {
      pending = false;
      let job: Row | undefined;
      try {
        job = await claim();
        if (!job && (await armRetryAlarm())) continue;
      } catch (err) {
        if (stopping) break;
        console.error("shearim: a fila de execuções falhou ao pegar trabalho", err);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (!job) {
        await idle();
        continue;
      }
      const controller = new AbortController();
      running.set(job.id, controller);
      try {
        await run(job, controller);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("shearim: execução falhou", err);
          await fail(job, "erro inesperado no Shearim").catch(() => {});
        }
      } finally {
        running.delete(job.id);
      }
    }
    alarm?.();
    alarm = undefined;
  }

  async function stop() {
    stopping = true;
    for (const controller of running.values()) controller.abort("shutdown" satisfies Interruption);
    wakeUp?.();
    await loop;
    loop = undefined;
  }

  return {
    enqueue: (origin, calls) => insert(origin, calls, clock.now()),

    openIn: (channelId) => selectDtos(db, and(eq(executions.channelId, channelId), ne(executions.state, "done"))),

    async cancel(originMessageId) {
      const now = clock.now();
      const cancelled = await db
        .update(executions)
        .set({
          state: "cancelled",
          step: null,
          since: now,
          finishedAt: now,
          retryAt: null,
          apiRetryAttempt: null,
          apiRetryMax: null,
          reason: null,
        })
        .where(and(eq(executions.originMessageId, originMessageId), inArray(executions.state, OPEN_STATES)))
        .returning({ id: executions.id });
      for (const { id } of cancelled) {
        running.get(id)?.abort("cancelled" satisfies Interruption);
        await publish(id);
      }
      if (cancelled.length === 0) return [];
      return selectDtos(
        db,
        inArray(
          executions.id,
          cancelled.map((c) => c.id),
        ),
      );
    },

    async retry(executionId) {
      const now = clock.now();
      const updated = await db
        .update(executions)
        .set({
          state: "queued",
          step: null,
          since: now,
          attempt: 0,
          payer: null,
          reason: null,
          retryAt: null,
          finishedAt: null,
          retriedByAuthor: true,
        })
        .where(and(eq(executions.id, executionId), eq(executions.state, "failed")))
        .returning({ id: executions.id });
      if (updated.length === 0) return undefined;
      const dto = await publish(executionId);
      wake();
      return dto;
    },

    start() {
      if (loop) return;
      stopping = false;
      loop = work();
    },

    stop,

    async drain(ms = DRAIN_MS) {
      stopping = true;
      wakeUp?.();
      if (!loop) return;
      let cancel = () => {};
      const deadline = new Promise<void>((resolve) => {
        cancel = clock.after(ms, resolve);
      });
      await Promise.race([loop, deadline]);
      cancel();
      await stop();
    },
  };
}

/** Contam como progresso para a vigia: texto, pensamento e nova tentativa da API (nunca `ping`). */
function isProgress(event: ModelEvent) {
  return event.type === "text" || event.type === "thinking" || event.type === "api_retry";
}

/** Um prazo que recomeça a cada progresso e chama `onStall` se vencer. */
function stallWatch(clock: Clock, ms: number, onStall: () => void) {
  let cancel = clock.after(ms, onStall);
  return {
    reset() {
      cancel();
      cancel = clock.after(ms, onStall);
    },
    cancel: () => cancel(),
  };
}

/** Falhas que uma nova tentativa não conserta: a credencial e o pedido em si. */
function isRetryable(end: TerminalModelEvent | undefined) {
  if (end?.type === "auth_failed" || end?.type === "billing_failed") return false;
  if (end?.type === "failed") return end.retryable;
  return true;
}

function failureReason(end: TerminalModelEvent | undefined) {
  switch (end?.type) {
    case "auth_failed":
      return "a Chave do Workspace foi recusada pela Anthropic";
    case "billing_failed":
      return "a Chave do Workspace está sem crédito";
    case "failed":
      return end.reason;
    case "limit":
      return "a Conta bateu no limite";
    default:
      return "a resposta parou no meio";
  }
}

/** Estados em que o motivo aparece. */
const WITH_REASON: readonly ExecutionState[] = ["retrying", "failed", "not_acting"];

async function selectDtos(db: Db, where: SQL | undefined): Promise<ExecutionDto[]> {
  const rows = await db
    .select({ e: executions, agentName: agents.name, agentPhoto: agents.photo })
    .from(executions)
    .innerJoin(agents, eq(agents.id, executions.agentId))
    .where(where)
    .orderBy(asc(executions.arrivedAt), asc(executions.seq));
  return rows.map(({ e, agentName, agentPhoto }) => ({
    id: e.id,
    kind: e.kind,
    channelId: e.channelId,
    originMessageId: e.originMessageId,
    agent: { id: e.agentId, displayName: agentName, photo: agentPhoto },
    state: e.state,
    step: (e.step as ExecutionStep | null) ?? null,
    since: e.since.toISOString(),
    attempt: e.attempt,
    retryAt: e.retryAt?.toISOString() ?? null,
    apiRetry:
      e.apiRetryAttempt !== null && e.apiRetryMax !== null ? { attempt: e.apiRetryAttempt, max: e.apiRetryMax } : null,
    payer: e.payer === "key" ? "key" : null,
    reason: WITH_REASON.includes(e.state) ? e.reason : null,
    replyMessageId: e.replyMessageId,
  }));
}
