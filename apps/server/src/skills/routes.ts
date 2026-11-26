import { SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, type UpdateSkillInput } from "@shearim/contracts";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { findAgent, lockLiveAgent } from "../agents";
import type { Clock } from "../clock";
import { type Db, isUuid, schema } from "../db/client";
import { adminOnly, type Env } from "../members";
import { agentSkillsOf, selectSkills, skillById } from "./skills";

const { skills, agentSkills } = schema;

/**
 * As Habilidades (spec #74), só do Admin: escrever, editar, apagar e ver em quais Agentes cada uma
 * está ativa; e, na tela de cada Agente (a Articuladora inclusive), ativar e desativar.
 *
 * O nome é único no Workspace sem diferenciar maiúsculas (`409 name_taken`); a descrição diz quando
 * usar e é obrigatória (`400 invalid_input`). Uma edição vale na próxima leitura; apagar tira a
 * Habilidade de todos os Agentes na hora.
 */
export function skillRoutes(deps: { db: Db; clock: Clock }) {
  const { db, clock } = deps;
  const routes = new Hono<Env>();

  routes.get("/skills", adminOnly, async (c) => c.json(await selectSkills(db)));

  routes.get("/skills/:id", adminOnly, async (c) => {
    const skill = await skillById(db, c.req.param("id"));
    return skill ? c.json(skill) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/skills", adminOnly, async (c) => {
    const input = await fieldsOf(c, { partial: false });
    if (input instanceof Response) return input;
    const now = clock.now();
    const id = crypto.randomUUID();
    const [created] = await db
      .insert(skills)
      .values({ id, ...(input as Required<UpdateSkillInput>), createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: skills.id });
    if (!created) return nameTaken(c, input.name!);
    return c.json(await skillById(db, id), 201);
  });

  routes.patch("/skills/:id", adminOnly, async (c) => {
    const current = await skillById(db, c.req.param("id"));
    if (!current) return c.json({ error: "not_found" }, 404);
    const input = await fieldsOf(c, { partial: true });
    if (input instanceof Response) return input;
    if (Object.keys(input).length) {
      try {
        await db
          .update(skills)
          .set({ ...input, updatedAt: clock.now() })
          .where(eq(skills.id, current.id));
      } catch (err) {
        if (isUniqueViolation(err)) return nameTaken(c, input.name!);
        throw err;
      }
    }
    return c.json(await skillById(db, current.id));
  });

  routes.delete("/skills/:id", adminOnly, async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    // As ativações saem junto (`on delete cascade`): nenhum Agente a tem mais, nem no meio da resposta.
    const [gone] = await db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
    return gone ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  routes.get("/agents/:id/skills", adminOnly, async (c) => {
    const [agent] = await findAgent(db, c.req.param("id"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    return c.json(await agentSkillsOf(db, agent.id));
  });

  for (const method of ["put", "delete"] as const) {
    routes[method]("/agents/:id/skills/:skill", adminOnly, async (c) => {
      const [agent] = await findAgent(db, c.req.param("id"));
      const skill = await skillById(db, c.req.param("skill"));
      if (!agent || !skill) return c.json({ error: "not_found" }, 404);
      if (method === "put") {
        const done = await db.transaction(async (tx) => {
          // Quem apaga o Agente leva as ativações dele: ativar espera ou desiste.
          if (!(await lockLiveAgent(tx, agent.id))) return false;
          await tx
            .insert(agentSkills)
            .values({ agentId: agent.id, skillId: skill.id, activatedAt: clock.now() })
            .onConflictDoNothing();
          return true;
        });
        if (!done) return c.json({ error: "not_found" }, 404);
      } else {
        await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agent.id), eq(agentSkills.skillId, skill.id)));
      }
      return c.json(await agentSkillsOf(db, agent.id));
    });
  }

  return routes;
}

/** O nome, a descrição e o corpo conferidos (só os presentes, com `partial`), ou a resposta 400. */
async function fieldsOf(c: Context<Env>, opts: { partial: boolean }): Promise<UpdateSkillInput | Response> {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("Mande o nome, a descrição e o corpo.");
  const out: UpdateSkillInput = {};
  const rules = [
    ["name", "o nome da Habilidade", SKILL_NAME_MAX],
    ["description", "a descrição", SKILL_DESCRIPTION_MAX],
    ["body", "o corpo", SKILL_BODY_MAX],
  ] as const;
  for (const [field, label, max] of rules) {
    const value = raw[field];
    if (value === undefined && opts.partial) continue;
    if (value !== undefined && typeof value !== "string") return invalid(`O campo ${field} é um texto.`);
    const text =
      field === "body" ? ((value as string | undefined) ?? "") : ((value as string | undefined) ?? "").trim();
    if (field === "name" && !text) return invalid("Dê um nome à Habilidade.");
    if (field === "description" && !text)
      return invalid("A descrição diz quando usar a Habilidade: ela é obrigatória.");
    if (field === "body" && !text.trim()) return invalid("Escreva o corpo da Habilidade: o procedimento em markdown.");
    if (text.length > max)
      return invalid(`${label[0]!.toUpperCase()}${label.slice(1)} tem no máximo ${max} caracteres.`);
    out[field] = text;
  }
  return out;
}

const nameTaken = (c: Context<Env>, name: string) =>
  c.json({ error: "name_taken", message: `Já existe uma Habilidade chamada ${name}.` }, 409);

/** O nome repetido (o índice único em `lower(name)`), como o Postgres e o PGlite o dizem. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
