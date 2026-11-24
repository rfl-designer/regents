import type { ExecutionDto, ExecutionState, ExecutionStep } from "@shearim/contracts";
import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import type { Agent } from "./agents";
import type { Clock } from "./clock";
import { buildContext } from "./context";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import { findMessage } from "./messages";
import type { ModelPort, TerminalModelEvent } from "./model/port";
import { audienceOf } from "./participation";
import type { SecretBox } from "./secrets";
import { readWorkspaceKey } from "./workspace-key";

const { executions, agents, channels, messages } = schema;
type Row = typeof executions.$inferSelect;
/** O tipo de uma execução: `mention` (Agente mencionado) ou `dm` (o Agente de uma DM com Agente). */
export type ExecutionKind = Row["kind"];

/**
 * Execuções (Spec, módulo 6), no mínimo do #20: a fila fica no Postgres e sobrevive ao
 * reinício; um trabalhador por processo pega uma de cada vez, na ordem de chegada, e paga
 * pela Chave do Workspace.
 *
 * Fica para depois, com o seam indicado:
 * - vigia de 2 min, nova tentativa em 10 s, "Tentar de novo" e cancelamento (#24): `run`;
 * - quem paga (Conta do autor, fila "até HH:MM", orçamento) (#27): `choosePayer`;
 * - ordem por Agente e conversa, paralelismo e tetos (#42): `claim` e o laço em `start`;
 * - incidente da Chave em `auth_failed`/`billing_failed` e o gasto por Agente (#28): `finish`.
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
  /** O Andamento das execuções de um Canal que ainda não viraram resposta. */
  openIn(channelId: string): Promise<ExecutionDto[]>;
  /** Começa a pegar trabalho. Ao subir, o que estava em andamento volta para a fila. */
  start(): void;
  /** Para de pegar trabalho e interrompe o que estiver rodando (fica para a próxima subida). */
  stop(): Promise<void>;
}

export function createExecutions(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  model: ModelPort;
  secrets: SecretBox;
}): Executions {
  const { db, clock, events, model, secrets } = deps;

  async function publish(id: string) {
    const [dto] = await selectDtos(db, eq(executions.id, id));
    const [channel] = await db.select().from(channels).where(eq(channels.id, dto!.channelId));
    events.publish(await audienceOf(db, channel!), { type: "execution.updated", execution: dto! });
  }

  /**
   * Ao subir: toda execução em andamento ficou sem processo. No #20 ela volta para a fila e
   * sai de novo; o #24 troca isto por falha "o servidor reiniciou" com nova tentativa sozinha.
   */
  async function recover() {
    await db
      .update(executions)
      .set({ state: "queued", step: null, payer: null, since: clock.now() })
      .where(eq(executions.state, "running"));
  }

  /** A próxima da fila, por ordem de chegada, já marcada como em andamento. */
  async function claim(): Promise<Row | undefined> {
    return db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.state, "queued"))
        .orderBy(asc(executions.arrivedAt), asc(executions.seq))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return undefined;
      const [claimed] = await tx
        .update(executions)
        .set({ state: "running", step: "writing", since: clock.now(), attempt: sql`${executions.attempt} + 1` })
        .where(eq(executions.id, next.id))
        .returning();
      return claimed;
    });
  }

  /** Quem paga esta execução. Hoje só a Chave; sem ela, "Agentes não agem" (#27 completa a tabela). */
  async function choosePayer(): Promise<{ kind: "key"; apiKey: string } | { kind: "none"; reason: string }> {
    const apiKey = await readWorkspaceKey(db, secrets);
    return apiKey ? { kind: "key", apiKey } : { kind: "none", reason: "o Workspace não tem Chave" };
  }

  async function finish(
    job: Row,
    state: Extract<ExecutionState, "done" | "failed" | "not_acting">,
    extra: { reason?: string; replyMessageId?: string } = {},
  ) {
    const now = clock.now();
    await db
      .update(executions)
      .set({
        state,
        step: null,
        since: now,
        finishedAt: now,
        reason: extra.reason ?? null,
        replyMessageId: extra.replyMessageId ?? null,
      })
      .where(eq(executions.id, job.id));
    await publish(job.id);
  }

  async function run(job: Row, signal: AbortSignal) {
    const payer = await choosePayer();
    if (payer.kind === "none") return finish(job, "not_acting", { reason: payer.reason });
    await db.update(executions).set({ payer: "key" }).where(eq(executions.id, job.id));
    await publish(job.id);

    const [agent] = await db.select().from(agents).where(eq(agents.id, job.agentId));
    const context = await buildContext(db, agent!, job.originMessageId, { kind: job.kind });
    let text = "";
    let end: TerminalModelEvent | undefined;
    for await (const event of model.run({ model: agent!.model, ...context, payer }, signal)) {
      if (event.type === "text") text += event.text;
      else if (event.type !== "thinking" && event.type !== "api_retry") end = event;
    }
    if (signal.aborted) return; // parou no meio (reinício): continua "em andamento" até a próxima subida

    if (end?.type !== "done") return finish(job, "failed", { reason: failureReason(end) });
    if (!text.trim()) return finish(job, "failed", { reason: "a resposta veio vazia" });

    const reply = { id: crypto.randomUUID(), createdAt: clock.now() };
    await db.insert(messages).values({
      id: reply.id,
      channelId: job.channelId,
      authorAgentId: agent!.id,
      originMessageId: job.originMessageId,
      body: text.trim(),
      createdAt: reply.createdAt,
    });
    const [channel] = await db.select().from(channels).where(eq(channels.id, job.channelId));
    events.publish(await audienceOf(db, channel!), {
      type: "message.created",
      message: (await findMessage(db, reply.id))!,
    });
    await finish(job, "done", { replyMessageId: reply.id });
  }

  // ---------- o trabalhador ----------

  let loop: Promise<void> | undefined;
  let stopping = false;
  let pending = false;
  let wakeUp: (() => void) | undefined;
  let current: AbortController | undefined;

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

  async function work() {
    await recover();
    while (!stopping) {
      pending = false;
      let job: Row | undefined;
      try {
        job = await claim();
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
      current = controller;
      try {
        await run(job, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("shearim: execução falhou", err);
          await finish(job, "failed", { reason: "erro inesperado no Shearim" }).catch(() => {});
        }
      } finally {
        current = undefined;
      }
    }
  }

  const enqueue: Executions["enqueue"] = async (origin, calls) => {
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
      arrivedAt: now,
    }));
    await db.insert(executions).values(rows);
    for (const r of rows) await publish(r.id);
    wake();
  };

  return {
    enqueue,

    openIn: (channelId) => selectDtos(db, and(eq(executions.channelId, channelId), ne(executions.state, "done"))),

    start() {
      if (loop) return;
      stopping = false;
      loop = work();
    },

    async stop() {
      stopping = true;
      current?.abort();
      wakeUp?.();
      await loop;
      loop = undefined;
    },
  };
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

async function selectDtos(db: Db, where: SQL | undefined): Promise<ExecutionDto[]> {
  const rows = await db
    .select({ e: executions, agentName: agents.name, agentPhoto: agents.photo })
    .from(executions)
    .innerJoin(agents, eq(agents.id, executions.agentId))
    .where(where)
    .orderBy(asc(executions.arrivedAt), asc(executions.seq));
  return rows.map(({ e, agentName, agentPhoto }) => ({
    id: e.id,
    channelId: e.channelId,
    originMessageId: e.originMessageId,
    agent: { id: e.agentId, displayName: agentName, photo: agentPhoto },
    state: e.state,
    step: (e.step as ExecutionStep | null) ?? null,
    since: e.since.toISOString(),
    attempt: e.attempt,
    payer: e.payer === "key" ? "key" : null,
    reason: e.reason,
    replyMessageId: e.replyMessageId,
  }));
}
