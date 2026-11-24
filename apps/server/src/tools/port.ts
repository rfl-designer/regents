import type { ToolAccess, ToolCallDto, ToolOrigin } from "@shearim/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";

const { agentTools, executionToolCalls } = schema;

/** O prazo de uma chamada de Ferramenta quando ela não tem o seu (ADR 0003: um prazo por tool). */
export const TOOL_TIMEOUT_MS = 60_000;

/** O prazo padrão das Ferramentas que o `.env` ajusta (`SHEARIM_TOOL_TIMEOUT_S`, em segundos). */
export function toolTimeoutFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.SHEARIM_TOOL_TIMEOUT_S?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`SHEARIM_TOOL_TIMEOUT_S=${raw} não é um número inteiro maior que zero.`);
  return n * 1000;
}

/** A execução em que uma Ferramenta roda: de onde saem o alcance e o catálogo efetivo. */
export interface ToolRun {
  executionId: string;
  attempt: number;
  agentId: string;
  channelId: string;
  originMessageId: string;
}

/**
 * Uma falha de Ferramenta com motivo em pt-BR ("listar Agentes falhou: <motivo>"), que vai ao
 * modelo e ao Andamento. Qualquer outro erro vira "erro inesperado na Ferramenta".
 */
export class ToolFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Uma Ferramenta do catálogo: o que o Admin concede e o que a porta executa. */
export interface ToolDefinition {
  /** O id estável, que é também o nome que o modelo recebe (`^[a-z0-9_]+$`). */
  id: string;
  /** O nome em pt-BR ("listar Agentes"). */
  title: string;
  /** O passo no Andamento enquanto roda ("listando os Agentes"). */
  label: string;
  /** Para o modelo e para o Admin. */
  description: string;
  origin: ToolOrigin;
  access: ToolAccess;
  /** O JSON Schema da entrada. */
  inputSchema: Record<string, unknown>;
  /** O prazo desta Ferramenta (padrão: o da Instalação). */
  timeoutMs?: number;
  /** Roda e devolve o resultado como texto; falha com `ToolFailure`. Deve largar quando `signal` abortar. */
  run(ctx: { db: Db; run: ToolRun }, input: unknown, signal: AbortSignal): Promise<string>;
}

/** Uma Ferramenta como o cérebro a oferece ao modelo. */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: ToolOrigin;
  access: ToolAccess;
}

/** O que volta ao modelo: o resultado como texto, ou o motivo da falha (`isError`). */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** As Ferramentas de uma execução: o que os cérebros veem da porta. */
export interface ExecutionTools {
  /** O catálogo efetivo da execução (vazio: o pedido vai sem Ferramentas). */
  list(): Promise<ToolSpec[]>;
  /**
   * Chama uma Ferramenta. Nunca lança: prazo estourado, erro e Ferramenta que não foi concedida
   * voltam como `isError` com o motivo, e a resposta segue. `signal` é o da execução.
   */
  call(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult>;
}

/** Quem acompanha os usos de Ferramenta de uma execução (o Andamento e a vigia, em `executions.ts`). */
export interface ToolObserver {
  /** Começou (já gravado): o passo da Ferramenta. */
  started(): Promise<void>;
  /** Terminou, bem ou com falha (já gravado). */
  finished(): Promise<void>;
}

/**
 * A porta de Ferramentas (Spec #44): o único lugar onde uma Ferramenta roda. Esconde o catálogo,
 * as concessões e o prazo de cada chamada; grava cada uso para o Andamento (o passo em andamento,
 * a falha com motivo) e avisa quem acompanha a execução.
 */
export function createToolPort(deps: {
  db: Db;
  clock: Clock;
  /** O catálogo (padrão: as Ferramentas do Workspace). */
  definitions: readonly ToolDefinition[];
  /** O prazo de uma chamada sem prazo próprio (padrão: `TOOL_TIMEOUT_MS`). */
  timeoutMs?: number;
}) {
  const { db, clock, definitions } = deps;
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const defaultTimeout = deps.timeoutMs ?? TOOL_TIMEOUT_MS;

  async function grantedTo(agentId: string): Promise<ToolDefinition[]> {
    const rows = await db.select({ tool: agentTools.tool }).from(agentTools).where(eq(agentTools.agentId, agentId));
    const granted = new Set(rows.map((r) => r.tool));
    return definitions.filter((d) => granted.has(d.id));
  }

  /** Roda a definição com o prazo dela; devolve o texto ou o motivo da falha. */
  async function execute(def: ToolDefinition, run: ToolRun, input: unknown, signal: AbortSignal) {
    const own = new AbortController();
    const abort = () => own.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = def.timeoutMs ?? defaultTimeout;
    let cancelTimer = () => {};
    const deadline = new Promise<{ ok: false; reason: string }>((resolve) => {
      cancelTimer = clock.after(timeout, () => {
        // Resolve antes de interromper: o motivo é o prazo, não a interrupção que ele causa.
        resolve({ ok: false, reason: `não terminou em ${Math.round(timeout / 1000)} s` });
        own.abort();
      });
    });
    const interrupted = new Promise<{ ok: false; reason: string }>((resolve) => {
      own.signal.addEventListener("abort", () => resolve({ ok: false, reason: "a resposta foi interrompida" }), {
        once: true,
      });
    });
    const ran = def.run({ db, run }, input, own.signal).then(
      (content) => ({ ok: true as const, content }),
      (err) => {
        if (!(err instanceof ToolFailure)) console.error(`shearim: a Ferramenta ${def.id} falhou`, err);
        return {
          ok: false as const,
          reason: err instanceof ToolFailure ? err.reason : "erro inesperado na Ferramenta",
        };
      },
    );
    try {
      return await Promise.race([ran, deadline, interrupted]);
    } finally {
      cancelTimer();
      signal.removeEventListener("abort", abort);
    }
  }

  return {
    definitions,

    /** As Ferramentas do Workspace, com a marca de concedida ao Agente (a tela do Agente, só Admin). */
    async forAgent(agentId: string) {
      const granted = new Set((await grantedTo(agentId)).map((d) => d.id));
      return definitions.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        origin: d.origin,
        access: d.access,
        granted: granted.has(d.id),
      }));
    },

    exists: (toolId: string) => byId.has(toolId),

    async grant(agentId: string, toolId: string) {
      await db.insert(agentTools).values({ agentId, tool: toolId, grantedAt: clock.now() }).onConflictDoNothing();
    },

    async revoke(agentId: string, toolId: string) {
      await db.delete(agentTools).where(and(eq(agentTools.agentId, agentId), eq(agentTools.tool, toolId)));
    },

    /** As Ferramentas de uma execução, com cada uso gravado e avisado a `observer`. */
    forExecution(run: ToolRun, observer: ToolObserver): ExecutionTools {
      return {
        async list() {
          return (await grantedTo(run.agentId)).map((d) => ({
            name: d.id,
            title: d.title,
            description: d.description,
            inputSchema: d.inputSchema,
            origin: d.origin,
            access: d.access,
          }));
        },

        async call(name, input, signal) {
          // A concessão é conferida na hora: o Admin pode tê-la retirado no meio da resposta.
          const def = (await grantedTo(run.agentId)).find((d) => d.id === name);
          if (!def) return { content: `A Ferramenta ${name} não está disponível para você.`, isError: true };
          const id = crypto.randomUUID();
          await db.insert(executionToolCalls).values({
            id,
            executionId: run.executionId,
            attempt: run.attempt,
            tool: def.id,
            title: def.title,
            label: def.label,
            state: "running",
            startedAt: clock.now(),
          });
          await observer.started();
          const outcome = await execute(def, run, input, signal);
          await db
            .update(executionToolCalls)
            .set({
              state: outcome.ok ? "done" : "failed",
              reason: outcome.ok ? null : outcome.reason,
              finishedAt: clock.now(),
            })
            .where(eq(executionToolCalls.id, id));
          await observer.finished();
          return outcome.ok
            ? { content: outcome.content, isError: false }
            : { content: `A Ferramenta ${def.title} falhou: ${outcome.reason}.`, isError: true };
        },
      };
    },
  };
}

export type ToolPort = ReturnType<typeof createToolPort>;

/** Os usos de Ferramenta de cada execução, na tentativa atual dela, na ordem (para o Andamento). */
export async function toolCallsOf(
  db: Db,
  runs: readonly { id: string; attempt: number }[],
): Promise<Map<string, ToolCallDto[]>> {
  const out = new Map<string, ToolCallDto[]>();
  if (runs.length === 0) return out;
  const attempts = new Map(runs.map((r) => [r.id, r.attempt]));
  const rows = await db
    .select()
    .from(executionToolCalls)
    .where(
      inArray(
        executionToolCalls.executionId,
        runs.map((r) => r.id),
      ),
    )
    .orderBy(asc(executionToolCalls.seq));
  for (const row of rows) {
    if (attempts.get(row.executionId) !== row.attempt) continue;
    const list = out.get(row.executionId) ?? [];
    list.push({
      id: row.id,
      tool: row.tool,
      title: row.title,
      label: row.label,
      state: row.state as ToolCallDto["state"],
      reason: row.reason,
      startedAt: row.startedAt.toISOString(),
    });
    out.set(row.executionId, list);
  }
  return out;
}
