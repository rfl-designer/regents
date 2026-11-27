import type {
  AgentToolSummaryDto,
  MessageDto,
  ToolAccess,
  ToolCallDto,
  ToolConnectorDto,
  ToolOrigin,
} from "@regents/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { lockLiveAgent } from "../agents";
import type { Clock } from "../clock";
import { type Config, positiveInt } from "../config";
import { type Db, schema } from "../db/client";

const { agentTools, executionToolCalls } = schema;

/** O prazo de uma chamada de Ferramenta quando ela não tem o seu (ADR 0003: um prazo por tool). */
export const TOOL_TIMEOUT_MS = 60_000;

/** O prazo padrão das Ferramentas que o `.env` ajusta (`REGENTS_TOOL_TIMEOUT_S`, em segundos). */
export function toolTimeoutFromConfig(config: Config): number | undefined {
  const n = positiveInt(config, "TOOL_TIMEOUT_S");
  return n === undefined ? undefined : n * 1000;
}

/** O teto de turnos de Ferramenta de uma resposta que o `.env` ajusta (`REGENTS_TOOL_MAX_TURNS`). */
export function toolMaxTurnsFromConfig(config: Config): number | undefined {
  return positiveInt(config, "TOOL_MAX_TURNS");
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
  constructor(
    readonly reason: string,
    /** Falta a credencial do autor num Conector: o atalho "Ligar <Conector>", que só o autor vê. */
    readonly connect?: { connectorId: string; name: string },
  ) {
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
  /**
   * O rótulo desta chamada, quando depende dela (a credencial do autor num Conector: "usando
   * buscar cliente no CRM de Ana"; a entrada: "buscando em #produto", "lendo a issue 214 de
   * time/site"), e o que o Andamento mostra a todos se terminar bem ("usou o CRM de Ana"). Sem ele,
   * vale `label`. O Andamento é visto por todos da conversa: só nomeie o que está no alcance.
   */
  describe?(ctx: ToolContext, input: unknown): Promise<{ label?: string; used?: string }>;
  /** Para o modelo e para o Admin. */
  description: string;
  origin: ToolOrigin;
  /** Só nas de um Conector: qual, e de quem é a credencial (a concessão aponta para ele). */
  connector?: ToolConnectorDto;
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

/** O fim da descrição de toda escrita, para o modelo: ela passa por Pedido de aprovação (ADR 0011). */
export const WRITE_NOTE =
  "Antes de sair, quem escreveu a mensagem que você responde aprova ou recusa: a resposta termina aqui e continua depois da decisão.";

/**
 * Uma Ferramenta que escreve (ADR 0011): não roda durante a resposta. A porta confere a entrada e o
 * alcance (`prepare`), cria o Pedido de aprovação com a ação exata e encerra a execução; o Regents
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

/**
 * Uma Ferramenta que roda no próprio cérebro, não na porta (as da web): pela Chave, uma server tool
 * da Messages API; pela Conta, uma tool nativa do Claude Code. A porta só a concede, a lista e grava
 * os passos que o cérebro avisa (`ExecutionTools.track`).
 */
export interface BrainTool extends ToolBase {
  access: "read";
  runsIn: "brain";
}

/** Uma Ferramenta do catálogo: o que o Admin concede e o que a porta executa. */
export type ToolDefinition = ReadTool | WriteTool | BrainTool;

/**
 * Uma Ferramenta que vem sem concessão do Admin ("buscar na Memória", #69): fica fora do catálogo
 * (o Admin não a concede nem a retira) e o Agente a tem quando `presentFor` diz, conferido a cada
 * uso, como a concessão. Só de leitura: nunca gera Pedido de aprovação.
 */
export interface AutomaticTool extends ReadTool {
  /**
   * Se o Agente a tem nesta resposta. Recebe a execução inteira, e não só o Agente: a presença pode
   * depender da conversa ("ler a Wiki" só existe quando uma Wiki alcança a resposta).
   */
  presentFor(db: Db, run: ToolRun): Promise<boolean>;
}

const runsInBrain = (def: ToolDefinition): def is BrainTool => "runsIn" in def;

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
  /**
   * Um uso de Ferramenta que roda no cérebro (as da web): grava o começo com o rótulo ("abrindo
   * exemplo.com"), avisa o Andamento e devolve como terminar (`failure`: o motivo). Vale o prazo da
   * Ferramenta: se o cérebro não avisar o fim a tempo, o uso termina em falha com o motivo.
   */
  track(name: string, label: string): Promise<(failure?: string) => Promise<void>>;
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
  /** O catálogo fixo (padrão: as Ferramentas do Workspace). */
  definitions: readonly ToolDefinition[];
  /**
   * O catálogo que muda (as Ferramentas dos Conectores), lido a cada uso: remover um Conector tira
   * as Ferramentas dele na hora, também de uma resposta em curso.
   */
  extra?: () => Promise<readonly ToolDefinition[]>;
  /** As que vêm sem concessão (`AutomaticTool`), depois das concedidas. */
  automatic?: readonly AutomaticTool[];
  /** O prazo de uma chamada sem prazo próprio (padrão: `TOOL_TIMEOUT_MS`). */
  timeoutMs?: number;
}) {
  const { db, clock, definitions } = deps;
  const defaultTimeout = deps.timeoutMs ?? TOOL_TIMEOUT_MS;

  /** O catálogo de agora: o fixo e o dos Conectores. */
  async function catalog(): Promise<ToolDefinition[]> {
    return [...definitions, ...((await deps.extra?.()) ?? [])];
  }

  async function grantedTo(agentId: string): Promise<ToolDefinition[]> {
    const rows = await db.select({ tool: agentTools.tool }).from(agentTools).where(eq(agentTools.agentId, agentId));
    const granted = new Set(rows.map((r) => r.tool));
    return (await catalog()).filter((d) => granted.has(d.id));
  }

  /** O que o Agente tem agora: as concedidas e as que vêm sem concessão e estão presentes para ele. */
  async function availableTo(run: ToolRun): Promise<ToolDefinition[]> {
    const automatic: ToolDefinition[] = [];
    for (const def of deps.automatic ?? []) if (await def.presentFor(db, run)) automatic.push(def);
    return [...(await grantedTo(run.agentId)), ...automatic];
  }

  /** Roda `work` com o prazo da definição; devolve o que ele devolveu ou o motivo da falha. */
  async function execute<T>(def: ToolDefinition, work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    // Pedida depois da interrupção (o `abort` já passou e não dispara de novo): nem começa.
    if (signal.aborted) return { ok: false as const, reason: "a resposta foi interrompida" };
    const own = new AbortController();
    const abort = () => own.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = def.timeoutMs ?? defaultTimeout;
    let cancelTimer = () => {};
    type Failed = { ok: false; reason: string; connect?: { connectorId: string; name: string }; timedOut?: true };
    const deadline = new Promise<Failed>((resolve) => {
      cancelTimer = clock.after(timeout, () => {
        // Resolve antes de interromper: o motivo é o prazo, não a interrupção que ele causa.
        resolve({ ok: false, reason: `não terminou em ${Math.round(timeout / 1000)} s`, timedOut: true });
        own.abort();
      });
    });
    const interrupted = new Promise<Failed>((resolve) => {
      own.signal.addEventListener("abort", () => resolve({ ok: false, reason: "a resposta foi interrompida" }), {
        once: true,
      });
    });
    const ran = work(own.signal).then(
      (value) => ({ ok: true as const, value }),
      (err) => {
        if (!(err instanceof ToolFailure)) console.error(`regents: a Ferramenta ${def.id} falhou`, err);
        return {
          ok: false as const,
          reason: err instanceof ToolFailure ? err.reason : "erro inesperado na Ferramenta",
          ...(err instanceof ToolFailure && err.connect ? { connect: err.connect } : {}),
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
    catalog,

    /** O catálogo, com a marca de concedida ao Agente (a tela do Agente, só Admin). */
    async forAgent(agentId: string) {
      const granted = new Set((await grantedTo(agentId)).map((d) => d.id));
      return (await catalog()).map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        origin: d.origin,
        access: d.access,
        granted: granted.has(d.id),
        ...(d.connector ? { connector: d.connector } : {}),
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
      for (const def of await catalog()) {
        for (const row of rows) {
          if (row.tool !== def.id) continue;
          const list = out.get(row.agentId) ?? [];
          list.push({
            id: def.id,
            title: def.title,
            origin: def.origin,
            ...(def.connector ? { connector: def.connector } : {}),
          });
          out.set(row.agentId, list);
        }
      }
      return out;
    },

    exists: async (toolId: string) => (await catalog()).some((d) => d.id === toolId),

    /**
     * Executa a ação de um Pedido aprovado (ADR 0011), sem passar pelo modelo: a Ferramenta ainda
     * tem de estar concedida ao Agente, e ela confere o alcance de novo. Nunca lança. A que estoura
     * o prazo pode ter sido feita lá fora: o resultado é incerto (`uncertain`), e o motivo diz onde
     * conferir.
     */
    async perform(
      tool: string,
      run: ToolRun,
      action: Record<string, unknown>,
      post: PostAsAgent,
    ): Promise<{ ok: true; result: string } | { ok: false; reason: string; uncertain?: true }> {
      const def = (await grantedTo(run.agentId)).find((d) => d.id === tool);
      if (def?.access !== "write") return { ok: false, reason: "a Ferramenta não está mais disponível para o Agente" };
      const outcome = await execute(
        def,
        (s) => def.perform({ db, run, post }, action, s),
        new AbortController().signal,
      );
      if (outcome.ok) return { ok: true, result: outcome.value };
      if ("timedOut" in outcome) return { ok: false, reason: uncertainReason(def, outcome.reason), uncertain: true };
      return { ok: false, reason: outcome.reason };
    },

    /**
     * O motivo de uma escrita que pode ter sido feita sem o Regents saber ("o servidor reiniciou
     * durante a ação"): a causa e onde conferir.
     */
    async uncertainReason(tool: string, cause: string) {
      return uncertainReason(
        (await catalog()).find((d) => d.id === tool),
        cause,
      );
    },

    /** Concede a Ferramenta. Devolve `false` se o Agente foi apagado (o DELETE ganhou a corrida). */
    async grant(agentId: string, toolId: string): Promise<boolean> {
      const def = (await catalog()).find((d) => d.id === toolId);
      if (!def) return true;
      return db.transaction(async (tx) => {
        if (!(await lockLiveAgent(tx, agentId))) return false;
        await tx
          .insert(agentTools)
          .values({ agentId, tool: toolId, connectorId: def.connector?.id ?? null, grantedAt: clock.now() })
          .onConflictDoNothing();
        return true;
      });
    },

    async revoke(agentId: string, toolId: string) {
      await db.delete(agentTools).where(and(eq(agentTools.agentId, agentId), eq(agentTools.tool, toolId)));
    },

    /** As Ferramentas de uma execução, com cada uso gravado e avisado a `observer`. */
    forExecution(run: ToolRun, observer: ToolObserver): ExecutionTools {
      /** Grava o começo de um uso e avisa o Andamento. */
      async function begin(def: ToolDefinition, label: string, input?: unknown) {
        const id = crypto.randomUUID();
        const own: { label?: string; used?: string } = def.describe
          ? await def.describe({ db, run }, input).catch(() => ({}))
          : {};
        await db.insert(executionToolCalls).values({
          id,
          executionId: run.executionId,
          attempt: run.attempt,
          tool: def.id,
          title: def.title,
          label: own.label ?? label,
          used: own.used ?? null,
          state: "running",
          startedAt: clock.now(),
        });
        await observer.started();
        return id;
      }
      /** Grava o fim (com o motivo, se falhou, e o atalho "Ligar", se é o caso) e avisa o Andamento. */
      async function end(id: string, failure?: string, connect?: { connectorId: string; name: string }) {
        await db
          .update(executionToolCalls)
          .set({
            state: failure ? "failed" : "done",
            reason: failure ?? null,
            connectConnectorId: connect?.connectorId ?? null,
            connectName: connect?.name ?? null,
            finishedAt: clock.now(),
          })
          .where(eq(executionToolCalls.id, id));
        await observer.finished();
      }

      return {
        async track(name, label) {
          const def = (await catalog()).find((d) => d.id === name);
          if (!def) return async () => {};
          const id = await begin(def, label);
          let ended: Promise<void> | undefined;
          const finish = (failure?: string) => {
            cancelTimer();
            ended ??= end(id, failure);
            return ended;
          };
          const timeout = def.timeoutMs ?? defaultTimeout;
          const cancelTimer = clock.after(timeout, () => {
            void finish(`não terminou em ${Math.round(timeout / 1000)} s`);
          });
          return finish;
        },

        async list() {
          return (await availableTo(run)).map((d) => ({
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
          const def = (await availableTo(run)).find((d) => d.id === name);
          // Uma que vem sem concessão e deixou de estar presente no meio da resposta (a Habilidade
          // desativada, a Memória desligada): a falha fica à vista no Andamento, com o motivo.
          const gone = def ? undefined : deps.automatic?.find((d) => d.id === name);
          if (gone) {
            const reason = "não está mais disponível para você";
            await end(await begin(gone, gone.label, input), reason);
            return { content: `A Ferramenta ${gone.title} falhou: ${reason}.`, isError: true };
          }
          // As da web rodam no cérebro: nunca por aqui (nem pelo endpoint MCP).
          if (!def || runsInBrain(def)) {
            return { content: `A Ferramenta ${name} não está disponível para você.`, isError: true };
          }
          const id = await begin(def, def.label, input);
          // A escrita não roda aqui: só a conferência e a ação exata, que vira o Pedido de aprovação.
          const outcome =
            def.access === "read"
              ? await execute(def, (s) => def.run({ db, run }, input, s), signal)
              : await execute(def, (s) => def.prepare({ db, run }, input, s), signal);
          await end(id, outcome.ok ? undefined : outcome.reason, outcome.ok ? undefined : outcome.connect);
          if (!outcome.ok) return { content: `A Ferramenta ${def.title} falhou: ${outcome.reason}.`, isError: true };
          if (def.access === "read") return { content: markAsData(def.id, outcome.value as string), isError: false };
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

/**
 * O resultado de uma Ferramenta como os dois cérebros o entregam ao modelo: entre marcadores
 * explícitos de dado (Spec #44), com um marcador forjado dentro do conteúdo neutralizado.
 */
export function markAsData(tool: string, content: string) {
  const safe = content.replace(/<(\/?)(resultado_de_ferramenta)/gi, "&lt;$1$2");
  return `<resultado_de_ferramenta nome="${tool}">\n${safe}\n</resultado_de_ferramenta>`;
}

/** "<causa>; pode ter sido feita — confira no GitHub": a escrita de resultado incerto. */
function uncertainReason(def: ToolDefinition | undefined, cause: string) {
  const where =
    def?.origin === "github"
      ? "no GitHub"
      : def?.origin === "connector" && def.connector
        ? `em ${def.connector.name}`
        : "na conversa";
  return `${cause}; pode ter sido feita — confira ${where}`;
}

/**
 * Os usos de Ferramenta de cada execução, na tentativa atual dela, na ordem (para o Andamento).
 * É a cópia do autor: traz o atalho "Ligar <Conector>" (`connect`), que a cópia de todos tira
 * (`withoutConnect`).
 */
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
      ...(row.state === "done" && row.used ? { used: row.used } : {}),
      ...(row.state === "failed" && row.connectConnectorId && row.connectName
        ? { connect: { connectorId: row.connectConnectorId, name: row.connectName } }
        : {}),
    });
    out.set(row.executionId, list);
  }
  return out;
}

/** Os usos como todos os veem: sem o atalho "Ligar <Conector>", que é só do autor. */
export function withoutConnect(calls: readonly ToolCallDto[]): ToolCallDto[] {
  return calls.map(({ connect: _, ...call }) => call);
}
