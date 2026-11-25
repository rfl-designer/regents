import {
  type ExecutionDto,
  type ExecutionState,
  type ExecutionStep,
  OPEN_STATES,
  type YourAccountDto,
} from "@shearim/contracts";
import { type AnyColumn, and, asc, desc, eq, gt, inArray, isNull, lte, min, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type AccountStanding, accountStanding } from "./accounts";
import type { Agent } from "./agents";
import { APPROVAL_EXPIRED_REASON, continuationNote, insertApproval, publishApproval } from "./approvals";
import { ROUTING_MODEL } from "./articuladora";
import type { Clock } from "./clock";
import { buildContext, type Call } from "./context";
import { type Db, schema, type Tx } from "./db/client";
import { type EventHub, reaches, without } from "./events";
import { type KeyLedger, monthOf } from "./key-budget";
import { recordMentions } from "./mentions";
import { findMessage } from "./messages";
import type { ModelEvent, ModelPort, ModelRequest, ModelUsage, Payer, TerminalModelEvent } from "./model/port";
import { outcomeOf, recordOutcome } from "./outcomes";
import { audienceOf } from "./participation";
import type { Push } from "./push";
import type { Reading } from "./reading";
import { buildRouting, parseDecision, ROUTING_SCHEMA } from "./routing";
import type { SecretBox } from "./secrets";
import { recordFollows } from "./threads";
import { type ToolPort, toolCallsOf, withoutConnect } from "./tools/port";
import { readWorkspaceKey } from "./workspace-key";

const { executions, agents, channels, messages, accounts, approvalRequests } = schema;
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
const DAY_MS = 24 * 60 * 60_000;
/** A original e a nova tentativa automática. */
const MAX_ATTEMPTS = 2;

/** Os tetos de concorrência (Spec, módulo 6, Tetos), ajustáveis no `.env` (`main.ts`). */
export interface ExecutionLimits {
  /** Respostas ao mesmo tempo pela Conta de um Membro. O roteamento fica fora dessa conta. */
  perAccount: number;
  /** Execuções ao mesmo tempo pela Chave do Workspace (roteamento incluso). */
  key: number;
  /** Processos `claude -p` ao mesmo tempo no host: as execuções pela Conta, roteamento incluso. */
  processes: number;
}
export const DEFAULT_LIMITS: ExecutionLimits = { perAccount: 2, key: 4, processes: 8 };

const LIMIT_VARS = {
  perAccount: "SHEARIM_MAX_PER_ACCOUNT",
  key: "SHEARIM_MAX_ON_KEY",
  processes: "SHEARIM_MAX_PROCESSES",
} as const satisfies Record<keyof ExecutionLimits, string>;

/**
 * Os tetos que o `.env` ajusta (`SHEARIM_MAX_PER_ACCOUNT`, `SHEARIM_MAX_ON_KEY`,
 * `SHEARIM_MAX_PROCESSES`); o que falta fica com o padrão. Valor que não é inteiro maior que zero
 * é erro (o servidor não sobe).
 */
export function limitsFromEnv(env: Record<string, string | undefined>): Partial<ExecutionLimits> {
  const limits: Partial<ExecutionLimits> = {};
  for (const [field, name] of Object.entries(LIMIT_VARS) as [keyof ExecutionLimits, string][]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name}=${raw} não é um número inteiro maior que zero.`);
    limits[field] = n;
  }
  return limits;
}

/** O motivo da vigia, por passo ("Faro não respondeu: ficou 2 minutos sem escrever nada"). */
const STALL_REASON: Record<ExecutionStep, string> = {
  deciding: "ficou 2 minutos sem dar o Desfecho",
  writing: "ficou 2 minutos sem escrever nada",
  // Enquanto a Ferramenta roda, vale o prazo dela (a vigia espera); este só aparece se nada a encerra.
  tool: "ficou 2 minutos sem escrever nada",
};
const RESTART_REASON = "o servidor reiniciou";
/** Quando a expiração dos Pedidos falha, a nova tentativa sai depois disso. */
const EXPIRY_RETRY_MS = 60_000;
/** A causa do resultado incerto de uma ação aprovada que o servidor deixou no meio. */
const RESTART_DURING_ACTION = "o servidor reiniciou durante a ação";

/** Por que uma execução em andamento foi interrompida (o `reason` do `AbortSignal`). */
type Interruption = "stalled" | "cancelled" | "shutdown" | "approval";

/**
 * O que as execuções pedem às Contas: marcar o que a execução pela Conta viu, para que as
 * próximas nem tentem por ela (Spec, módulo 6, "Troca no meio").
 */
export interface PayingAccounts {
  markLimited(memberId: string, configDir: string, until: Date | null): Promise<void>;
  markNeedsRelink(memberId: string, configDir: string): Promise<void>;
  /**
   * Segura a pasta `configDir` enquanto um `claude -p` roda nela: depois de ligar de novo, a pasta
   * antiga só é apagada quando o último solta (ADR 0005). `null` quando a pasta já saiu de uso (a
   * Conta acabou de ser ligada de novo): a execução volta para a fila e decide de novo quem paga.
   */
  lease(configDir: string): (() => void) | null;
  /** O fim com sucesso pela pasta `configDir`: a validade (`credential_expires_at`) e o uso extra. */
  runEnded(
    memberId: string,
    configDir: string,
    seen: { credentialExpiresAt?: Date; extraUsage?: boolean },
  ): Promise<void>;
}

/** Ganchos de domínio das execuções. */
export interface ExecutionHooks {
  /**
   * Uma execução falhou de vez (depois da nova tentativa automática, ou sem ela, quando a falha
   * não vale nova tentativa). Roda depois de gravar e anunciar: o push ao autor (#32) sai daqui.
   */
  executionFailed?(execution: ExecutionDto): void;
}

/**
 * Execuções (Spec, módulo 6): a fila fica no Postgres e sobrevive ao reinício; um trabalhador
 * por processo põe várias para rodar ao mesmo tempo (#42):
 *
 * - **Ordem:** as respostas de um mesmo Agente numa conversa (`onTurn`) saem em série, na ordem
 *   de chegada; uma resposta também espera o roteamento ainda aberto de uma mensagem anterior da
 *   mesma conversa (ele pode pôr na fila uma resposta que vem antes dela). Agentes diferentes
 *   respondem em paralelo. Quem espera a própria Conta (`held`) sai da série.
 * - **Tetos:** `ExecutionLimits` (2 respostas por Conta, 4 na Chave, 8 processos no host). O que
 *   não cabe agora fica "esperando a vez" (`waitingTurn`) até abrir lugar.
 * - **Prioridade:** o roteamento passa na frente das respostas; entre as respostas, a ordem de
 *   chegada. Quem troca de fila (a troca no meio da Conta para a Chave, a volta da espera por
 *   quem pague) mantém a hora de chegada.
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
 * A falha de vez sai pelo gancho `hooks.executionFailed` (é dali que sai o push ao autor, #32).
 */
export interface Executions {
  /**
   * Grava na fila uma execução por chamada (Agente mencionado, Agente da DM), na ordem dada, na
   * mesma transação `tx` que grava a mensagem: nenhuma mensagem fica sem Andamento (ADR 0003),
   * nem se o que vem depois de gravar falhar. Devolve os ids; depois do commit, `queued(ids)`.
   */
  enqueue(
    tx: Db | Tx,
    origin: { id: string; channelId: string },
    calls: readonly { agent: Pick<Agent, "id">; kind: ExecutionKind }[],
  ): Promise<string[]>;
  /** Anuncia o Andamento das execuções que `enqueue` gravou e acorda o trabalhador. */
  queued(ids: readonly string[]): Promise<void>;
  /**
   * O Pedido de aprovação `approvalRequestId` foi decidido (ADR 0011): a execução que esperava
   * (`executionId`) termina, e entra na fila a continuação da resposta, ligada ao Pedido, com a
   * mesma mensagem de origem e a hora de chegada dela. Nada se ela já não esperava aprovação.
   */
  continueAfter(executionId: string, approvalRequestId: string): Promise<void>;
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
   * o contexto relido e o pagador decidido de novo pela mesma tabela de quem paga. Devolve
   * o Andamento na fila, ou nada se ela não está em falha. A conferência do autor fica com quem chama.
   */
  retry(executionId: string): Promise<ExecutionDto | undefined>;
  /**
   * A Conta do Membro mudou (ligou de novo, desligou) ou, sem `memberId`, a Chave ou um orçamento
   * mudou: o que espera na fila por quem pague decide de novo. A virada do mês (o orçamento
   * recomeça) chama sozinha, enquanto o trabalhador roda.
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
  /** O push da resposta (#32), pelo mesmo caminho da mensagem de pessoa, e o do Pedido de aprovação (#52). */
  push: Pick<Push, "messageCreated" | "approvalRequested">;
  /** O gasto na Chave por Agente e por mês, o orçamento e os incidentes da Chave (#28). */
  ledger: KeyLedger;
  /** A porta de Ferramentas: as Ferramentas de cada execução, com o passo no Andamento. */
  tools: ToolPort;
  /** Os tetos de concorrência (padrão: os da Spec, `DEFAULT_LIMITS`). */
  limits?: Partial<ExecutionLimits>;
  /** O teto de turnos de Ferramenta de uma resposta (padrão: `MAX_TOOL_TURNS`, 20; #53). */
  maxToolTurns?: number;
  /** O prazo do Pedido de aprovação (padrão: 24 h, `APPROVAL_TTL_MS`; `SHEARIM_APPROVAL_TTL_H`). */
  approvalTtlMs?: number;
}): Executions {
  const { db, clock, events, model, secrets, hooks, reading, ledger, push } = deps;
  const limits: ExecutionLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  /** As que o trabalhador olhou e não pôde pôr para rodar agora: "esperando a vez". */
  const waiting = new Set<string>();
  const views = (where: SQL | undefined) => selectViews(db, where, clock.now(), waiting);

  /**
   * Os anúncios de uma mesma execução saem um depois do outro: cada um lê o estado na sua vez,
   * então um anúncio mais velho nunca chega depois de um mais novo (várias rodam ao mesmo tempo).
   */
  const announcing = new Map<string, Promise<unknown>>();
  function publish(id: string): Promise<ExecutionDto> {
    const next = (announcing.get(id) ?? Promise.resolve()).catch(() => {}).then(() => announce(id));
    announcing.set(id, next);
    void next
      .finally(() => {
        if (announcing.get(id) === next) announcing.delete(id);
      })
      .catch(() => {});
    return next;
  }

  /**
   * Anuncia o Andamento a quem vê a conversa. O autor recebe a sua cópia, com o que é da Conta
   * dele; os outros, a de todos. Devolve a cópia do autor (quem chama os comandos é ele).
   */
  async function announce(id: string) {
    const [view] = await views(eq(executions.id, id));
    const { everyone, author, authorId } = view!;
    const { audience } = await conversationOf(everyone.channelId);
    if (authorId) {
      events.publish(without(audience, authorId), { type: "execution.updated", execution: everyone });
      events.publish({ members: [authorId] }, { type: "execution.updated", execution: author });
    } else {
      events.publish(audience, { type: "execution.updated", execution: everyone });
    }
    return author;
  }

  /** A conversa da execução e quem recebe os eventos dela. */
  async function conversationOf(channelId: string) {
    const [conversation] = await db.select().from(channels).where(eq(channels.id, channelId));
    return { conversation: conversation!, audience: await audienceOf(db, conversation!) };
  }

  /**
   * Passa a execução `id` para outro estado, se ela ainda está em `from` (um cancelamento pode ter
   * chegado antes). Zera sempre o que só vale dentro de um passo (o passo e o "tentando de novo
   * (n/m)") e recomeça o `since`; `change` diz o resto. Devolve se passou.
   */
  async function transition(
    id: string,
    state: ExecutionState,
    change: Partial<typeof executions.$inferInsert> = {},
    opts: { from?: ExecutionState; tx?: Db | Tx } = {},
  ) {
    const updated = await (opts.tx ?? db)
      .update(executions)
      .set({ ...leaving(state, clock.now()), ...change })
      .where(and(eq(executions.id, id), eq(executions.state, opts.from ?? "running")))
      .returning({ id: executions.id });
    return updated.length > 0;
  }

  /**
   * De volta para a fila (a espera por quem pague, a troca de fila): sem gastar a tentativa, sem
   * pagador, mantendo a hora de chegada. Anuncia e acorda o trabalhador.
   */
  async function backToQueue(job: Row, change: Partial<typeof executions.$inferInsert> = {}) {
    if (await transition(job.id, "queued", { attempt: job.attempt - 1, payer: null, ...change })) {
      await publish(job.id);
    }
    wake();
  }

  /**
   * Ao subir: toda execução em andamento ficou sem processo vivo e vira "o servidor reiniciou". E o
   * Pedido decidido cuja continuação não saiu (o servidor caiu entre a decisão e ela) continua
   * agora (ADR 0003). A ação aprovada sem resultado gravado não se repete: pode ter sido feita, e o
   * resultado fica incerto.
   */
  async function recover() {
    const orphans = await db.select().from(executions).where(eq(executions.state, "running"));
    for (const job of orphans) await fail(job, RESTART_REASON);
    const decided = await db
      .select({ r: approvalRequests })
      .from(approvalRequests)
      .innerJoin(executions, eq(executions.id, approvalRequests.executionId))
      .where(and(eq(executions.state, "awaiting_approval"), inArray(approvalRequests.state, ["approved", "rejected"])));
    for (const { r } of decided) {
      if (r.state === "approved" && r.result === null && r.failure === null) {
        await db
          .update(approvalRequests)
          .set({ failure: await deps.tools.uncertainReason(r.tool, RESTART_DURING_ACTION), uncertain: true })
          .where(and(eq(approvalRequests.id, r.id), isNull(approvalRequests.result), isNull(approvalRequests.failure)));
        await publishApproval(db, events, r.id, "approval.updated");
      }
      await continueAfter(r.executionId, r.id);
    }
  }

  /**
   * As que podem sair agora (prontas e na vez da sua série), na ordem da Prioridade: o roteamento
   * na frente, depois a ordem de chegada.
   */
  function candidates(now: Date) {
    return db
      .select()
      .from(executions)
      .where(and(readyAt(now), onTurn(now)))
      .orderBy(desc(sql`${executions.kind} = 'route'`), ...arrivalOrder(executions).map((c) => asc(c)));
  }

  /**
   * Põe a execução em andamento, se ela ainda está pronta e na vez. Atômico no Postgres: o
   * `UPDATE` só pega a linha no estado de fila (dois trabalhadores nunca pegam a mesma), e o lock
   * da conversa faz duas pegas da mesma conversa se verem (a série nunca anda em dobro).
   */
  async function claim(candidate: Row, now: Date): Promise<Row | undefined> {
    const conversation = `${candidate.channelId}:${candidate.threadRootId ?? ""}`;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${conversation}, 0))`);
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
          toolLimit: false,
          attempt: sql`${executions.attempt} + 1`,
        })
        .where(and(eq(executions.id, candidate.id), readyAt(now), onTurn(now)))
        .returning();
      return claimed;
    });
  }

  /**
   * Quando sai a próxima nova tentativa automática, ou quando a próxima espera da fila vence,
   * depois de `now` (as de até `now` o trabalhador já olhou).
   */
  async function nextRetryAt(now: Date): Promise<Date | null> {
    const [retry] = await db
      .select({ at: min(executions.retryAt) })
      .from(executions)
      .where(and(eq(executions.state, "retrying"), gt(executions.retryAt, now)));
    const [held] = await db
      .select({ at: min(executions.heldUntil) })
      .from(executions)
      .where(and(eq(executions.state, "queued"), eq(executions.held, true), gt(executions.heldUntil, now)));
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
   * Quem paga esta execução, pela tabela da Spec, decidido de novo a cada tentativa (o "Tentar de
   * novo" do autor também: com a Conta dele no limite, sai pela Chave):
   *
   * - Conta do autor Ligada: a Conta, com ou sem Chave;
   * - No limite até HH:MM: a Chave utilizável; sem ela, a fila até HH:MM (`hold` com `until`);
   * - Precisa ligar de novo: a Chave utilizável; sem ela, a fila sem hora (`hold` sem `until`);
   * - Não ligada: a Chave utilizável; sem ela, "Agentes não agem" com o motivo.
   */
  async function choosePayer(job: Row, agent: Agent): Promise<Choice> {
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

  /** O estado da Conta do autor da mensagem de origem agora, quando ele explica algo (`yourAccount`). */
  async function authorAccount(job: Row) {
    const [author] = await db
      .select({ account: accounts })
      .from(messages)
      .leftJoin(accounts, eq(accounts.memberId, messages.authorMemberId))
      .where(eq(messages.id, job.originMessageId));
    return yourAccount(accountStanding(author?.account, clock.now()));
  }

  /**
   * Sem quem pague agora: volta para a fila, fora da vez, até `until` (ou até a Conta ou a Chave
   * mudar), sem gastar a tentativa e mantendo a hora de chegada. O texto parcial já foi descartado.
   */
  async function hold(job: Row, until: Date | null) {
    await backToQueue(job, { held: true, heldUntil: until });
  }

  /**
   * Troca de fila (a Conta caiu no meio): volta para a fila, na vez, sem gastar a tentativa e
   * mantendo a hora de chegada. O trabalhador decide de novo quem paga quando houver lugar.
   */
  async function requeue(job: Row) {
    await backToQueue(job);
  }

  /**
   * Faz a chamada (`complete`) por quem o trabalhador decidiu que paga. Troca no meio (Spec,
   * módulo 6): se a Conta bate no limite ou cai (`limit`, `auth_failed`), ela fica "No limite até
   * HH:MM" ou "Precisa ligar de novo", o parcial é descartado e a execução volta para a fila com
   * a hora de chegada, para ser refeita inteira por quem a tabela disser agora (a Chave, cabendo
   * no teto dela, ou a espera), na mesma tentativa. Nada quando "Agentes não agem" ou a fila (já
   * gravados) ou quando o `signal` abortou.
   */
  async function byPayer(
    job: Row,
    payer: Choice,
    controller: AbortController,
    build: (payer: Payer) => Promise<ModelRequest>,
  ) {
    if (payer.kind === "none") {
      await settle(job, "not_acting", { reason: payer.reason });
      return undefined;
    }
    if (payer.kind === "hold") {
      await hold(job, payer.until);
      return undefined;
    }
    // A pasta fica segura até o fim do `claude -p`; se ela acabou de sair de uso (a Conta foi
    // ligada de novo), a execução volta para a fila e o trabalhador decide de novo.
    const release = payer.kind === "account" ? deps.accounts.lease(payer.configDir) : undefined;
    if (release === null) {
      await requeue(job);
      return undefined;
    }
    let result: Awaited<ReturnType<typeof complete>>;
    const spent: Spent = { startedAt: clock.now() };
    try {
      // Pela Chave, o porquê ligado à Conta do autor fica gravado: a resposta o leva (só para ele).
      const payerAccount = payer.kind === "key" ? await authorAccount(job) : null;
      await db
        .update(executions)
        .set({ payer: payer.kind, payerAccount, apiRetryAttempt: null, apiRetryMax: null })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")));
      await publish(job.id);
      const request = await build(payer);
      spent.startedAt = clock.now();
      result = await complete(job, controller, request, spent);
      if (payer.kind === "key") {
        const end = result?.end;
        if (end?.type === "auth_failed" || end?.type === "billing_failed") await ledger.refused(end.type);
        return result;
      }
    } finally {
      release?.();
      // Pela Chave, conta o uso que a API informou, chegando ou não ao fim (cancelada, parada pela
      // vigia, falha no meio), no modelo que respondeu.
      if (payer.kind === "key" && spent.usage) {
        await ledger.charged(job, { ...spent.usage, startedAt: spent.startedAt, succeeded: spent.succeeded === true });
      }
    }
    if (!result || payer.kind !== "account") return result;
    if (result.end?.type === "limit" || result.end?.type === "auth_failed") {
      if (result.end.type === "limit") {
        await deps.accounts.markLimited(payer.memberId, payer.configDir, result.end.resetsAt);
      } else {
        await deps.accounts.markNeedsRelink(payer.memberId, payer.configDir);
      }
      await requeue(job);
      return undefined;
    }
    if (result.end?.type === "done") {
      const { credentialExpiresAt, extraUsage } = result.end;
      await deps.accounts.runEnded(payer.memberId, payer.configDir, { credentialExpiresAt, extraUsage });
    }
    return result;
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
    return transition(
      job.id,
      state,
      {
        reason: extra.reason ?? null,
        authorReason: extra.authorReason ?? null,
        replyMessageId: extra.replyMessageId ?? null,
      },
      { tx },
    );
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
      const retryAt = new Date(clock.now().getTime() + RETRY_DELAY_MS);
      if (await transition(job.id, "retrying", { reason, authorReason, retryAt })) await publish(job.id);
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

  async function run(job: Row, agent: Agent, payer: Choice, controller: AbortController) {
    if (job.kind === "route") return route(job, payer, controller, agent);
    const result = await byPayer(job, payer, controller, async (payer) => {
      const tools = toolsOf(job);
      const offered = await tools.list();
      const context = await buildContext(db, agent, job.originMessageId, await callOf(job), offered);
      // A continuação sabe o que a resposta já pediu e o que o autor decidiu (ADR 0011).
      if (job.approvalRequestId) {
        const note = await continuationNote(db, job.approvalRequestId);
        context.messages = context.messages.map((m, i) =>
          i === context.messages.length - 1 ? { ...m, content: `${m.content}\n\n${note}` } : m,
        );
      }
      return {
        model: agent.model,
        ...context,
        payer,
        // A continuação de um Pedido é uma execução nova: conta o teto do zero.
        ...(offered.length ? { tools, maxToolTurns: deps.maxToolTurns } : {}),
      };
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
    const threadRootId = origin?.threadRootId ?? null;
    const { conversation: channel, audience } = await conversationOf(job.channelId);
    // As Menções a pessoas na resposta valem como as de pessoa (push, não-lidas, seguir a Thread);
    // a de Agente fica registrada, mas não o faz responder.
    const delivered = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: executions.state })
        .from(executions)
        .where(eq(executions.id, job.id))
        .for("update");
      if (row?.state !== "running") return undefined;
      await tx.insert(messages).values({
        id: reply.id,
        channelId: job.channelId,
        authorAgentId: agent.id,
        originMessageId: job.originMessageId,
        threadRootId,
        body: text.trim(),
        createdAt: reply.createdAt,
      });
      const mentions = await recordMentions(tx, reply.id, channel, text.trim());
      const followed = threadRootId
        ? await recordFollows(tx, {
            conversationId: job.channelId,
            threadRootId,
            authorMemberId: null,
            mentions,
            createdAt: reply.createdAt,
          })
        : [];
      return (await close(job, "done", { replyMessageId: reply.id }, tx)) ? { followed } : undefined;
    });
    if (!delivered) return;
    // Todos recebem a resposta; o autor da origem, a cópia com o porquê ligado à Conta dele.
    const replyDto = (await findMessage(db, reply.id))!;
    const [{ authorId } = { authorId: null }] = await db
      .select({ authorId: messages.authorMemberId })
      .from(messages)
      .where(eq(messages.id, job.originMessageId));
    if (authorId && reaches(audience, authorId)) {
      events.publish(without(audience, authorId), { type: "message.created", message: replyDto });
      const forAuthor = (await findMessage(db, reply.id, authorId))!;
      events.publish({ members: [authorId] }, { type: "message.created", message: forAuthor });
    } else {
      events.publish(audience, { type: "message.created", message: replyDto });
    }
    for (const { memberId, thread } of delivered.followed) {
      events.publish({ members: [memberId] }, { type: "thread.followed", thread });
    }
    await reading.messageCreated(replyDto);
    push.messageCreated(replyDto, channel);
    await publish(job.id);
  }

  /**
   * Cancela, em qualquer passo, as execuções abertas que atendem a `where`: a que está rodando é
   * interrompida. `reason` nulo é o cancelamento por quem escreveu; com motivo, foi o Shearim.
   */
  async function cancelWhere(where: SQL, reason: string | null): Promise<ExecutionDto[]> {
    const now = clock.now();
    // A execução esperando aprovação e o Pedido dela juntos: uma decisão que chegou antes ganha.
    const { cancelled, approvals } = await db.transaction(async (tx) => {
      const cancelled = await tx
        .update(executions)
        .set({ ...leaving("cancelled", now), reason, authorReason: null, held: false, heldUntil: null })
        .where(and(where, inArray(executions.state, [...OPEN_STATES])))
        .returning({ id: executions.id });
      const approvals = cancelled.length
        ? await tx
            .update(approvalRequests)
            .set({ state: "cancelled", decidedAt: now })
            .where(
              and(
                inArray(
                  approvalRequests.executionId,
                  cancelled.map((c) => c.id),
                ),
                eq(approvalRequests.state, "pending"),
              ),
            )
            .returning({ id: approvalRequests.id })
        : [];
      return { cancelled, approvals };
    });
    for (const { id } of cancelled) {
      waiting.delete(id);
      running.get(id)?.abort("cancelled" satisfies Interruption);
      await publish(id);
    }
    for (const { id } of approvals) await publishApproval(db, events, id, "approval.updated");
    if (cancelled.length === 0) return [];
    // A que saiu da fila pode ter sido a que segurava a série.
    wake();
    const done = await views(
      inArray(
        executions.id,
        cancelled.map((c) => c.id),
      ),
    );
    return done.map((v) => v.author);
  }

  /**
   * Roda um pedido sob a vigia, com o "tentando de novo (n/m)" à vista. Devolve o texto inteiro e
   * o evento que encerrou, ou nada quando a execução foi interrompida (a vigia já registrou a falha).
   */
  async function complete(job: Row, controller: AbortController, request: ModelRequest, spent: Spent) {
    const { signal } = controller;
    const step = (job.step as ExecutionStep | null) ?? "writing";
    const watchdog = stallWatch(clock, STALL_MS, () => controller.abort("stalled" satisfies Interruption));
    watchdogs.set(job.id, watchdog);
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
    /** "parou no limite de Ferramentas": a última chamada, sem Ferramentas, vem agora. */
    async function showToolLimit() {
      await db
        .update(executions)
        .set({ toolLimit: true })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")));
      await publish(job.id);
    }
    try {
      for await (const event of model.run(request, signal)) {
        if (isProgress(event)) watchdog.reset();
        if (event.type === "api_retry") await showApiRetry(event);
        else if ((event.type === "text" || event.type === "thinking") && apiRetrying) await showApiRetry(null);
        if (event.type === "text") text += event.text;
        else if (event.type === "tool_limit") await showToolLimit();
        else if (event.type === "usage")
          spent.usage = { model: event.model, usage: event.usage, costUsd: event.costUsd };
        else if (event.type === "done") {
          end = event;
          spent.usage = { model: request.model, usage: event.usage, costUsd: event.costUsd };
          spent.succeeded = true;
        } else if (event.type !== "thinking" && event.type !== "api_retry") end = event;
      }
    } finally {
      watchdog.cancel();
      watchdogs.delete(job.id);
    }
    if (signal.aborted) {
      // Na vigia, é falha. No cancelamento, já está gravado. No reinício, continua "em andamento"
      // até a próxima subida.
      if ((signal.reason as Interruption) === "stalled") await fail(job, STALL_REASON[step]);
      return undefined;
    }
    return { text, end };
  }

  /** A vigia de cada execução que está rodando: a Ferramenta a pausa enquanto roda. */
  const watchdogs = new Map<string, StallWatch>();

  /**
   * As Ferramentas da execução, pela porta de Ferramentas. Enquanto uma roda, o passo é o dela
   * ("listando os Agentes") e vale o prazo dela, não o da vigia; o começo e o fim contam como
   * progresso. A porta grava o uso; aqui ficam o passo e o anúncio do Andamento.
   */
  function toolsOf(job: Row) {
    const step = async (next: ExecutionStep) => {
      await db
        .update(executions)
        .set({ step: next, since: clock.now() })
        .where(and(eq(executions.id, job.id), eq(executions.state, "running")));
      await publish(job.id);
    };
    return deps.tools.forExecution(
      {
        executionId: job.id,
        attempt: job.attempt,
        agentId: job.agentId,
        channelId: job.channelId,
        originMessageId: job.originMessageId,
      },
      {
        async started() {
          watchdogs.get(job.id)?.pause();
          await step("tool");
        },
        async finished() {
          watchdogs.get(job.id)?.resume();
          await step("writing");
        },
        async approvalRequested({ tool, action, summary }) {
          // O Pedido e o fim da execução juntos: um cancelamento que chegou antes ganha, e nada fica.
          const created = await db.transaction(async (tx) => {
            if (!(await transition(job.id, "awaiting_approval", {}, { tx }))) return undefined;
            return insertApproval(tx, {
              executionId: job.id,
              channelId: job.channelId,
              originMessageId: job.originMessageId,
              agentId: job.agentId,
              tool: tool.id,
              toolTitle: tool.title,
              action,
              summary,
              now: clock.now(),
              ttlMs: deps.approvalTtlMs,
            });
          });
          if (!created) return false;
          const { id, expiresAt } = created;
          armExpiry(expiresAt);
          // Encerra pelo caminho do cancelamento, com o motivo próprio: o texto parcial é descartado.
          running.get(job.id)?.abort("approval" satisfies Interruption);
          await publish(job.id);
          push.approvalRequested(await publishApproval(db, events, id, "approval.created"));
          return true;
        },
      },
    );
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
  async function route(job: Row, payer: Choice, controller: AbortController, articuladora: Agent) {
    let routing: Awaited<ReturnType<typeof buildRouting>> | undefined;
    const result = await byPayer(job, payer, controller, async (payer) => {
      routing = await buildRouting(db, articuladora, job.originMessageId, deps.tools.grantsOf);
      const { team: _, ...request } = routing;
      return { model: ROUTING_MODEL, ...request, output: { schema: ROUTING_SCHEMA }, payer };
    });
    if (!result) return;
    const { team } = routing!;
    const { text, end } = result;
    if (end?.type !== "done") return fail(job, failureReason(end), failureOpts(end));
    const decided = parseDecision(text, team);
    if (!decided) return fail(job, "a Articuladora não devolveu um Desfecho válido");

    // O Desfecho, o fim do roteamento e as respostas na fila juntos: um cancelamento que chegou
    // antes ganha, e a resposta que esperava este roteamento (Ordem) já vê quem vem antes dela.
    const origin = { id: job.originMessageId, channelId: job.channelId };
    const next =
      decided.decision === "reply"
        ? [{ agent: articuladora, kind: "reply" as const }]
        : decided.delegates.map((d) => ({ agent: { id: d.agentId }, kind: "delegated" as const }));
    const delivered = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: executions.state })
        .from(executions)
        .where(eq(executions.id, job.id))
        .for("update");
      if (row?.state !== "running") return undefined;
      await close(job, "done", {}, tx);
      const outcome = await recordOutcome(tx, origin, decided, clock.now());
      return { outcome, queued: await insertRows(tx, origin, next, job.arrivedAt) };
    });
    if (!delivered) return;
    const { audience } = await conversationOf(job.channelId);
    events.publish(audience, { type: "outcome.created", outcome: delivered.outcome });
    await publish(job.id);
    for (const id of delivered.queued) await publish(id);
    wake();
  }

  /** Grava as chamadas na fila, chegando em `arrivedAt`; devolve os ids, na ordem. */
  async function insertRows(
    tx: Db | Tx,
    origin: { id: string; channelId: string },
    calls: readonly { agent: Pick<Agent, "id">; kind: ExecutionKind }[],
    arrivedAt: Date,
  ) {
    if (calls.length === 0) return [];
    const now = clock.now();
    const [message] = await tx
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
    await tx.insert(executions).values(rows);
    return rows.map((r) => r.id);
  }

  /** Anuncia as que acabaram de entrar na fila e acorda o trabalhador (ele as pega mesmo se o anúncio falhar). */
  async function queued(ids: readonly string[]) {
    if (ids.length === 0) return;
    wake();
    for (const id of ids) await publish(id);
  }

  // ---------- o trabalhador ----------

  let loop: Promise<void> | undefined;
  let stopping = false;
  let pending = false;
  let wakeUp: (() => void) | undefined;
  let alarm: (() => void) | undefined;
  /** As que estão rodando agora, cada uma com o seu `AbortController` (vigia, cancelamento, parada). */
  const running = new Map<string, AbortController>();
  const inflight = new Set<Promise<void>>();
  /** O que está ocupado de cada teto. */
  const used = { key: 0, processes: 0, accounts: new Map<string, number>() };

  function wake() {
    pending = true;
    wakeUp?.();
  }

  /** Espera `ms` no relógio, ou menos, se algo acordar o trabalhador (trabalho novo, parada). */
  async function pause(ms: number) {
    await new Promise<void>((resolve) => {
      const cancel = clock.after(ms, resolve);
      wakeUp = () => {
        cancel();
        resolve();
      };
    });
    wakeUp = undefined;
  }

  async function idle() {
    if (pending || stopping) return;
    await new Promise<void>((resolve) => {
      wakeUp = resolve;
    });
    wakeUp = undefined;
  }

  /**
   * Arma o despertador para a próxima nova tentativa (ou espera da fila) depois de `now`; devolve
   * `true` se ela já venceu enquanto o trabalhador olhava a fila.
   */
  async function armRetryAlarm(now: Date) {
    alarm?.();
    alarm = undefined;
    const at = await nextRetryAt(now);
    if (!at) return false;
    const wait = at.getTime() - clock.now().getTime();
    if (wait <= 0) return true;
    alarm = clock.after(wait, wake);
    return false;
  }

  /** Os tetos que uma execução ocupa, pelo pagador: "Agentes não agem" e a fila não ocupam nada. */
  function slotsOf(job: Row, payer: Choice): Slots {
    if (payer.kind === "key") return { key: true };
    if (payer.kind !== "account") return {};
    // O roteamento fica fora da conta de respostas da Conta, mas é um processo no host.
    return job.kind === "route" ? { process: true } : { process: true, account: payer.memberId };
  }

  function fits(slots: Slots) {
    if (slots.key && used.key >= limits.key) return false;
    if (slots.process && used.processes >= limits.processes) return false;
    if (slots.account && (used.accounts.get(slots.account) ?? 0) >= limits.perAccount) return false;
    return true;
  }

  function occupy(slots: Slots, delta: 1 | -1) {
    if (slots.key) used.key += delta;
    if (slots.process) used.processes += delta;
    if (slots.account) {
      const n = (used.accounts.get(slots.account) ?? 0) + delta;
      if (n > 0) used.accounts.set(slots.account, n);
      else used.accounts.delete(slots.account);
    }
  }

  /** Roda uma execução ao lado das outras; ao terminar, solta o lugar e acorda o trabalhador. */
  function launch(job: Row, agent: Agent, payer: Choice, slots: Slots) {
    const controller = new AbortController();
    running.set(job.id, controller);
    occupy(slots, 1);
    const task = (async () => {
      try {
        await run(job, agent, payer, controller);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("shearim: execução falhou", err);
          await fail(job, "erro inesperado no Shearim").catch(() => {});
        }
      } finally {
        running.delete(job.id);
        occupy(slots, -1);
        wake();
      }
    })();
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }

  /**
   * Uma passada pela fila: põe para rodar, na ordem da Prioridade, cada uma que está na vez e cabe
   * nos tetos do seu pagador. O resto fica "esperando a vez".
   */
  async function schedule(now: Date) {
    for (const candidate of await candidates(now)) {
      if (stopping) return;
      const [agent] = await db.select().from(agents).where(eq(agents.id, candidate.agentId));
      const payer = await choosePayer(candidate, agent!);
      const slots = slotsOf(candidate, payer);
      if (!fits(slots)) continue;
      const job = await claim(candidate, now);
      if (!job) continue;
      waiting.delete(job.id);
      launch(job, agent!, payer, slots);
    }
    await markWaiting(now);
  }

  /** Anuncia quem passou a esperar a vez (e quem deixou de esperar sem mudar de estado). */
  async function markWaiting(now: Date) {
    const ready = await db.select({ id: executions.id }).from(executions).where(readyAt(now));
    const still = new Set(ready.map((r) => r.id));
    for (const id of still) {
      if (waiting.has(id)) continue;
      waiting.add(id);
      await publish(id);
    }
    for (const id of [...waiting]) {
      if (still.has(id)) continue;
      waiting.delete(id);
      await publish(id);
    }
  }

  async function work() {
    await recover();
    while (!stopping) {
      pending = false;
      const now = clock.now();
      try {
        await schedule(now);
        if (await armRetryAlarm(now)) continue;
      } catch (err) {
        if (stopping) break;
        console.error("shearim: a fila de execuções falhou ao pegar trabalho", err);
        await pause(1_000);
        continue;
      }
      await idle();
    }
    alarm?.();
    alarm = undefined;
    // Parar é esperar o que estava rodando sair (no `stop`, já interrompido).
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  async function reconsider(memberId?: string) {
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
  }

  /**
   * A virada do mês (0h UTC do dia 1): o orçamento de todo Agente recomeça, e quem espera na fila
   * por quem pague decide de novo. O prazo é olhado ao menos uma vez por dia (o `setTimeout` não
   * espera um mês).
   */
  let monthTurn: (() => void) | undefined;
  function watchMonthTurn() {
    let month = monthOf(clock.now());
    const arm = () => {
      const now = clock.now();
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      monthTurn = clock.after(Math.min(next - now.getTime(), DAY_MS), () => {
        const current = monthOf(clock.now());
        if (current !== month) {
          month = current;
          void reconsider().catch((err) => console.error("shearim: a fila falhou ao virar o mês", err));
        }
        arm();
      });
    };
    arm();
  }

  /**
   * A expiração dos Pedidos de aprovação (ADR 0011): um alarme no relógio para o próximo pendente
   * a vencer. Vencido, o Pedido passa a expirado e a execução que o esperava termina em "a
   * aprovação expirou", sem continuação. Ao subir, expira o que venceu com o servidor parado.
   */
  let expiryAlarm: { at: number; cancel: () => void } | undefined;
  function armExpiry(at: Date) {
    if (stopping || (expiryAlarm && expiryAlarm.at <= at.getTime())) return;
    expiryAlarm?.cancel();
    const cancel = clock.after(Math.max(0, at.getTime() - clock.now().getTime()), () => {
      expiryAlarm = undefined;
      void expireOrRetry();
    });
    expiryAlarm = { at: at.getTime(), cancel };
  }

  /**
   * Expira o que venceu; se falhar no meio (o próximo alarme não chegou a ser armado), tenta de novo
   * em `EXPIRY_RETRY_MS`: nenhum Pedido fica pendente depois do prazo.
   */
  async function expireOrRetry() {
    try {
      await expireApprovals();
    } catch (err) {
      console.error("shearim: a expiração dos Pedidos falhou; tenta de novo em 1 min", err);
      armExpiry(new Date(clock.now().getTime() + EXPIRY_RETRY_MS));
    }
  }

  async function expireApprovals() {
    const now = clock.now();
    // O Pedido e o fim da execução juntos: uma decisão que chegou antes ganha (só sai o pendente).
    const expired = await db.transaction(async (tx) => {
      const rows = await tx
        .update(approvalRequests)
        .set({ state: "expired", decidedAt: now })
        .where(and(eq(approvalRequests.state, "pending"), lte(approvalRequests.expiresAt, now)))
        .returning({ id: approvalRequests.id, executionId: approvalRequests.executionId });
      if (rows.length > 0) {
        await tx
          .update(executions)
          .set({ ...leaving("cancelled", now), reason: APPROVAL_EXPIRED_REASON, authorReason: null })
          .where(
            and(
              inArray(
                executions.id,
                rows.map((r) => r.executionId),
              ),
              eq(executions.state, "awaiting_approval"),
            ),
          );
      }
      return rows;
    });
    for (const { id, executionId } of expired) {
      await publish(executionId);
      await publishApproval(db, events, id, "approval.updated");
    }
    const [next] = await db
      .select({ at: min(approvalRequests.expiresAt) })
      .from(approvalRequests)
      .where(eq(approvalRequests.state, "pending"));
    if (next?.at) armExpiry(new Date(next.at));
  }

  async function continueAfter(executionId: string, approvalRequestId: string) {
    const ids = await db.transaction(async (tx) => {
      const [waited] = await tx.select().from(executions).where(eq(executions.id, executionId)).for("update");
      if (!waited || !(await transition(waited.id, "done", {}, { from: "awaiting_approval", tx }))) return [];
      const id = crypto.randomUUID();
      await tx.insert(executions).values({
        id,
        kind: waited.kind,
        channelId: waited.channelId,
        originMessageId: waited.originMessageId,
        threadRootId: waited.threadRootId,
        agentId: waited.agentId,
        state: "queued",
        since: clock.now(),
        arrivedAt: waited.arrivedAt,
        approvalRequestId,
      });
      return [waited.id, id];
    });
    for (const id of ids) await publish(id);
    wake();
  }

  async function stop() {
    expiryAlarm?.cancel();
    expiryAlarm = undefined;
    monthTurn?.();
    monthTurn = undefined;
    stopping = true;
    for (const controller of running.values()) controller.abort("shutdown" satisfies Interruption);
    wakeUp?.();
    await loop;
    loop = undefined;
  }

  return {
    enqueue: (tx, origin, calls) => insertRows(tx, origin, calls, clock.now()),
    queued,

    continueAfter,

    openIn: async (channelId, viewerId) =>
      (await views(and(eq(executions.channelId, channelId), ne(executions.state, "done")))).map((v) =>
        v.authorId === viewerId ? v.author : v.everyone,
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
      const queued = await transition(
        executionId,
        "queued",
        { attempt: 0, payer: null, reason: null, authorReason: null, finishedAt: null },
        { from: "failed" },
      );
      if (!queued) return undefined;
      const dto = await publish(executionId);
      wake();
      return dto;
    },

    reconsider,

    start() {
      if (loop) return;
      stopping = false;
      watchMonthTurn();
      void expireOrRetry();
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
 * O que toda mudança de estado zera: o passo, o "tentando de novo (n/m)" e, fora de `retrying`,
 * a hora da nova tentativa; `since` recomeça. Quem termina ganha `finishedAt`.
 */
function leaving(state: ExecutionState, now: Date) {
  return {
    state,
    step: null,
    since: now,
    apiRetryAttempt: null,
    apiRetryMax: null,
    ...(state === "retrying" ? {} : { retryAt: null }),
    ...(FINAL_STATES.includes(state) ? { finishedAt: now } : {}),
  };
}
const FINAL_STATES: readonly ExecutionState[] = ["done", "failed", "not_acting", "cancelled"];

/** Quem paga uma execução, pela tabela da Spec: um pagador, "Agentes não agem" ou a fila. */
type Choice = Payer | { kind: "none"; reason: string } | { kind: "hold"; until: Date | null };
/**
 * O que a API informou que a chamada gastou até agora (o gasto na Chave conta mesmo sem o fim) e
 * se ela chegou ao `done`.
 */
type Spent = {
  startedAt: Date;
  usage?: { model: string; usage: ModelUsage; costUsd: number };
  succeeded?: boolean;
};
/** Os tetos que uma execução ocupa enquanto roda. */
type Slots = { key?: true; process?: true; account?: string };

/**
 * Pronta para sair agora: na fila (sem esperar quem pague, ou com a espera vencida) ou com a nova
 * tentativa automática vencida.
 */
function readyAt(now: Date) {
  return or(
    and(eq(executions.state, "queued"), or(eq(executions.held, false), lte(executions.heldUntil, now))),
    and(eq(executions.state, "retrying"), lte(executions.retryAt, now)),
  )!;
}

const other = alias(executions, "other");

/**
 * A ordem de chegada: a hora de chegada (que fica com quem troca de fila) e, no empate, a ordem
 * das mensagens de origem (a resposta que um roteamento põe na fila chega com a hora dele, que
 * pode empatar com a de uma mensagem seguinte) e a da fila.
 */
function arrivalOrder(e: Record<"arrivedAt" | "originMessageId" | "seq", AnyColumn>): SQL[] {
  const originSeq = sql`(select ${messages.seq} from ${messages} where ${messages.id} = ${e.originMessageId})`;
  return [sql`${e.arrivedAt}`, originSeq, sql`${e.seq}`];
}

/**
 * Na vez da sua série (Spec, módulo 6, Ordem). O roteamento não é resposta e sai sempre. Uma
 * resposta espera, na mesma conversa (`channel_id`, `thread_root_id`: o fluxo principal e cada
 * Thread à parte):
 * - a do mesmo Agente que está rodando, ou que chegou antes e ainda vai sair;
 * - o roteamento de uma mensagem anterior que ainda vai sair ou está rodando, porque ele pode
 *   pôr na fila uma resposta que chegou antes dela.
 * Quem espera a própria Conta (`held`) não segura ninguém; a nova tentativa marcada, sim.
 */
function onTurn(now: Date) {
  const stillToGo = or(
    and(eq(other.state, "queued"), or(eq(other.held, false), lte(other.heldUntil, now))),
    eq(other.state, "retrying"),
  );
  const earlier = sql`(${sql.join(arrivalOrder(other), sql`, `)}) < (${sql.join(arrivalOrder(executions), sql`, `)})`;
  const ahead = and(
    ne(other.id, executions.id),
    eq(other.channelId, executions.channelId),
    sql`${other.threadRootId} is not distinct from ${executions.threadRootId}`,
    or(
      and(
        ne(other.kind, "route"),
        eq(other.agentId, executions.agentId),
        or(eq(other.state, "running"), and(stillToGo, earlier)),
      ),
      and(eq(other.kind, "route"), earlier, or(eq(other.state, "running"), stillToGo)),
    ),
  );
  return or(
    eq(executions.kind, "route"),
    sql`not exists (select 1 from ${executions} as ${sql.identifier("other")} where ${ahead})`,
  )!;
}

/** Contam como progresso para a vigia: texto, pensamento e nova tentativa da API (nunca `ping`). */
function isProgress(event: ModelEvent) {
  return (
    event.type === "text" || event.type === "thinking" || event.type === "tool_limit" || event.type === "api_retry"
  );
}

/**
 * Um prazo que recomeça a cada progresso e chama `onStall` se vencer. `pause` o suspende (uma
 * Ferramenta rodando, com o prazo dela) até `resume`, que recomeça a contagem.
 */
function stallWatch(clock: Clock, ms: number, onStall: () => void) {
  let cancel = clock.after(ms, onStall);
  let paused = false;
  const arm = () => {
    cancel();
    cancel = clock.after(ms, onStall);
  };
  return {
    reset() {
      if (!paused) arm();
    },
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      paused = false;
      arm();
    },
    cancel: () => cancel(),
  };
}
type StallWatch = ReturnType<typeof stallWatch>;

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
  waiting: ReadonlySet<string>,
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
  const tools = await toolCallsOf(
    db,
    rows.map(({ e }) => ({ id: e.id, attempt: e.attempt })),
  );
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
      waitingTurn: (e.state === "queued" || e.state === "retrying") && waiting.has(e.id),
      yourAccount: null,
      replyMessageId: e.replyMessageId,
      tools: withoutConnect(tools.get(e.id) ?? []),
      toolLimit: e.toolLimit,
    };
    // A Conta explica o que se vê quando outra coisa paga, espera ou não age no lugar dela.
    const explains = everyone.held || everyone.payer === "key" || e.state === "not_acting";
    const author: ExecutionDto = {
      ...everyone,
      reason: reason && (e.authorReason ?? reason),
      yourAccount: explains ? yourAccount(accountStanding(account, now)) : null,
      // Só o autor vê o atalho "Ligar <Conector>" de uma Ferramenta indisponível por falta da credencial dele.
      tools: tools.get(e.id) ?? [],
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
