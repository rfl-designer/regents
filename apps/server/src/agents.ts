import {
  AGENT_MODELS,
  type AgentDto,
  type AgentModel,
  type AgentToolSummaryDto,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "@shearim/contracts";
import { and, asc, desc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { withBuiltinText } from "./articuladora";
import type { Clock } from "./clock";
import { type Db, isUuid, schema } from "./db/client";
import type { GitHub } from "./github/connector";
import { budgetOf, type KeyLedger, keySpend, monthOf, parseBudget } from "./key-budget";
import type { Env } from "./members";
import { claimHandle, handleBase } from "./mention-handles";
import type { ToolPort } from "./tools/port";

export type Agent = typeof schema.agents.$inferSelect;
/** O Agente com o identificador de Menção dele (`mention_handles`). */
export type AgentWithHandle = Agent & { handle: string };

const { agents, mentionHandles } = schema;

const NAME_MAX = 40;
/** Uma foto pequena: `data:` URL de imagem com até ~300 KB. */
const PHOTO = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_MAX = 400_000;
const BUDGET_INVALID = "O orçamento mensal é um valor em dólares, zero ou mais (vazio: sem teto).";

/** Agentes: o Admin cria; todo Membro vê o nome, a foto, a descrição, o modelo e as Ferramentas. */
export function agentRoutes(deps: {
  db: Db;
  clock: Clock;
  ledger: KeyLedger;
  /** As Ferramentas concedidas a cada Agente (a porta de Ferramentas). */
  tools: Pick<ToolPort, "grantsOf">;
  /** As listas de repositórios do GitHub de cada Agente (#58): a descrição diz quais ele alcança. */
  github?: Pick<GitHub, "agentRepositories">;
  /** O Admin mudou o orçamento de um Agente: quem espera na fila por quem pague decide de novo. */
  onBudgetChanged?: () => void;
}) {
  const { db, clock, ledger } = deps;
  const toolsOf = async (id: string) => (await deps.tools.grantsOf([id])).get(id) ?? [];
  const reposOf = async (ids?: readonly string[]) => (await deps.github?.agentRepositories(ids)) ?? new Map();
  const routes = new Hono<Env>();

  routes.get("/agents", async (c) => {
    const admin = c.get("member").role === "admin";
    const all = await db
      .select({ ...getTableColumns(agents), handle: mentionHandles.handle })
      .from(agents)
      .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
      .orderBy(desc(agents.builtin), asc(agents.createdAt), asc(agents.name));
    const grants = await deps.tools.grantsOf();
    const repos = await reposOf();
    const of = (id: string) => ({ tools: grants.get(id) ?? [], githubRepositories: repos.get(id) ?? null });
    if (!admin) return c.json(all.map((a) => toAgentDto(a, { admin, ...of(a.id) })));
    const spend = await keySpend(db, monthOf(clock.now()));
    return c.json(all.map((a) => toAgentDto(a, { admin, ...of(a.id), keySpendUsd: spend.get(a.id) ?? 0 })));
  });

  routes.post("/agents", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<Record<keyof CreateAgentInput, unknown>>;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);

    const name = typeof input.name === "string" ? input.name.trim().replace(/^@+/, "").trim() : "";
    if (!name) return invalid("Dê um nome ao Agente.");
    if (name.length > NAME_MAX) return invalid(`O nome do Agente tem no máximo ${NAME_MAX} caracteres.`);
    if (!AGENT_MODELS.includes(input.model as AgentModel)) return invalid("Escolha um dos modelos da lista.");
    const photo = input.photo ?? null;
    if (photo !== null && (typeof photo !== "string" || !PHOTO.test(photo) || photo.length > PHOTO_MAX)) {
      return invalid("A foto é uma imagem PNG, JPEG, WebP ou GIF de até 300 KB.");
    }
    for (const field of ["description", "instructions"] as const) {
      if (input[field] !== undefined && typeof input[field] !== "string")
        return invalid(`O campo ${field} é um texto.`);
    }
    const monthlyBudgetUsd = input.monthlyBudgetUsd === undefined ? null : parseBudget(input.monthlyBudgetUsd);
    if (monthlyBudgetUsd === undefined) return invalid(BUDGET_INVALID);

    // O Agente e o identificador de Menção dele nascem juntos, no espaço de nomes dos Membros.
    const created = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          id: crypto.randomUUID(),
          name,
          photo: photo as string | null,
          description: ((input.description as string | undefined) ?? "").trim(),
          instructions: (input.instructions as string | undefined) ?? "",
          model: input.model as AgentModel,
          monthlyBudgetUsd,
          createdAt: clock.now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!agent) return undefined;
      const handle = await claimHandle(tx, { kind: "agent", id: agent.id }, agentHandleBase(name));
      return { ...agent, handle };
    });
    if (!created) return c.json({ error: "name_taken", message: `Já existe um Agente chamado ${name}.` }, 409);
    return c.json(toAgentDto(created, { admin: true, tools: [], githubRepositories: null, keySpendUsd: 0 }), 201);
  });

  /**
   * O Admin edita um Agente; campo ausente fica. Da Articuladora, tudo menos a descrição e as
   * instruções, que são do Shearim (`403 builtin_locked`): o Admin desliga a Memória dela também. Trocar o nome troca
   * o identificador de Menção, pelo mesmo critério da criação.
   */
  routes.patch("/agents/:id", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    const [current] = isUuid(id) ? await db.select().from(agents).where(eq(agents.id, id)) : [];
    if (!current) return c.json({ error: "not_found" }, 404);
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<Record<keyof UpdateAgentInput, unknown>>;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);

    if (current.builtin && (input.description !== undefined || input.instructions !== undefined)) {
      return c.json(
        { error: "builtin_locked", message: "A descrição e as instruções da Articuladora são do Shearim." },
        403,
      );
    }
    const change: Partial<
      Pick<Agent, "name" | "photo" | "model" | "description" | "instructions" | "monthlyBudgetUsd" | "memoryEnabled">
    > = {};
    if (input.memoryEnabled !== undefined) {
      if (typeof input.memoryEnabled !== "boolean") return invalid("A Memória fica ligada ou desligada.");
      change.memoryEnabled = input.memoryEnabled;
    }
    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim().replace(/^@+/, "").trim() : "";
      if (!name) return invalid("Dê um nome ao Agente.");
      if (name.length > NAME_MAX) return invalid(`O nome do Agente tem no máximo ${NAME_MAX} caracteres.`);
      change.name = name;
    }
    if (input.model !== undefined) {
      if (!AGENT_MODELS.includes(input.model as AgentModel)) return invalid("Escolha um dos modelos da lista.");
      change.model = input.model as AgentModel;
    }
    if (input.photo !== undefined) {
      const photo = input.photo;
      if (photo !== null && (typeof photo !== "string" || !PHOTO.test(photo) || photo.length > PHOTO_MAX)) {
        return invalid("A foto é uma imagem PNG, JPEG, WebP ou GIF de até 300 KB.");
      }
      change.photo = photo as string | null;
    }
    if (input.monthlyBudgetUsd !== undefined) {
      const budget = parseBudget(input.monthlyBudgetUsd);
      if (budget === undefined) return invalid(BUDGET_INVALID);
      change.monthlyBudgetUsd = budget;
    }
    for (const field of ["description", "instructions"] as const) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== "string") return invalid(`O campo ${field} é um texto.`);
      change[field] = field === "description" ? (input[field] as string).trim() : (input[field] as string);
    }

    const updated = await db.transaction(async (tx) => {
      if (change.name !== undefined && change.name !== current.name) {
        const [taken] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(sql`lower(${agents.name}) = lower(${change.name})`, ne(agents.id, current.id)));
        if (taken) return undefined;
      }
      const [row] = Object.keys(change).length
        ? await tx.update(agents).set(change).where(eq(agents.id, current.id)).returning()
        : [current];
      const owner = { kind: "agent", id: current.id } as const;
      if (change.name !== undefined && change.name !== current.name) {
        await tx.delete(mentionHandles).where(eq(mentionHandles.agentId, current.id));
        return { ...row!, handle: await claimHandle(tx, owner, agentHandleBase(change.name)) };
      }
      const [{ handle }] = (await tx
        .select({ handle: mentionHandles.handle })
        .from(mentionHandles)
        .where(eq(mentionHandles.agentId, current.id))) as [{ handle: string }];
      return { ...row!, handle };
    });
    if (!updated) return c.json({ error: "name_taken", message: `Já existe um Agente chamado ${change.name}.` }, 409);
    const budgetChanged = change.monthlyBudgetUsd !== undefined && change.monthlyBudgetUsd !== current.monthlyBudgetUsd;
    const budget = budgetChanged ? await ledger.budgetChanged(updated.id) : await ledger.budgetNow(updated.id);
    if (budgetChanged) deps.onBudgetChanged?.();
    return c.json(
      toAgentDto(updated, {
        admin: true,
        tools: await toolsOf(updated.id),
        githubRepositories: (await reposOf([updated.id])).get(updated.id) ?? null,
        keySpendUsd: budget.keySpendUsd,
      }),
    );
  });

  return routes;
}

/**
 * A base do identificador de um Agente: o nome inteiro, sem espaços ("Sophya Jurídico" →
 * `sophyajuridico`), como a Menção do #20 já casava. A migração `0006` faz o mesmo em SQL
 * para os Agentes de antes do identificador.
 */
export function agentHandleBase(name: string) {
  return handleBase(name.replace(/\s+/g, ""), "agente");
}

/**
 * O Agente como `GET /api/agents` o devolve, com as Ferramentas concedidas a ele. Para o Admin,
 * também as instruções, a lista de repositórios do GitHub e, com `keySpendUsd` (o gasto do mês na
 * Chave), o orçamento.
 */
export function toAgentDto(
  row: AgentWithHandle,
  opts: {
    admin: boolean;
    tools: AgentToolSummaryDto[];
    /** Os repositórios do GitHub a que o Agente está restrito (nulo ou ausente: todos os da instalação). */
    githubRepositories?: string[] | null;
    keySpendUsd?: number;
  },
): AgentDto {
  const a = withBuiltinText(row);
  const dto: AgentDto = {
    id: a.id,
    name: a.name,
    handle: a.handle,
    photo: a.photo,
    description: a.description,
    model: a.model as AgentModel,
    builtin: a.builtin,
    tools: opts.tools,
    reach: reachLines(opts.tools),
    memoryEnabled: a.memoryEnabled,
  };
  if (opts.admin) {
    dto.instructions = a.instructions;
    dto.githubRepositories = opts.githubRepositories ?? null;
  }
  if (opts.admin && opts.keySpendUsd !== undefined) {
    const { monthlyBudgetUsd, keySpendUsd, overBudget } = budgetOf(row, opts.keySpendUsd);
    Object.assign(dto, { monthlyBudgetUsd, keySpendUsd, overBudget });
  }
  return dto;
}

/**
 * "acessa CRM com a credencial do Workspace": uma linha por Conector das Ferramentas dele, e uma
 * pelo GitHub (sempre com a credencial do Workspace, ADR 0010). A lista de repositórios do Agente
 * é configuração do Admin (`githubRepositories`) e não entra aqui.
 */
export function reachLines(tools: readonly AgentToolSummaryDto[]): string[] {
  const names = new Set<string>();
  for (const t of tools) if (t.connector?.credential === "workspace") names.add(t.connector.name);
  const lines = [...names].map((name) => `acessa ${name} com a credencial do Workspace`);
  if (tools.some((t) => t.origin === "github")) lines.push("acessa o GitHub com a credencial do Workspace");
  return lines;
}
