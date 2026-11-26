import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type Db, schema } from "../db/client";
import { type AutomaticTool, ToolFailure } from "../tools/port";
import { input } from "../tools/workspace-read";

const { skills, agentSkills } = schema;

/** O nome da Ferramenta, que o catálogo no contexto cita. */
export const LOAD_SKILL_TITLE = "carregar Habilidade";

/** As Habilidades ativas no Agente agora, por nome (o catálogo no contexto). */
export async function activeSkillsOf(db: Db, agentId: string) {
  return (await activeSkillsByAgent(db, [agentId])).get(agentId) ?? [];
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

/** A Habilidade ativa no Agente com este nome (sem diferenciar maiúsculas), lida agora. */
async function activeSkillNamed(db: Db, agentId: string, name: string) {
  const [found] = await db
    .select({ name: skills.name, body: skills.body })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(and(eq(agentSkills.agentId, agentId), sql`lower(${skills.name}) = lower(${name})`));
  return found;
}

/**
 * O catálogo das Habilidades do Agente (spec #74), a camada logo depois das instruções dele: uma
 * linha por Habilidade ativa, com o nome e a descrição, e a nota de que o corpo se carrega pela
 * Ferramenta. Vazio sem Habilidade ativa: a camada não entra.
 */
export async function skillCatalog(db: Db, agentId: string): Promise<string> {
  const active = await activeSkillsOf(db, agentId);
  if (active.length === 0) return "";
  return [
    `Procedimentos escritos pelo time para você. Aqui vai só o nome e quando usar cada um: quando a tarefa pedir um deles, carregue o texto inteiro com a Ferramenta ${LOAD_SKILL_TITLE}, pelo nome, e siga o que ele diz.`,
    active.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
  ].join("\n\n");
}

const nameOf = (raw: unknown) => {
  const { nome } = input(raw);
  return typeof nome === "string" ? nome.trim() : "";
};

/**
 * Carregar Habilidade (spec #74), no modelo de "buscar na Memória": automática, de leitura, sem
 * Pedido de aprovação, presente para todo Agente com ao menos uma Habilidade ativa. A ativação e o
 * corpo são lidos na hora em que ela roda: o Admin pode desativar, apagar ou editar a Habilidade no
 * meio da resposta. Um nome que não é de uma Habilidade ativa daquele Agente é falha com motivo.
 */
export const LOAD_SKILL: AutomaticTool = {
  id: "carregar_habilidade",
  title: LOAD_SKILL_TITLE,
  label: "carregando uma Habilidade",
  description:
    "Carrega o texto inteiro de uma das suas Habilidades (os procedimentos do time listados em Suas Habilidades), pelo nome. Use quando a tarefa pedir aquele procedimento, antes de começar.",
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: { nome: { type: "string", description: "O nome da Habilidade, como em Suas Habilidades." } },
    required: ["nome"],
    additionalProperties: false,
  },
  async presentFor(db, run) {
    const [any] = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, run.agentId))
      .limit(1);
    return Boolean(any);
  },
  async describe({ db, run }, input) {
    const name = nameOf(input);
    if (!name) return {};
    const found = await activeSkillNamed(db, run.agentId, name);
    return { label: `carregando a Habilidade ${found?.name ?? name}` };
  },
  async run({ db, run }, input) {
    const name = nameOf(input);
    if (!name) throw new ToolFailure("diga o nome da Habilidade");
    const found = await activeSkillNamed(db, run.agentId, name);
    if (!found) throw new ToolFailure(`${name} não é uma Habilidade ativa sua`);
    return found.body;
  },
};
