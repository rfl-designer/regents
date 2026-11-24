import type { ExecutionDto, ExecutionState, ExecutionStep, MessageDto, YourAccountDto } from "@shearim/contracts";
import { and, asc, eq, inArray, isNotNull, lte, min, ne, or, type SQL, sql } from "drizzle-orm";
import { type AccountStanding, accountStanding } from "./accounts";
import type { Agent } from "./agents";
import { ROUTING_MODEL } from "./articuladora";
import type { Clock } from "./clock";
import { buildContext, type Call } from "./context";
import { type Db, schema } from "./db/client";
import { type EventHub, without } from "./events";
import type { KeyLedger } from "./key-budget";
import { findMessage } from "./messages";
import type { ModelEvent, ModelPort, ModelRequest, Payer, TerminalModelEvent } from "./model/port";
import { outcomeOf, recordOutcome } from "./outcomes";
import { audienceOf, type Conversation } from "./participation";
import type { Reading } from "./reading";
import { buildRouting, parseDecision, ROUTING_SCHEMA } from "./routing";
import type { SecretBox } from "./secrets";
import { readWorkspaceKey } from "./workspace-key";

const { executions, agents, channels, messages, accounts } = schema;
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

/**
 * O que as execuções pedem às Contas: marcar o que a execução pela Conta viu, para que as
 * próximas nem tentem por ela (Spec, módulo 6, "Troca no meio").
 */
export interface PayingAccounts {
  markLimited(memberId: string, configDir: string, until: Date | null): Promise<void>;
  markNeedsRelink(memberId: string, configDir: string): Promise<void>;
}

/** Ganchos de domínio das execuções. */
export interface ExecutionHooks {
  /**
   * Uma execução falhou de vez (depois da nova tentativa automática, ou sem ela, quando a falha
   * não vale nova tentativa). Roda depois de gravar e anunciar: é onde o push ao autor (#32) se pendura.
   */
  executionFailed?(execution: ExecutionDto): void;
  /** A resposta de um Agente foi gravada e anunciada: é onde o push dela (#32) se pendura. */
  replyCreated?(message: MessageDto, conversation: Conversation): void;
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
 * Quem paga (#27) é a tabela da Spec, decidida em `choosePayer` a cada tentativa; sem Chave
 * utilizável, quem espera a própria Conta fica "⏸ na fila" (`held`), fora da vez, sem segurar os
 * outros, e volta com a hora de chegada de antes.
 *
 * O gasto na Chave, o orçamento e os incidentes da Chave (#28) ficam no `ledger` (`key-budget.ts`):
 * `byPayer` avisa cada chamada que a Chave pagou e cada recusa dela; `keyUsableFor` confere o orçamento.
 *
 * Fica para depois, com o seam indicado:
 * - ordem por Agente e conversa, paralelismo e tetos (#42): `claim` e o laço em `work`. A
 *   conversa para a ordem é `(channel_id, thread_root_id)`: o fluxo principal e cada Thread
 *   contam como conversas separadas (`seriesOf`);
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
  /** O Andamento das execuções de uma conversa que ainda não viraram resposta, como `viewerId` o vê. */
  openIn(channelId: string, viewerId: string): Promise<ExecutionDto[]>;
  /**
   * Cancela, por quem escreveu, as execuções da mensagem que ainda não terminaram, em qualquer
   * passo: a que está rodando é interrompida. Devolve as canceladas (vazio: nada a cancelar).
   * A conferência de que é o autor fica com quem chama.
   */
  cancel(originMessageId: string): Promise<ExecutionDto[]>;
  /**
   * Cancela, pelo Shearim, tudo o que as mensagens desse Membro ainda têm aberto (o Admin o
   * removeu), com o motivo à vista de quem vê a conversa. Devolve as canceladas.
   */
  cancelAuthoredBy(memberId: string, reason: string): Promise<ExecutionDto[]>;
  /**
   * "Tentar de novo" de uma falha: refaz só esta execução (o passo que falhou), do começo, com
   * o contexto relido e o pagador decidido de novo (marcada como do autor, para o #27). Devolve
   * o Andamento na fila, ou nada se ela não está em falha. A conferência do autor fica com quem chama.
   */
  retry(executionId: string): Promise<ExecutionDto | undefined>;
  /**
   * A Conta do Membro mudou (ligou de novo, desligou) ou, sem `memberId`, a Chave mudou: o que
   * espera na fila por quem pague decide de novo.
   */
  reconsider(memberId?: string): Promise<void>;
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
  accounts: PayingAccounts;
  hooks?: ExecutionHooks;
  /** A resposta conta como não-lida para quem participa da conversa. */
  reading: Pick<Reading, "messageCreated">;
  /** O gasto na Chave por Agente e por mês, o orçamento e os incidentes da Chave (#28). */
  ledger: KeyLedger;
}): Executions {
  const { db, clock, events, model, secrets, hooks, reading, ledger } = deps;

  /**
   * Anuncia o Andamento a quem vê a conversa. O autor recebe a sua cópia, com o que é da Conta
   * dele; os outros, a de todos. Devolve a cópia do autor (quem chama os comandos é ele).
   */
  async function publish(id: string) {
    const [view] = await selectViews(db, eq(executions.id, id), clock.now());
    const { everyone, author, authorId } = view!;
    const [channel] = await db.select().from(channels).where(eq(channels.id, everyone.channelId));
    const audience = await audienceOf(db, channel!);
    if (authorId) {
      events.publish(without(audience, authorId), { type: "execution.updated", execution: everyone });
      events.publish({ members: [authorId] }, { type: "execution.updated", execution: author });
    } else {
      events.publish(audience, { type: "execution.updated", execution: everyone });
    }
    return author;
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
        .where(
          or(
            and(
              eq(executions.state, "queued"),
              or(eq(executions.held, false), and(isNotNull(executions.heldUntil), lte(executions.heldUntil, now))),
            ),
            and(eq(executions.state, "retrying"), lte(executions.retryAt, now)),
          ),
        )
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
          held: false,
          heldUntil: null,
          apiRetryAttempt: null,
          apiRetryMax: null,
          attempt: sql`${executions.attempt} + 1`,
        })
        .where(eq(executions.id, next.id))
        .returning();
      return claimed;
    });
  }

  /** Quando sai a próxima nova tentativa automática, ou quando a próxima espera da fila vence. */
  async function nextRetryAt(): Promise<Date | null> {
    const [retry] = await db
      .select({ at: min(executions.retryAt) })
      .from(executions)
      .where(and(eq(executions.state, "retrying"), isNotNull(executions.retryAt)));
    const [held] = await db
      .select({ at: min(executions.heldUntil) })
      .from(executions)
      .where(and(eq(executions.state, "queued"), eq(executions.held, true), isNotNull(executions.heldUntil)));
    const at = [retry?.at, held?.at].filter((d): d is Date => d instanceof Date);
    return at.length ? new Date(Math.min(...at.map((d) => d.getTime()))) : null;
  }

  /**
   * "Chave utilizável" (Spec, módulo 6): existe Chave e o Agente tem orçamento no mês (conferido
   * antes de cada execução pela Chave, inclusive na troca no meio). Sem ela, o motivo (o de todos,
   * sem a Conta).
   */
  async function keyUsableFor(agent: Agent): Promise<{ apiKey: string } | { reason: string }> {
    const apiKey = await readWorkspaceKey(db, secrets);
    if (!apiKey) return { reason: "o Workspace não tem Chave" };
    const budget = await ledger.usable(agent.id);
    return budget.ok ? { apiKey } : { reason: budget.reason };
  }

  /**
   * Quem paga esta execução, pela tabela da Spec, decidido de novo a cada tentativa (inclusive o
   * "Tentar de novo" do autor, `job.retriedByAuthor`, que a mesma tabela já põe na Conta dele):
   *
   * - Conta do autor Ligada: a Conta, com ou sem Chave;
   * - No limite até HH:MM: a Chave utilizável; sem ela, a fila até HH:MM (`hold` com `until`);
   * - Precisa ligar de novo: a Chave utilizável; sem ela, a fila sem hora (`hold` sem `until`);
   * - Não ligada: a Chave utilizável; sem ela, "Agentes não agem" com o motivo.
   */
  async function choosePayer(
    job: Row,
    agent: Agent,
  ): Promise<Payer | { kind: "none"; reason: string } | { kind: "hold"; until: Date | null }> {
    const [author] = await db
      .select({ memberId: messages.authorMemberId, account: accounts })
      .from(messages)
      .leftJoin(accounts, eq(accounts.memberId, messages.authorMemberId))
      .where(eq(messages.id, job.originMessageId));
    const standing = accountStanding(author?.account, clock.now());
    if (standing.state === "linked") {
      return { kind: "account", memberId: author!.memberId!, configDir: standing.configDir };
    }
    const key = await keyUsableFor(agent);
    if ("apiKey" in key) return { kind: "key", apiKey: key.apiKey };
    if (standing.state === "limited") return { kind: "hold", until: standing.until };
    if (standing.state === "needs_relink") return { kind: "hold", until: null };
    return { kind: "none", reason: key.reason };
  }

  /**
   * Sem quem pague agora: volta para a fila, fora da vez, até `until` (ou até a Conta ou a Chave
   * mudar), sem gastar a tentativa e mantendo a hora de chegada. O texto parcial já foi descartado.
   */
  async function hold(job: Row, until: Date | null) {
    const updated = await db
      .update(executions)
      .set({
        state: "queued",
        step: null,
        since: clock.now(),
        attempt: job.attempt - 1,
        payer: null,
        held: true,
        heldUntil: until,
        apiRetryAttempt: null,
        apiRetryMax: null,
      })
      .where(and(eq(executions.id, job.id), eq(executions.state, "running")))
      .returning({ id: executions.id });
    if (updated.length) await publish(job.id);
    wake();
  }

  /**
   * Decide quem paga e faz a chamada (`complete`). Troca no meio (Spec, módulo 6): se a Conta
   * bate no limite ou cai (`limit`, `auth_failed`), ela fica "No limite até HH:MM" ou "Precisa
   * ligar de novo", o parcial é descartado e a chamada é refeita inteira por quem a tabela disser
   * agora (a Chave, ou a fila), na mesma tentativa. Nada quando "Agentes não agem" ou a fila (já
   * gravados) ou quando o `signal` abortou.
   */
  async function byPayer(
    job: Row,
    agent: Agent,
    controller: AbortController,
    build: (payer: Payer) => Promise<ModelRequest>,
  ) {
    for (;;) {
      const payer = await choosePayer(job, agent);
      if (payer.kind === "none") {
        await settle(job, "not_acting", { reason: payer.reason });
        return undefined;
      }
      if (payer.kind === "hold") {
        await hold(job, payer.until);
        return undefined;
      }
      await db
        .update(executions)
        .set({ payer: payer.kind, apiRetryAttempt: null, apiRetryMax: null })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")));
      await publish(job.id);
      const request = await build(payer);
      const result = await complete(job, controller, request);
      if (result && payer.kind === "key") {
        const end = result.end;
        if (end?.type === "done") await ledger.charged(job, { model: request.model, ...end });
        if (end?.type === "auth_failed" || end?.type === "billing_failed") await ledger.refused(end.type);
        return result;
      }
      if (!result || payer.kind !== "account") return result;
      if (result.end?.type === "limit") {
        await deps.accounts.markLimited(payer.memberId, payer.configDir, result.end.resetsAt);
        continue;
      }
      if (result.end?.type === "auth_failed") {
        await deps.accounts.markNeedsRelink(payer.memberId, payer.configDir);
        continue;
      }
      if (result.end?.type === "done" && result.end.credentialExpiresAt) {
        await db
          .update(accounts)
          .set({ credentialExpiresAt: result.end.credentialExpiresAt })
          .where(and(eq(accounts.memberId, payer.memberId), eq(accounts.configDir, payer.configDir)));
      }
      return result;
    }
  }

  /**
   * Encerra uma execução em andamento. Só vale se ela ainda está em andamento (um cancelamento
   * pode ter chegado antes); devolve se encerrou.
   */
  async function close(
    job: Row,
    state: Extract<ExecutionState, "done" | "failed" | "not_acting">,
    extra: { reason?: string; authorReason?: string; replyMessageId?: string } = {},
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
        authorReason: extra.authorReason ?? null,
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
    extra: { reason?: string; authorReason?: string } = {},
  ) {
    return (await close(job, state, extra)) ? publish(job.id) : undefined;
  }

  /**
   * Uma tentativa falhou. Se ainda cabe a nova tentativa automática (e a falha vale uma), ela sai
   * em 10 s; senão, a falha aparece com o motivo ("nas duas tentativas" quando se repetiu).
   */
  async function fail(job: Row, reason: string, opts: { retryable?: boolean; authorReason?: string } = {}) {
    const authorReason = opts.authorReason ?? null;
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
          authorReason,
          retryAt: new Date(now.getTime() + RETRY_DELAY_MS),
        })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")))
        .returning({ id: executions.id });
      if (updated.length) await publish(job.id);
      wake();
      return;
    }
    const repeated = job.attempt > 1 && job.reason === reason && job.authorReason === authorReason;
    const twice = (r: string) => (repeated ? `${r}, nas duas tentativas` : r);
    const failed = await settle(job, "failed", {
      reason: twice(reason),
      ...(authorReason ? { authorReason: twice(authorReason) } : {}),
    });
    if (failed) hooks?.executionFailed?.(failed);
  }

  async function run(job: Row, controller: AbortController) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, job.agentId));
    if (job.kind === "route") return route(job, controller, agent!);
    let context: Awaited<ReturnType<typeof buildContext>> | undefined;
    const result = await byPayer(job, agent!, controller, async (payer) => {
      context ??= await buildContext(db, agent!, job.originMessageId, await callOf(job));
      return { model: agent!.model, ...context, payer };
    });
    if (!result) return;
    const { text, end } = result;

    if (end?.type !== "done") return fail(job, failureReason(end), failureOpts(end));
    if (!text.trim()) return fail(job, "a resposta veio vazia");

    // A resposta e o fim juntos: um cancelamento que chegou no último instante ganha, e nada sai.
    const reply = { id: crypto.randomUUID(), createdAt: clock.now() };
    // A resposta ancorada a uma mensagem de Thread fica na mesma Thread.
    const [origin] = await db
      .select({ threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, job.originMessageId));
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
        threadRootId: origin?.threadRootId ?? null,
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
    hooks?.replyCreated?.(replyDto, channel!);
    await publish(job.id);
  }

  /**
   * Cancela, em qualquer passo, as execuções abertas que atendem a `where`: a que está rodando é
   * interrompida. `reason` nulo é o cancelamento por quem escreveu; com motivo, foi o Shearim.
   */
  async function cancelWhere(where: SQL, reason: string | null): Promise<ExecutionDto[]> {
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
        reason,
        authorReason: null,
        held: false,
        heldUntil: null,
      })
      .where(and(where, inArray(executions.state, OPEN_STATES)))
      .returning({ id: executions.id });
    for (const { id } of cancelled) {
      running.get(id)?.abort("cancelled" satisfies Interruption);
      await publish(id);
    }
    if (cancelled.length === 0) return [];
    const views = await selectViews(
      db,
      inArray(
        executions.id,
        cancelled.map((c) => c.id),
      ),
      clock.now(),
    );
    return views.map((v) => v.author);
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
  async function route(job: Row, controller: AbortController, articuladora: Agent) {
    let routing: Awaited<ReturnType<typeof buildRouting>> | undefined;
    const result = await byPayer(job, articuladora, controller, async (payer) => {
      routing ??= await buildRouting(db, articuladora, job.originMessageId);
      const { team: _, ...request } = routing;
      return { model: ROUTING_MODEL, ...request, output: { schema: ROUTING_SCHEMA }, payer };
    });
    if (!result) return;
    const { team } = routing!;
    const { text, end } = result;
    if (end?.type !== "done") return fail(job, failureReason(end), failureOpts(end));
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
    const [message] = await db
      .select({ threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, origin.id));
    const rows = calls.map(({ agent, kind }) => ({
      id: crypto.randomUUID(),
      kind,
      channelId: origin.channelId,
      originMessageId: origin.id,
      threadRootId: message?.threadRootId ?? null,
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

    openIn: async (channelId, viewerId) =>
      (await selectViews(db, and(eq(executions.channelId, channelId), ne(executions.state, "done")), clock.now())).map(
        (v) => (v.authorId === viewerId ? v.author : v.everyone),
      ),

    cancel: (originMessageId) => cancelWhere(eq(executions.originMessageId, originMessageId), null),

    cancelAuthoredBy: (memberId, reason) =>
      cancelWhere(
        inArray(
          executions.originMessageId,
          db.select({ id: messages.id }).from(messages).where(eq(messages.authorMemberId, memberId)),
        ),
        reason,
      ),

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
          authorReason: null,
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

    async reconsider(memberId) {
      const released = await db
        .update(executions)
        .set({ held: false, heldUntil: null })
        .where(
          and(
            eq(executions.state, "queued"),
            eq(executions.held, true),
            memberId
              ? inArray(
                  executions.originMessageId,
                  db.select({ id: messages.id }).from(messages).where(eq(messages.authorMemberId, memberId)),
                )
              : undefined,
          ),
        )
        .returning({ id: executions.id });
      for (const { id } of released) await publish(id);
      if (released.length) wake();
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

/**
 * A conversa para a ordem (Spec, módulo 6): as respostas de um mesmo Agente numa conversa saem
 * em série, e o fluxo principal e cada Thread contam como conversas separadas. SEAM do #42.
 */
export function seriesOf(job: Pick<Row, "agentId" | "channelId" | "threadRootId">) {
  return { agentId: job.agentId, channelId: job.channelId, threadRootId: job.threadRootId };
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

function failureOpts(end: TerminalModelEvent | undefined) {
  return {
    retryable: isRetryable(end),
    ...(end?.type === "failed" && end.authorReason ? { authorReason: end.authorReason } : {}),
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
    default:
      return "a resposta parou no meio";
  }
}

/** Estados em que o motivo aparece. */
const WITH_REASON: readonly ExecutionState[] = ["retrying", "failed", "not_acting", "cancelled"];

/**
 * O Andamento de cada execução nas duas cópias: a de todos e a do autor da mensagem de origem,
 * que traz também o motivo ligado à Conta dele (`yourAccount`, e `authorReason` no lugar de
 * `reason`). O estado da Conta é lido agora: é o dele, que só ele vê.
 */
async function selectViews(
  db: Db,
  where: SQL | undefined,
  now: Date,
): Promise<{ everyone: ExecutionDto; author: ExecutionDto; authorId: string | null }[]> {
  const rows = await db
    .select({
      e: executions,
      agentName: agents.name,
      agentPhoto: agents.photo,
      authorId: messages.authorMemberId,
      account: accounts,
    })
    .from(executions)
    .innerJoin(agents, eq(agents.id, executions.agentId))
    .innerJoin(messages, eq(messages.id, executions.originMessageId))
    .leftJoin(accounts, eq(accounts.memberId, messages.authorMemberId))
    .where(where)
    .orderBy(asc(executions.arrivedAt), asc(executions.seq));
  return rows.map(({ e, agentName, agentPhoto, authorId, account }) => {
    const reason = WITH_REASON.includes(e.state) ? e.reason : null;
    const everyone: ExecutionDto = {
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
        e.apiRetryAttempt !== null && e.apiRetryMax !== null
          ? { attempt: e.apiRetryAttempt, max: e.apiRetryMax }
          : null,
      payer: e.payer === "key" ? "key" : null,
      reason,
      held: e.state === "queued" && e.held,
      yourAccount: null,
      replyMessageId: e.replyMessageId,
    };
    // A Conta explica o que se vê quando outra coisa paga, espera ou não age no lugar dela.
    const explains = everyone.held || everyone.payer === "key" || e.state === "not_acting";
    const author: ExecutionDto = {
      ...everyone,
      reason: reason && (e.authorReason ?? reason),
      yourAccount: explains ? yourAccount(accountStanding(account, now)) : null,
    };
    return { everyone, author, authorId };
  });
}

function yourAccount(standing: AccountStanding): YourAccountDto | null {
  switch (standing.state) {
    case "linked":
      return null;
    case "limited":
      return { state: "limited", until: standing.until.toISOString() };
    default:
      return { state: standing.state };
  }
}
