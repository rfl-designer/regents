import type { AgentSkillDto, SkillDto } from "@regents/contracts";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";
import { SYNC_SKILL } from "../wiki/rules";

const { skills, agentSkills, agents } = schema;

/** As Habilidades que atendem a `where`, por nome, com os Agentes em que estão ativas. */
export async function selectSkills(db: Db, where?: SQL): Promise<SkillDto[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(where)
    .orderBy(asc(sql`lower(${skills.name})`));
  if (rows.length === 0) return [];
  const active = await db
    .select({ skillId: agentSkills.skillId, id: agents.id, name: agents.name })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .where(
      inArray(
        agentSkills.skillId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(agents.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    body: r.body,
    origin: r.origin,
    agents: active.filter((a) => a.skillId === r.id).map(({ id, name }) => ({ id, name })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** A Habilidade `id`, se existe. */
export async function skillById(db: Db, id: string): Promise<SkillDto | undefined> {
  if (!isUuid(id)) return undefined;
  const [found] = await selectSkills(db, eq(skills.id, id));
  return found;
}

/**
 * Todas as Habilidades, por nome, com a marca de ativa no Agente `agentId` (a tela do Agente). Na
 * Articuladora (`builtin`), primeiro a Habilidade do Shearim "Sincronizar a Wiki", só para leitura.
 */
export async function agentSkillsOf(db: Db, agentId: string, builtin = false): Promise<AgentSkillDto[]> {
  const rows = await db
    .select({ id: skills.id, name: skills.name, description: skills.description, activeIn: agentSkills.agentId })
    .from(skills)
    .leftJoin(agentSkills, and(eq(agentSkills.skillId, skills.id), eq(agentSkills.agentId, agentId)))
    .orderBy(asc(sql`lower(${skills.name})`));
  const own = rows.map(({ activeIn, ...r }) => ({ ...r, active: activeIn !== null }));
  return builtin ? [{ ...SYNC_SKILL, active: true, builtin: true }, ...own] : own;
}

/**
 * As Habilidades ativas agora em cada Agente de `agentIds` (sem eles, em todos), por nome: o nome e
 * a descrição, nunca o corpo. É o que a lista de Agentes e o roteamento da Articuladora mostram.
 */
export async function activeSkillsByAgent(db: Db, agentIds?: readonly string[]) {
  const byAgent = new Map<string, { name: string; description: string }[]>();
  if (agentIds?.length === 0) return byAgent;
  const rows = await db
    .select({ agentId: agentSkills.agentId, name: skills.name, description: skills.description })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(agentIds ? inArray(agentSkills.agentId, [...agentIds]) : undefined)
    .orderBy(asc(sql`lower(${skills.name})`));
  for (const { agentId, ...skill } of rows) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), skill]);
  return byAgent;
}
