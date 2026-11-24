import { AGENT_MODELS, type AgentDto, type AgentModel, type CreateAgentInput } from "@shearim/contracts";
import { asc, eq, getTableColumns } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Member } from "./members";
import { claimHandle, handleBase } from "./mention-handles";

type Env = { Variables: { member: Member } };
export type Agent = typeof schema.agents.$inferSelect;
/** O Agente com o identificador de Menção dele (`mention_handles`). */
export type AgentWithHandle = Agent & { handle: string };

const { agents, mentionHandles } = schema;

const NAME_MAX = 40;
/** Uma foto pequena: `data:` URL de imagem com até ~300 KB. */
const PHOTO = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_MAX = 400_000;

/** Agentes: o Admin cria; todo Membro vê o nome, a foto, a descrição e o modelo. */
export function agentRoutes(deps: { db: Db; clock: Clock }) {
  const { db, clock } = deps;
  const routes = new Hono<Env>();

  routes.get("/agents", async (c) => {
    const admin = c.get("member").role === "admin";
    const all = await db
      .select({ ...getTableColumns(agents), handle: mentionHandles.handle })
      .from(agents)
      .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
      .orderBy(asc(agents.createdAt), asc(agents.name));
    return c.json(all.map((a) => toAgentDto(a, { admin })));
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
          createdAt: clock.now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!agent) return undefined;
      const handle = await claimHandle(tx, { kind: "agent", id: agent.id }, agentHandleBase(name));
      return { ...agent, handle };
    });
    if (!created) return c.json({ error: "name_taken", message: `Já existe um Agente chamado ${name}.` }, 409);
    return c.json(toAgentDto(created, { admin: true }), 201);
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

export function toAgentDto(a: AgentWithHandle, opts: { admin: boolean }): AgentDto {
  const dto: AgentDto = {
    id: a.id,
    name: a.name,
    handle: a.handle,
    photo: a.photo,
    description: a.description,
    model: a.model as AgentModel,
  };
  if (opts.admin) dto.instructions = a.instructions;
  return dto;
}
