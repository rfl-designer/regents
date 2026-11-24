import { normalizeHandle } from "@shearim/contracts";
import { and, asc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { Agent } from "./agents";
import { recentMessages } from "./context";
import { type Db, schema } from "./db/client";

const { messages, agents, channels, channelAgents, channelParticipants, mentionHandles } = schema;

/**
 * O contrato de roteamento da Articuladora (Spec, módulo 4; ADR 0004). É do Shearim: o Admin
 * não o edita. A entrada é a mensagem, poucas mensagens anteriores, as Instruções do Canal, os
 * Agentes do Canal e o mapa do Workspace visto pelo autor (os outros Agentes e os Canais que ele
 * pode ver). A saída é `responder | delegar | nenhum`, até 2 Agentes do Canal com a frase do que
 * cada um cobre, e o motivo de uma frase.
 */

/** "Poucas mensagens anteriores": o roteamento lê no máximo estas (e nunca mais que o N do Canal). */
export const ROUTING_RECENT = 5;
/** Quantos Agentes do Canal ela pode chamar numa delegação. */
export const MAX_DELEGATES = 2;

/** O JSON que o roteamento devolve (`output_config.format` pela Chave, `--json-schema` pela Conta). */
export const ROUTING_SCHEMA = {
  type: "object",
  properties: {
    decisao: { type: "string", enum: ["responder", "delegar", "nenhum"] },
    agentes: {
      type: "array",
      description: "Só em delegar: até 2 Agentes do Canal, cada um com o que deve cobrir.",
      items: {
        type: "object",
        properties: {
          agente: { type: "string", description: "O identificador do Agente do Canal, sem o @." },
          cobrir: { type: "string", description: "Uma frase: o que esse Agente deve cobrir na resposta." },
        },
        required: ["agente", "cobrir"],
        additionalProperties: false,
      },
    },
    motivo: { type: "string", description: "Uma frase: por que este Desfecho." },
  },
  required: ["decisao", "agentes", "motivo"],
  additionalProperties: false,
} as const;

type TeamMember = { id: string; name: string; handle: string; description: string };

/** O Desfecho decidido, já conferido contra os Agentes do Canal. */
export type Decision =
  | { decision: "reply" | "none"; reason: string; delegates: [] }
  | { decision: "delegate"; reason: string; delegates: { agentId: string; cover: string }[] };

/**
 * O mapa do Workspace visto por quem escreveu: os Canais que ele pode ver e os Agentes de fora
 * deste Canal, cada um com os Canais (desses) em que está. Um Canal privado de que o autor não
 * participa nunca aparece, nem pelo nome (para não vazar numa sugestão).
 */
export async function workspaceMapFor(db: Db, authorMemberId: string, channelId: string) {
  const visible = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      or(
        eq(channels.kind, "public"),
        and(
          eq(channels.kind, "private"),
          inArray(
            channels.id,
            db
              .select({ id: channelParticipants.channelId })
              .from(channelParticipants)
              .where(eq(channelParticipants.memberId, authorMemberId)),
          ),
        ),
      ),
    )
    .orderBy(asc(channels.createdAt), asc(channels.name));
  const here = db
    .select({ id: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channelId));
  const outside = await db
    .select({ id: agents.id, name: agents.name, handle: mentionHandles.handle, description: agents.description })
    .from(agents)
    .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
    .where(and(eq(agents.builtin, false), notInArray(agents.id, here)))
    .orderBy(asc(agents.createdAt), asc(agents.name));
  const placements =
    outside.length && visible.length
      ? await db
          .select({ agentId: channelAgents.agentId, channelId: channelAgents.channelId })
          .from(channelAgents)
          .where(
            and(
              inArray(
                channelAgents.agentId,
                outside.map((a) => a.id),
              ),
              inArray(
                channelAgents.channelId,
                visible.map((c) => c.id),
              ),
            ),
          )
      : [];
  const nameOf = new Map(visible.map((c) => [c.id, c.name!]));
  const lines = {
    channels: visible.map((c) => `#${c.name}`).join(", "),
    agents: outside.map((a) => {
      const where = placements.filter((p) => p.agentId === a.id).map((p) => `#${nameOf.get(p.channelId)}`);
      return `- ${agentLine(a)}${where.length ? ` · está em ${where.join(", ")}` : ""}`;
    }),
  };
  return lines;
}

function agentLine(a: TeamMember) {
  return `@${a.handle} (${a.name})${a.description ? `: ${a.description}` : ""}`;
}

/** Os Agentes do Canal a quem ela pode delegar (todos menos ela), com o identificador. */
async function delegatesIn(db: Db, channelId: string): Promise<TeamMember[]> {
  return db
    .select({ id: agents.id, name: agents.name, handle: mentionHandles.handle, description: agents.description })
    .from(channelAgents)
    .innerJoin(agents, eq(agents.id, channelAgents.agentId))
    .innerJoin(mentionHandles, eq(mentionHandles.agentId, agents.id))
    .where(and(eq(channelAgents.channelId, channelId), eq(agents.builtin, false)))
    .orderBy(asc(channelAgents.addedAt), asc(agents.name));
}

/** O pedido de roteamento de uma mensagem de pessoa num Canal: o `system`, a conversa e quem pode receber. */
export async function buildRouting(db: Db, articuladora: Agent, originMessageId: string) {
  const [origin] = await db.select().from(messages).where(eq(messages.id, originMessageId));
  if (!origin?.authorMemberId) throw new Error(`buildRouting: ${originMessageId} não é mensagem de pessoa`);
  const [channel] = await db.select().from(channels).where(eq(channels.id, origin.channelId));
  const recent = await recentMessages(db, origin, Math.min(ROUTING_RECENT, channel!.recentMessages));
  const team = await delegatesIn(db, channel!.id);
  const map = await workspaceMapFor(db, origin.authorMemberId, channel!.id);
  const author = recent.at(-1)!.author;

  const contract = [
    `Você é ${articuladora.name}, a Articuladora do Shearim, um chat de time em que pessoas e Agentes conversam juntos.`,
    `Você está no Canal #${channel!.name}. Dê o Desfecho da última mensagem, de ${author}: decida quem responde.`,
    "- responder: você mesma responde (pergunta geral, sobre o time, ou quando um Agente de fora do Canal serviria melhor: aí você sugere esse Agente em texto na sua resposta).",
    `- delegar: passe para até ${MAX_DELEGATES} Agentes do Canal, cada um com uma frase sobre o que cobrir. Só Agentes da lista "Agentes do Canal", pelo identificador. Um Agente de fora do Canal você nunca delega.`,
    "- nenhum: nenhum Agente precisa agir (conversa entre pessoas, recado, cumprimento, assunto encerrado).",
    "Na dúvida entre responder e nenhum, fique com nenhum.",
    "O motivo é uma frase curta, em português do Brasil.",
  ].join("\n");

  const system = [
    contract,
    section("Instruções do Canal", channel!.instructions),
    section("Agentes do Canal", team.map((a) => `- ${agentLine(a)}`).join("\n")),
    section("Outros Agentes do Workspace", map.agents.join("\n")),
    section(`Canais que ${author} pode ver`, map.channels),
  ]
    .filter(Boolean)
    .join("\n\n");

  const transcript = recent.map((m) => `${m.author} (${m.agentId ? "Agente" : "pessoa"}): ${m.body}`).join("\n\n");
  return {
    system,
    messages: [
      {
        role: "user" as const,
        content: [
          "Mensagens recentes do Canal, da mais antiga para a mais nova:",
          transcript,
          `Dê o Desfecho da última mensagem, de ${author}.`,
        ].join("\n\n"),
      },
    ],
    team,
  };
}

/**
 * Confere o JSON do roteamento. Delegados que não são Agentes do Canal saem; passam até 2.
 * Devolve `undefined` quando não dá para tirar um Desfecho dali (falha visível, ADR 0003).
 */
export function parseDecision(text: string, team: readonly TeamMember[]): Decision | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const out = raw as { decisao?: unknown; agentes?: unknown; motivo?: unknown };
  const reason = typeof out?.motivo === "string" ? out.motivo.trim() : "";
  if (!reason) return undefined;
  if (out.decisao === "responder") return { decision: "reply", reason, delegates: [] };
  if (out.decisao === "nenhum") return { decision: "none", reason, delegates: [] };
  if (out.decisao !== "delegar" || !Array.isArray(out.agentes)) return undefined;

  const delegates: { agentId: string; cover: string }[] = [];
  for (const item of out.agentes as { agente?: unknown; cobrir?: unknown }[]) {
    if (typeof item?.agente !== "string") continue;
    const handle = normalizeHandle(item.agente.replace(/^@+/, ""));
    const agent = team.find((a) => a.handle === handle);
    if (!agent || delegates.some((d) => d.agentId === agent.id)) continue;
    delegates.push({ agentId: agent.id, cover: typeof item.cobrir === "string" ? item.cobrir.trim() : "" });
    if (delegates.length === MAX_DELEGATES) break;
  }
  return delegates.length ? { decision: "delegate", reason, delegates } : undefined;
}

function section(title: string, body: string) {
  const text = body.trim();
  return text ? `## ${title}\n\n${text}` : "";
}
