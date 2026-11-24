import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Agent } from "./agents";
import { withBuiltinText } from "./articuladora";
import { type Db, schema } from "./db/client";
import type { ModelMessage } from "./model/port";
import { workspaceMapFor } from "./routing";
import { readWorkspaceContext } from "./workspace-context";

const { messages, members, agents, channels, channelParticipants, channelAgents } = schema;

/** O que vai ao modelo numa execução. */
export interface ModelContext {
  system: string;
  messages: ModelMessage[];
}

/**
 * Por que o Agente foi chamado: entra no preâmbulo ("sabe quem chamou").
 * `mention`: uma Menção, em Canal ou DM. `dm`: o Agente de uma DM com Agente, que responde a
 * cada mensagem. `reply`: a Articuladora decidiu responder ela mesma, pelo `reason`.
 * `delegated`: a Articuladora (`by`) passou a mensagem para ele, com a frase do que cobrir.
 */
export type Call =
  | { kind: "mention" }
  | { kind: "dm" }
  | { kind: "reply"; reason: string }
  | { kind: "delegated"; by: string; cover: string };

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
  row: Agent,
  originMessageId: string,
  call: Call = { kind: "mention" },
): Promise<ModelContext> {
  const agent = withBuiltinText(row);
  const [origin] = await db.select().from(messages).where(eq(messages.id, originMessageId));
  if (!origin) throw new Error(`buildContext: a mensagem ${originMessageId} não existe`);
  const [conversation] = await db.select().from(channels).where(eq(channels.id, origin.channelId));

  const recent = await recentMessages(db, origin, conversation!.recentMessages);
  const people = await db
    .select({ id: members.id, name: members.displayName, about: members.about })
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
    .select({ id: agents.id, name: agents.name, description: agents.description, builtin: agents.builtin })
    .from(agents)
    .where(inArray(agents.id, [...agentIds]))
    // A Articuladora primeiro: a hora dela é a da migração, não a do relógio do Workspace.
    .orderBy(desc(agents.builtin), asc(agents.createdAt), asc(agents.name))
    .then((rows) => rows.map((a) => withBuiltinText({ ...a, instructions: "" })));

  const caller = recent.at(-1)!;
  const where =
    conversation!.kind === "public" || conversation!.kind === "private" ? `no Canal #${conversation!.name}` : "numa DM";
  const why = {
    mention: () => `${caller.author} chamou você com uma Menção ${where}.`,
    dm: () => `Você está numa DM com ${caller.author}: você responde a cada mensagem.`,
    reply: () =>
      call.kind === "reply"
        ? `Você decidiu responder você mesma à mensagem de ${caller.author} ${where}. Por quê: ${call.reason}`
        : "",
    delegated: () =>
      call.kind === "delegated"
        ? `${call.by}, a Articuladora, passou para você a mensagem de ${caller.author} ${where}. Cubra isto: ${call.cover}`
        : "",
  }[call.kind]();

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
    ...people.map((p) => `- ${p.name}${p.about ? `: ${p.about}` : ""}`),
    "Agentes:",
    ...team.map((a) => `- ${a.name}${a.id === agent.id ? " (você)" : ""}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");

  const system = [
    preamble,
    section("Contexto do Workspace", await readWorkspaceContext(db)),
    section("Suas instruções", agent.instructions),
    section("Instruções do Canal", conversation!.instructions),
    section("Quem é quem", whoIsWho),
    ...(await articuladoraMap(db, agent, origin, conversation!)),
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

/**
 * A Articuladora conhece o Workspace todo como quem escreveu o vê (ADR 0004): os outros
 * Agentes e os Canais que o autor pode ver, para sugerir em texto quem chamar.
 */
async function articuladoraMap(db: Db, agent: Agent, origin: Origin, conversation: { id: string; kind: string }) {
  if (!agent.builtin || !origin.authorMemberId) return [];
  const map = await workspaceMapFor(db, origin.authorMemberId, conversation.id);
  return [
    section("Outros Agentes do Workspace", map.agents.join("\n")),
    section("Canais que quem escreveu pode ver", map.channels),
  ];
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
export async function recentMessages(db: Db, origin: Origin, n: number) {
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
