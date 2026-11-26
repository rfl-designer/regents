import {
  AGENT_MODELS,
  type AgentDto,
  type AgentModel,
  type AgentSkillSummaryDto,
  type AgentToolSummaryDto,
  type AgentWikiSummaryDto,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "@regents/contracts";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { withBuiltinText } from "./articuladora";
import type { Clock } from "./clock";
import { type Channel, toChannelDto } from "./conversations";
import { type Db, isUuid, schema, type Tx } from "./db/client";
import type { EventHub } from "./events";
import type { Executions } from "./executions";
import type { GitHub } from "./github/connector";
import { budgetOf, type KeyLedger, keySpend, monthOf, parseBudget } from "./key-budget";
import type { Env } from "./members";
import { forgetAgent } from "./memory/items";
import { claimHandle, handleBase, releaseHandle } from "./mention-handles";
import { audienceOf } from "./participation";
import { activeSkillsByAgent } from "./skills/skills";
import type { ToolPort } from "./tools/port";
import { leaveAgentWikis } from "./wiki/reach";
import { agentWikisReadableBy } from "./wiki/wikis";

export type Agent = typeof schema.agents.$inferSelect;
/** O Agente com o identificador de Menção dele (`mention_handles`). */
export type AgentWithHandle = Agent & { handle: string };

const { agents, mentionHandles, channels, channelAgents, agentTools, agentSkills, agentGithubRepositories } = schema;

const NAME_MAX = 40;
/** Uma foto pequena: `data:` URL de imagem com até ~300 KB. */
const PHOTO = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_MAX = 400_000;
const BUDGET_INVALID = "O orçamento mensal é um valor em dólares, zero ou mais (vazio: sem teto).";

/**
 * Agentes: o Admin cria; todo Membro vê o nome, a foto, a descrição, o modelo, as Ferramentas, as
 * Habilidades e as Wikis ligadas que ele lê.
 */
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
  /** Para apagar um Agente (#65): o que ele tem aberto é cancelado, e todos ficam sabendo. */
  executions: Pick<Executions, "cancelAgent">;
  events: EventHub;
}) {
  const { db, clock, ledger } = deps;
  const routes = new Hono<Env>();

  /**
   * O que cada Agente (`ids`, ou todos) tem, como `memberId` vê: as Ferramentas, as Habilidades
   * ativas, as Wikis ligadas que ele lê e os repositórios do GitHub. Lido em lote.
   */
  async function capabilitiesOf(memberId: string, ids?: readonly string[]) {
    const grants = await deps.tools.grantsOf(ids);
    const repos = (await deps.github?.agentRepositories(ids)) ?? new Map<string, string[] | null>();
    const skills = await activeSkillsByAgent(db, ids);
    const wikis = await agentWikisReadableBy(db, memberId, ids);
    return (id: string) => ({
      tools: grants.get(id) ?? [],
      skills: skills.get(id) ?? [],
      wikis: wikis.get(id) ?? [],
      githubRepositories: repos.get(id) ?? null,
    });
  }

  routes.get("/agents", async (c) => {
    const me = c.get("member");
    const admin = me.role === "admin";
    const all = await db
      .select({ ...getTableColumns(agents), handle: mentionHandles.handle })
      .from(agents)
      .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
      .orderBy(desc(agents.builtin), asc(agents.createdAt), asc(agents.name));
    const of = await capabilitiesOf(me.id);
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
    const of = await capabilitiesOf(c.get("member").id, [created.id]);
    return c.json(toAgentDto(created, { admin: true, ...of(created.id), keySpendUsd: 0 }), 201);
  });

  /**
   * O Admin edita um Agente; campo ausente fica. Da Articuladora, tudo menos a descrição e as
   * instruções, que são do Shearim (`403 builtin_locked`): o Admin desliga a Memória dela também. Trocar o nome troca
   * o identificador de Menção, pelo mesmo critério da criação.
   */
  routes.patch("/agents/:id", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    const [current] = await findAgent(db, id);
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
      // Trava o Agente: um DELETE ao mesmo tempo espera, ou já o apagou, e então nada muda (nem o
      // identificador de Menção volta para ele).
      const [live] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, current.id), isNull(agents.deletedAt)))
        .for("update");
      if (!live) return "gone" as const;
      if (change.name !== undefined && change.name !== current.name) {
        const [taken] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              sql`lower(${agents.name}) = lower(${change.name})`,
              ne(agents.id, current.id),
              isNull(agents.deletedAt),
            ),
          );
        if (taken) return undefined;
      }
      const [row] = Object.keys(change).length
        ? await tx.update(agents).set(change).where(eq(agents.id, current.id)).returning()
        : [current];
      const owner = { kind: "agent", id: current.id } as const;
      if (change.name !== undefined && change.name !== current.name) {
        await releaseHandle(tx, owner);
        return { ...row!, handle: await claimHandle(tx, owner, agentHandleBase(change.name)) };
      }
      const [{ handle }] = (await tx
        .select({ handle: mentionHandles.handle })
        .from(mentionHandles)
        .where(eq(mentionHandles.agentId, current.id))) as [{ handle: string }];
      return { ...row!, handle };
    });
    if (updated === "gone") return c.json({ error: "not_found" }, 404);
    if (!updated) return c.json({ error: "name_taken", message: `Já existe um Agente chamado ${change.name}.` }, 409);
    const budgetChanged = change.monthlyBudgetUsd !== undefined && change.monthlyBudgetUsd !== current.monthlyBudgetUsd;
    const budget = budgetChanged ? await ledger.budgetChanged(updated.id) : await ledger.budgetNow(updated.id);
    if (budgetChanged) deps.onBudgetChanged?.();
    const of = await capabilitiesOf(c.get("member").id, [updated.id]);
    return c.json(toAgentDto(updated, { admin: true, ...of(updated.id), keySpendUsd: budget.keySpendUsd }));
  });

  /**
   * O Admin apaga um Agente (#65; a Articuladora não: `403 builtin_locked`). Nada do histórico das
   * conversas some: a linha dele fica, marcada `deleted_at`, porque as mensagens, o Andamento, os
   * Desfechos, os Pedidos de aprovação e os gastos apontam para ela. Ele sai das listas, do
   * identificador de Menção (o nome e o `@` voltam a ficar livres) e dos Canais; as DMs com ele
   * ficam, e o que chegar ali diz que ele foi apagado. As Ferramentas concedidas, as Habilidades, as
   * Wikis ligadas e a lista de repositórios saem. O que ele tinha aberto é cancelado. A Memória do Agente sai junto (é o
   * único apagamento de Memória, spec #60); a Memória da Conversa que ele gerou fica. Apagar de
   * novo um Agente já apagado refaz a limpeza (cancelar e apagar a Memória dele), para o caso de
   * ela ter caído no meio da primeira vez.
   */
  routes.delete("/agents/:id", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    // Com os apagados: a limpeza de um que caiu no meio se refaz.
    const [agent] = isUuid(id) ? await db.select().from(agents).where(eq(agents.id, id)) : [];
    if (!agent) return c.json({ error: "not_found" }, 404);
    if (agent.builtin) {
      return c.json({ error: "builtin_locked", message: "A Articuladora é do Shearim e não se apaga." }, 403);
    }
    const left = agent.deletedAt
      ? await forgetAgent(db, agent.id).then(() => [])
      : await db.transaction(async (tx) => {
          // Primeiro a marca, que trava o Agente: quem grava algo ligado a ele (`lockLiveAgent`)
          // espera aqui, ou gravou antes e a limpeza abaixo leva junto.
          await tx.update(agents).set({ deletedAt: clock.now() }).where(eq(agents.id, agent.id));
          await releaseHandle(tx, { kind: "agent", id: agent.id });
          await tx.delete(agentTools).where(eq(agentTools.agentId, agent.id));
          await tx.delete(agentSkills).where(eq(agentSkills.agentId, agent.id));
          await leaveAgentWikis(tx, agent.id);
          await tx.delete(agentGithubRepositories).where(eq(agentGithubRepositories.agentId, agent.id));
          // Na mesma transação: a marca não fica sem a Memória ter saído.
          await forgetAgent(tx, agent.id);
          // Sai dos Canais; numa DM, fica (é com quem a DM foi).
          return tx
            .delete(channelAgents)
            .where(
              and(
                eq(channelAgents.agentId, agent.id),
                inArray(
                  channelAgents.channelId,
                  tx
                    .select({ id: channels.id })
                    .from(channels)
                    .where(inArray(channels.kind, ["public", "private"])),
                ),
              ),
            )
            .returning({ channelId: channelAgents.channelId });
        });
    // A extração em andamento confere o Agente antes de guardar: cancelada ou não, nada guarda.
    await deps.executions.cancelAgent(agent.id);

    deps.events.publish("everyone", { type: "agent.deleted", agentId: agent.id });
    const changed = left.length
      ? ((await db
          .select()
          .from(channels)
          .where(
            inArray(
              channels.id,
              left.map((l) => l.channelId),
            ),
          )) as Channel[])
      : [];
    for (const channel of changed) {
      deps.events.publish(await audienceOf(db, channel), {
        type: "channel.updated",
        channel: await toChannelDto(db, channel),
      });
    }
    return c.body(null, 204);
  });

  return routes;
}

/** O Agente `id`, se existe e não foi apagado. */
export function findAgent(db: Db, id: string) {
  return isUuid(id)
    ? db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
    : Promise.resolve([]);
}

/**
 * Trava o Agente `id` na transação `tx`, se ele não foi apagado (devolve se não foi). Quem liga
 * algo a ele (Canal, DM, Ferramenta, repositórios do GitHub, Memória) trava antes de gravar: o
 * DELETE dele espera essa gravação e a limpa junto, ou já o apagou, e então nada se grava.
 */
export async function lockLiveAgent(tx: Tx, id: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
    .for("share");
  return Boolean(live);
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
    /** As Habilidades ativas nele: o nome e a descrição. */
    skills: AgentSkillSummaryDto[];
    /** As Wikis ligadas a ele que quem pede lê (`agentWikisReadableBy`). */
    wikis: AgentWikiSummaryDto[];
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
    skills: opts.skills,
    wikis: opts.wikis,
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
