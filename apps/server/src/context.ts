import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Agent } from "./agents";
import { type Db, schema } from "./db/client";
import type { ModelMessage } from "./model/port";
import { readWorkspaceContext } from "./workspace-context";

const { messages, members, agents, channels, channelParticipants, channelAgents } = schema;

/** O que vai ao modelo numa execução. */
export interface ModelContext {
  system: string;
  messages: ModelMessage[];
}

/**
 * Por que o Agente foi chamado: entra no preâmbulo ("sabe quem chamou").
 * Hoje só a Menção. SEAM do #22: a resposta da Articuladora e o delegado entram aqui como
 * outros tipos (`{ kind: "delegated"; by: string; cover: string }`, com a frase do que cobrir).
 */
export type Call = { kind: "mention" };

/**
 * Montagem de contexto (Spec, módulo 5). Lido na hora em que a execução começa (inclusive numa
 * nova tentativa), nunca guardado. De cima para baixo:
 *
 * 1. o preâmbulo fixo do Shearim (chat de time, pt-BR, sem ferramentas, não promete ações,
 *    quem chamou);
 * 2. o Contexto do Workspace;
 * 3. as instruções do Agente;
 * 4. as Instruções do Canal;
 * 5. quem é quem (pessoas com nome e "sobre mim", Agentes com nome e descrição);
 * 6. as últimas N mensagens até a de origem, cada uma com o autor e a marca de pessoa ou Agente.
 *
 * As camadas 1 a 5 vão no `system`; a 6 vai como uma mensagem só, em ordem, terminando na
 * mensagem que o Agente responde (com N = 0, só ela). Uma seção vazia não entra.
 */
export async function buildContext(
  db: Db,
  agent: Agent,
  originMessageId: string,
  call: Call = { kind: "mention" },
): Promise<ModelContext> {
  const [origin] = await db.select().from(messages).where(eq(messages.id, originMessageId));
  if (!origin) throw new Error(`buildContext: a mensagem ${originMessageId} não existe`);
  const [conversation] = await db.select().from(channels).where(eq(channels.id, origin.channelId));

  const recent = await recentMessages(db, origin, conversation!.recentMessages);
  const people = await db
    .select({ id: members.id, name: members.displayName, aboutMe: members.aboutMe })
    .from(channelParticipants)
    .innerJoin(members, eq(members.id, channelParticipants.memberId))
    .where(eq(channelParticipants.channelId, conversation!.id))
    .orderBy(asc(members.displayName), asc(members.id));
  // Os Agentes da conversa, o próprio e quem falou nas mensagens que entram (chamado por Menção).
  const inChannel = await db
    .select({ id: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, conversation!.id));
  const agentIds = new Set([agent.id, ...inChannel.map((a) => a.id), ...recent.flatMap((m) => m.agentId ?? [])]);
  const team = await db
    .select({ id: agents.id, name: agents.name, description: agents.description })
    .from(agents)
    .where(inArray(agents.id, [...agentIds]))
    .orderBy(asc(agents.createdAt), asc(agents.name));

  const caller = recent.at(-1)!;
  const where =
    conversation!.kind === "public" || conversation!.kind === "private" ? `no Canal #${conversation!.name}` : "numa DM";
  const why = call.kind === "mention" ? `${caller.author} chamou você com uma Menção ${where}.` : "";

  const preamble = [
    `Você é ${agent.name}, um Agente do Shearim, um chat de time em que pessoas e Agentes conversam juntos.`,
    "Responda sempre em português do Brasil, como numa conversa de chat: direto e no tom do time.",
    "Você não tem ferramentas: não abre arquivos, links ou sistemas, não pesquisa na internet e não executa nada. Tudo o que você sabe está neste contexto.",
    "Não prometa ações que não pode fazer, como enviar, agendar, lembrar depois, conferir algo ou voltar com uma resposta mais tarde. Se pedirem algo assim, diga com clareza que não consegue e ofereça o que dá para fazer aqui, na conversa.",
    why,
  ]
    .filter(Boolean)
    .join("\n");

  const whoIsWho = [
    "Pessoas:",
    ...people.map((p) => `- ${p.name}${p.aboutMe ? `: ${p.aboutMe}` : ""}`),
    "Agentes:",
    ...team.map((a) => `- ${a.name}${a.id === agent.id ? " (você)" : ""}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");

  const system = [
    preamble,
    section("Contexto do Workspace", await readWorkspaceContext(db)),
    section("Suas instruções", agent.instructions),
    section("Instruções do Canal", conversation!.instructions),
    section("Quem é quem", whoIsWho),
  ]
    .filter(Boolean)
    .join("\n\n");

  const transcript = recent.map((m) => `${m.author} (${m.agentId ? "Agente" : "pessoa"}): ${m.body}`).join("\n\n");
  return {
    system,
    messages: [
      {
        role: "user",
        content: [
          "Mensagens recentes da conversa, da mais antiga para a mais nova:",
          transcript,
          `Responda à última mensagem, de ${caller.author}.`,
        ].join("\n\n"),
      },
    ],
  };
}

function section(title: string, body: string) {
  const text = body.trim();
  return text ? `## ${title}\n\n${text}` : "";
}

type Origin = typeof messages.$inferSelect;

/**
 * As N mensagens anteriores à de origem, mais ela, em ordem de gravação, com o autor.
 * SEAM do #29 (Threads): numa Thread, a raiz entra sempre, seguida das N últimas da Thread.
 */
async function recentMessages(db: Db, origin: Origin, n: number) {
  const select = () =>
    db
      .select({
        seq: messages.seq,
        body: messages.body,
        agentId: messages.authorAgentId,
        memberName: members.displayName,
        agentName: agents.name,
      })
      .from(messages)
      .leftJoin(members, eq(members.id, messages.authorMemberId))
      .leftJoin(agents, eq(agents.id, messages.authorAgentId));
  const before = await select()
    .where(and(eq(messages.channelId, origin.channelId), lt(messages.seq, origin.seq)))
    .orderBy(desc(messages.seq))
    .limit(n);
  const [self] = await select().where(eq(messages.id, origin.id));
  return [...before.reverse(), self!].map((m) => ({
    body: m.body,
    agentId: m.agentId,
    author: m.agentName ?? m.memberName ?? "Alguém",
  }));
}
