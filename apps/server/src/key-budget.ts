import type { AgentBudgetDto, KeyIncidentDto } from "@shearim/contracts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { ModelUsage } from "./model/port";

const { agents, budgetOverruns, executionUsage, members, keyIncidents } = schema;

/** O mês do gasto (`YYYY-MM`), em UTC: o orçamento recomeça à 0h UTC do dia 1. */
export const monthOf = (at: Date) => at.toISOString().slice(0, 7);

/** O gasto na Chave no mês, por Agente (quem não gastou fica fora do mapa). */
export async function keySpend(db: Db, month: string, agentIds?: readonly string[]): Promise<Map<string, number>> {
  if (agentIds && agentIds.length === 0) return new Map();
  const rows = await db
    .select({ agentId: executionUsage.agentId, usd: sql<number>`sum(${executionUsage.costUsd})`.mapWith(Number) })
    .from(executionUsage)
    .where(
      and(
        eq(executionUsage.month, month),
        eq(executionUsage.payer, "key"),
        agentIds ? inArray(executionUsage.agentId, [...agentIds]) : undefined,
      ),
    )
    .groupBy(executionUsage.agentId);
  return new Map(rows.map((r) => [r.agentId, r.usd]));
}

/** O orçamento como o Admin o vê: estourado quando o gasto do mês chegou ao teto. */
export function budgetOf(
  agent: Pick<typeof agents.$inferSelect, "id" | "name" | "monthlyBudgetUsd">,
  spentUsd: number,
): AgentBudgetDto {
  const budget = agent.monthlyBudgetUsd;
  return {
    agentId: agent.id,
    name: agent.name,
    monthlyBudgetUsd: budget,
    keySpendUsd: spentUsd,
    overBudget: budget !== null && spentUsd >= budget,
  };
}

/** O orçamento vindo do formulário: um número `>= 0`, ou nulo (sem teto). `undefined` se inválido. */
export function parseBudget(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** O incidente da Chave aberto agora, ou `null`. */
export async function openIncident(db: Db): Promise<KeyIncidentDto | null> {
  const [row] = await db.select().from(keyIncidents).where(isNull(keyIncidents.closedAt));
  return row ? toIncidentDto(row) : null;
}

function toIncidentDto(row: typeof keyIncidents.$inferSelect): KeyIncidentDto {
  return { id: row.id, kind: row.kind, openedAt: row.openedAt.toISOString() };
}

/** Ganchos de domínio da Chave: onde os pushes aos Admins (#34) se penduram. */
export interface KeyHooks {
  /** Abriu um incidente da Chave (um por incidente). Roda depois de gravar e anunciar a faixa. */
  keyIncidentOpened?(incident: KeyIncidentDto): void;
  /**
   * O orçamento de um Agente estourou: no máximo uma vez por Agente por mês, mesmo que o Admin
   * aumente o teto e ele estoure de novo. Roda depois de gravar e anunciar a faixa.
   */
  budgetExceeded?(budget: AgentBudgetDto): void;
}

/**
 * Chave e orçamentos (Spec, módulo 9): o gasto na Chave por Agente e por mês e os incidentes
 * da Chave. As execuções avisam cada chamada que a Chave pagou (`charged`) e cada recusa da
 * Anthropic (`refused`).
 */
export function createKeyLedger(deps: { db: Db; clock: Clock; events: EventHub; hooks?: KeyHooks }) {
  const { db, clock, events, hooks } = deps;

  async function adminAudience() {
    const admins = await db.select({ id: members.id }).from(members).where(eq(members.role, "admin"));
    return { members: admins.map((a) => a.id) };
  }

  /** O orçamento de um Agente agora, como o Admin o vê (o teto relido: o Admin pode tê-lo mudado). */
  async function budgetNow(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const spent = (await keySpend(db, monthOf(clock.now()), [agentId])).get(agentId) ?? 0;
    return budgetOf(agent!, spent);
  }

  /** Anuncia aos Admins o orçamento do Agente (gasto ou teto mudou). */
  async function announce(agentId: string) {
    const budget = await budgetNow(agentId);
    events.publish(await adminAudience(), { type: "agent_budget.updated", budget });
    return budget;
  }

  /** O estouro do mês, avisado uma vez só por Agente por mês. */
  async function overrun(budget: AgentBudgetDto) {
    const [noted] = await db
      .insert(budgetOverruns)
      .values({ agentId: budget.agentId, month: monthOf(clock.now()), at: clock.now() })
      .onConflictDoNothing()
      .returning();
    if (noted) hooks?.budgetExceeded?.(budget);
  }

  return {
    budgetNow,
    /** O Admin mudou o orçamento: a faixa e a tela de Agentes acompanham. */
    budgetChanged: (agentId: string) => announce(agentId),

    /**
     * O orçamento, conferido antes de cada execução pela Chave (a que já roda termina): com o
     * gasto do mês no teto, o Agente não usa a Chave, e o motivo é o de "Agentes não agem".
     */
    async usable(agentId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      const budget = await budgetNow(agentId);
      if (!budget.overBudget) return { ok: true };
      await overrun(budget);
      return { ok: false, reason: `${budget.name} estourou o orçamento do mês na Chave` };
    },

    /** Uma chamada que a Chave pagou terminou bem: grava o uso (Agente, pagador, custo). */
    async charged(
      execution: { id: string; agentId: string },
      call: { model: string; usage: ModelUsage; costUsd: number },
    ) {
      const now = clock.now();
      await db.insert(executionUsage).values({
        id: crypto.randomUUID(),
        executionId: execution.id,
        agentId: execution.agentId,
        payer: "key",
        model: call.model,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        costUsd: call.costUsd,
        month: monthOf(now),
        createdAt: now,
      });
      const budget = await announce(execution.agentId);
      if (budget.overBudget) await overrun(budget);
      // A primeira chamada bem-sucedida pela Chave encerra o incidente.
      const closed = await db
        .update(keyIncidents)
        .set({ closedAt: now })
        .where(isNull(keyIncidents.closedAt))
        .returning({ id: keyIncidents.id });
      if (closed.length) events.publish(await adminAudience(), { type: "key_incident.updated", incident: null });
    },

    /**
     * A Anthropic recusou a Chave (`auth_failed`) ou ela está sem crédito (`billing_failed`):
     * abre um incidente, se não há um aberto.
     */
    async refused(kind: KeyIncidentDto["kind"]) {
      const [opened] = await db
        .insert(keyIncidents)
        .values({ id: crypto.randomUUID(), kind, openedAt: clock.now() })
        .onConflictDoNothing()
        .returning();
      if (!opened) return;
      const incident = toIncidentDto(opened);
      events.publish(await adminAudience(), { type: "key_incident.updated", incident });
      hooks?.keyIncidentOpened?.(incident);
    },
  };
}

export type KeyLedger = ReturnType<typeof createKeyLedger>;
