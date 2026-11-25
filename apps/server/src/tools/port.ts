import type { AgentToolSummaryDto, MessageDto, ToolAccess, ToolCallDto, ToolOrigin } from "@shearim/contracts";
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

/** O teto de turnos de Ferramenta de uma resposta que o `.env` ajusta (`SHEARIM_TOOL_MAX_TURNS`). */
export function toolMaxTurnsFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.SHEARIM_TOOL_MAX_TURNS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`SHEARIM_TOOL_MAX_TURNS=${raw} não é um número inteiro maior que zero.`);
  return n;
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

/** O que uma Ferramenta recebe para rodar: o banco e a execução (de onde sai o alcance). */
export interface ToolContext {
  db: Db;
  run: ToolRun;
}

/** Postar uma mensagem como o Agente (o que a escrita aprovada faz no Workspace). */
export type PostAsAgent = (message: {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  body: string;
}) => Promise<MessageDto>;

/** O que a ação aprovada recebe: o contexto e o que ela pode fazer no Workspace. */
export interface WriteContext extends ToolContext {
  post: PostAsAgent;
}

interface ToolBase {
  /** O id estável, que é também o nome que o modelo recebe (`^[a-z0-9_]+$`). */
  id: string;
  /** O nome em pt-BR ("listar Agentes"). */
  title: string;
  /** O passo no Andamento enquanto roda ("listando os Agentes"). */
  label: string;
  /** Para o modelo e para o Admin. */
  description: string;
  origin: ToolOrigin;
  /** O JSON Schema da entrada. */
  inputSchema: Record<string, unknown>;
  /** O prazo desta Ferramenta (padrão: o da Instalação). */
  timeoutMs?: number;
}

/** Uma Ferramenta que só lê: roda na hora e o resultado volta ao modelo. */
export interface ReadTool extends ToolBase {
  access: "read";
  /** Roda e devolve o resultado como texto; falha com `ToolFailure`. Deve largar quando `signal` abortar. */
  run(ctx: ToolContext, input: unknown, signal: AbortSignal): Promise<string>;
}

/**
 * Uma Ferramenta que escreve (ADR 0011): não roda durante a resposta. A porta confere a entrada e o
 * alcance (`prepare`), cria o Pedido de aprovação com a ação exata e encerra a execução; o Shearim
 * só executa a ação (`perform`) quando o autor aprova.
 */
export interface WriteTool extends ToolBase {
  access: "write";
  /**
   * Confere a entrada e o alcance e resolve a ação exata (o que vai ser guardado e executado) e o
   * resumo em pt-BR que o autor aprova. Falha com `ToolFailure`: vira falha da Ferramenta, sem Pedido.
   */
  prepare(
    ctx: ToolContext,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ action: Record<string, unknown>; summary: string }>;
  /** Executa a ação aprovada, conferindo o alcance de novo; devolve o resultado ou falha com `ToolFailure`. */
  perform(ctx: WriteContext, action: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** Uma Ferramenta do catálogo: o que o Admin concede e o que a porta executa. */
export type ToolDefinition = ReadTool | WriteTool;

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
  /**
   * Uma escrita passou na conferência: cria o Pedido de aprovação com a ação exata e encerra a
   * execução em "esperando aprovação" (ADR 0011). Devolve se criou (a execução pode já ter sido
   * cancelada ou interrompida).
   */
  approvalRequested(request: { tool: WriteTool; action: Record<string, unknown>; summary: string }): Promise<boolean>;
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

  /** Roda `work` com o prazo da definição; devolve o que ele devolveu ou o motivo da falha. */
  async function execute<T>(def: ToolDefinition, work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
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
    const ran = work(own.signal).then(
      (value) => ({ ok: true as const, value }),
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

    /**
     * As Ferramentas concedidas a cada Agente (todos, ou só `agentIds`), na ordem do catálogo: o que
     * a lista de Agentes mostra a todo Membro e o que a Articuladora sabe ao rotear. Agente sem
     * concessão fica de fora do mapa.
     */
    async grantsOf(agentIds?: readonly string[]): Promise<Map<string, AgentToolSummaryDto[]>> {
      const out = new Map<string, AgentToolSummaryDto[]>();
      if (agentIds && agentIds.length === 0) return out;
      const rows = await db
        .select()
        .from(agentTools)
        .where(agentIds ? inArray(agentTools.agentId, [...agentIds]) : undefined);
      for (const def of definitions) {
        for (const row of rows) {
          if (row.tool !== def.id) continue;
          const list = out.get(row.agentId) ?? [];
          list.push({ id: def.id, title: def.title, origin: def.origin });
          out.set(row.agentId, list);
        }
      }
      return out;
    },

    exists: (toolId: string) => byId.has(toolId),

    /**
     * Executa a ação de um Pedido aprovado (ADR 0011), sem passar pelo modelo: a Ferramenta ainda
     * tem de estar concedida ao Agente, e ela confere o alcance de novo. Nunca lança.
     */
    async perform(
      tool: string,
      run: ToolRun,
      action: Record<string, unknown>,
      post: PostAsAgent,
    ): Promise<{ ok: true; result: string } | { ok: false; reason: string }> {
      const def = (await grantedTo(run.agentId)).find((d) => d.id === tool);
      if (def?.access !== "write") return { ok: false, reason: "a Ferramenta não está mais disponível para o Agente" };
      const outcome = await execute(
        def,
        (s) => def.perform({ db, run, post }, action, s),
        new AbortController().signal,
      );
      return outcome.ok ? { ok: true, result: outcome.value } : outcome;
    },

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
          // A escrita não roda aqui: só a conferência e a ação exata, que vira o Pedido de aprovação.
          const outcome =
            def.access === "read"
              ? await execute(def, (s) => def.run({ db, run }, input, s), signal)
              : await execute(def, (s) => def.prepare({ db, run }, input, s), signal);
          await db
            .update(executionToolCalls)
            .set({
              state: outcome.ok ? "done" : "failed",
              reason: outcome.ok ? null : outcome.reason,
              finishedAt: clock.now(),
            })
            .where(eq(executionToolCalls.id, id));
          await observer.finished();
          if (!outcome.ok) return { content: `A Ferramenta ${def.title} falhou: ${outcome.reason}.`, isError: true };
          if (def.access === "read") return { content: outcome.value as string, isError: false };
          const prepared = outcome.value as { action: Record<string, unknown>; summary: string };
          // A execução termina aqui (o `signal` aborta): o que volta ao modelo não chega a ser lido.
          return (await observer.approvalRequested({ tool: def, ...prepared }))
            ? { content: `Pedido de aprovação criado: ${prepared.summary}`, isError: false }
            : { content: "A resposta foi interrompida.", isError: true };
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
