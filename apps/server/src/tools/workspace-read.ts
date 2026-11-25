import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";
import { isActive } from "../members";
import { type ToolDefinition, ToolFailure } from "./port";
import { type ReachableConversation, reachOf } from "./reach";

const { messages, members, agents, channelParticipants, mentionHandles } = schema;

/**
 * O motivo quando a conversa pedida não existe ou está fora do alcance: o mesmo nos dois casos,
 * e sem repetir o nome pedido, para que nada de fora do alcance apareça nem pelo nome (nem no
 * Andamento, que mostra o motivo a todos da conversa).
 */
const NOT_IN_REACH = "não achei essa conversa entre as que esta resposta alcança";

/** Até quantas mensagens uma busca devolve. */
const SEARCH_LIMIT = 20;
/** Até quantos caracteres de cada mensagem entram num resultado de busca. */
const SEARCH_BODY_MAX = 500;

type MessageLine = {
  id: string;
  channelId: string;
  threadRootId: string | null;
  body: string;
  createdAt: Date;
  memberName: string | null;
  agentName: string | null;
};

function selectLines(db: Db) {
  return db
    .select({
      id: messages.id,
      seq: messages.seq,
      channelId: messages.channelId,
      threadRootId: messages.threadRootId,
      body: messages.body,
      createdAt: messages.createdAt,
      memberName: members.displayName,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId));
}

const when = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const author = (m: MessageLine) => (m.agentName ? `${m.agentName} (Agente)` : `${m.memberName ?? "Alguém"} (pessoa)`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** `%` e `_` do texto pedido valem como eles mesmos no `ilike`. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Onde a Ferramenta busca ou lê, para o rótulo do Andamento ("em #produto", "na DM com Ana, Bruno"):
 * só uma conversa do alcance, que todos que veem o Andamento também veem.
 */
const where = (c: ReachableConversation) =>
  c.name !== null ? { at: `em #${c.name}`, it: `#${c.name}` } : { at: `na ${dmName(c)}`, it: `a ${dmName(c)}` };
const dmName = (c: ReachableConversation) => c.label.replace(/ \[id [^\]]+\]$/, "");

const input = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/** Uma data do modelo (`AAAA-MM-DD` ou ISO completo); `endOfDay` faz a data simples valer o dia todo. */
function dateArg(raw: unknown, field: string, endOfDay = false): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const at = new Date(dayOnly ? `${text}T00:00:00.000Z` : text);
  if (!text || Number.isNaN(at.getTime())) throw new ToolFailure(`a data em ${field} não é válida (use AAAA-MM-DD)`);
  return dayOnly && endOfDay ? new Date(at.getTime() + 24 * 60 * 60 * 1000) : at;
}

/**
 * Buscar mensagens: por texto, com conversa, autor e período opcionais, nas conversas do alcance.
 * As mais recentes primeiro, cada uma com a conversa, o autor, a hora e o id (para abrir a Thread).
 */
const searchMessages: ToolDefinition = {
  id: "buscar_mensagens",
  title: "buscar mensagens",
  label: "buscando mensagens",
  async describe({ db, run }, raw) {
    const { conversa } = input(raw);
    const one = conversa ? (await reachOf(db, run)).find(conversa) : undefined;
    return one ? { label: `buscando ${where(one).at}` } : {};
  },
  description:
    "Busca mensagens do Workspace por texto, nas conversas que esta resposta alcança. Opcionalmente numa conversa (#canal ou o id de uma DM), de um autor (nome) ou num período (desde/ate, AAAA-MM-DD). Devolve as mais recentes primeiro.",
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: {
      texto: { type: "string", description: "O texto a buscar." },
      conversa: { type: "string", description: "Só nesta conversa: #canal ou o id de uma DM." },
      autor: { type: "string", description: "Só deste autor (nome de pessoa ou de Agente)." },
      desde: { type: "string", description: "Só a partir deste dia (AAAA-MM-DD)." },
      ate: { type: "string", description: "Só até este dia, inclusive (AAAA-MM-DD)." },
    },
    required: ["texto"],
    additionalProperties: false,
  },
  async run({ db, run }, raw) {
    const args = input(raw);
    const text = typeof args.texto === "string" ? args.texto.trim() : "";
    if (!text) throw new ToolFailure("diga o texto a buscar");
    const since = dateArg(args.desde, "desde");
    const until = dateArg(args.ate, "ate", true);
    const reach = await reachOf(db, run);
    let scope: ReachableConversation[] = reach.conversations;
    if (args.conversa !== undefined && args.conversa !== null && args.conversa !== "") {
      const one = reach.find(args.conversa);
      if (!one) throw new ToolFailure(NOT_IN_REACH);
      scope = [one];
    }
    if (scope.length === 0) return "Nenhuma mensagem encontrada.";
    const where: SQL[] = [
      inArray(
        messages.channelId,
        scope.map((c) => c.id),
      ),
      ilike(messages.body, `%${likeEscape(text)}%`),
    ];
    if (since) where.push(gte(messages.createdAt, since));
    if (until) where.push(lt(messages.createdAt, until));
    if (typeof args.autor === "string" && args.autor.trim()) {
      const who = `%${likeEscape(args.autor.trim().replace(/^@/, ""))}%`;
      where.push(or(ilike(members.displayName, who), ilike(agents.name, who))!);
    }
    const found = await selectLines(db)
      .where(and(...where))
      .orderBy(desc(messages.seq))
      .limit(SEARCH_LIMIT);
    if (found.length === 0) return "Nenhuma mensagem encontrada.";
    const labels = new Map(scope.map((c) => [c.id, c.label]));
    return [
      `${found.length} ${found.length === 1 ? "mensagem" : "mensagens"}, das mais recentes para as mais antigas${found.length === SEARCH_LIMIT ? ` (só as ${SEARCH_LIMIT} mais recentes: refine a busca para ver outras)` : ""}:`,
      ...found.map(
        (m) =>
          `- [mensagem ${m.id}] ${labels.get(m.channelId)}${m.threadRootId ? `, na Thread de ${m.threadRootId}` : ""}, ${author(m)}, ${when(m.createdAt)}: ${clip(m.body, SEARCH_BODY_MAX)}`,
      ),
    ].join("\n");
  },
};

/** Quantas mensagens abrir uma conversa devolve de cada vez. */
const OPEN_PAGE = 30;
/** Até quantos caracteres de cada mensagem entram ao abrir uma conversa. */
const OPEN_BODY_MAX = 2_000;

/**
 * Abrir uma conversa ou Thread: as mensagens que ficaram para trás, com o mesmo alcance.
 * - No fluxo (ou na Thread) em que o Agente foi chamado, começa antes das últimas N, que ele já
 *   recebeu no contexto. Em outro, das mais recentes.
 * - `antes_de` volta mais, a partir de uma mensagem.
 * Um Canal ou uma DM abre o fluxo principal, com a contagem de respostas de cada Thread; uma
 * Thread abre a raiz e as respostas.
 */
const openConversation: ToolDefinition = {
  id: "abrir_conversa",
  title: "abrir conversa",
  label: "lendo a conversa",
  async describe({ db, run }, raw) {
    const { conversa, thread } = input(raw);
    const reach = await reachOf(db, run);
    if (typeof thread === "string" && isUuid(thread.trim())) {
      const [picked] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, thread.trim()));
      const one = picked ? reach.find(picked.channelId) : undefined;
      return one ? { label: `lendo uma Thread ${where(one).at}` } : {};
    }
    const one = conversa ? reach.find(conversa) : undefined;
    return one ? { label: `lendo ${where(one).it}` } : {};
  },
  description: `Abre uma conversa (#canal ou o id de uma DM) ou uma Thread (o id da mensagem que a abriu) e devolve até ${OPEN_PAGE} mensagens, da mais antiga para a mais nova. Na conversa em que você foi chamado, começa antes das mensagens recentes que você já recebeu. Para voltar mais, passe antes_de com o id da mensagem mais antiga que você tem.`,
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: {
      conversa: { type: "string", description: "A conversa: #canal ou o id de uma DM." },
      thread: { type: "string", description: "O id da mensagem que abriu a Thread." },
      antes_de: { type: "string", description: "Só as mensagens anteriores a esta (o id dela)." },
    },
    additionalProperties: false,
  },
  async run({ db, run }, raw) {
    const args = input(raw);
    const reach = await reachOf(db, run);
    const ref = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const threadRef = ref(args.thread);
    const conversationRef = ref(args.conversa);
    if (!threadRef && !conversationRef) throw new ToolFailure("diga a conversa ou a Thread a abrir");

    let conversation: ReachableConversation | undefined;
    let rootId: string | null = null;
    if (threadRef) {
      const [picked] = isUuid(threadRef)
        ? await db
            .select({ id: messages.id, channelId: messages.channelId, threadRootId: messages.threadRootId })
            .from(messages)
            .where(eq(messages.id, threadRef))
        : [];
      // Uma resposta de Thread também serve: abre a Thread dela.
      rootId = picked ? (picked.threadRootId ?? picked.id) : null;
      conversation = picked ? reach.find(picked.channelId) : undefined;
      if (conversation && conversationRef && reach.find(conversationRef)?.id !== conversation.id)
        conversation = undefined;
    } else {
      conversation = reach.find(conversationRef);
    }
    if (!conversation) throw new ToolFailure(NOT_IN_REACH);

    const flow = rootId
      ? eq(messages.threadRootId, rootId)
      : and(eq(messages.channelId, conversation.id), isNull(messages.threadRootId));
    const [origin] = await db
      .select({ seq: messages.seq, channelId: messages.channelId, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, run.originMessageId));
    let before: number | undefined;
    const beforeRef = ref(args.antes_de);
    if (beforeRef) {
      const [mark] = isUuid(beforeRef)
        ? await db
            .select({ seq: messages.seq })
            .from(messages)
            .where(and(eq(messages.id, beforeRef), flow))
        : [];
      if (!mark) throw new ToolFailure("a mensagem de antes_de não é desta conversa ou Thread");
      before = mark.seq;
    } else if (
      origin &&
      (rootId ? origin.threadRootId === rootId : origin.channelId === conversation.id && origin.threadRootId === null)
    ) {
      // As últimas N até a de origem já estão no contexto (`recentMessages` em `context.ts`).
      const [settings] = await db
        .select({ n: schema.channels.recentMessages })
        .from(schema.channels)
        .where(eq(schema.channels.id, conversation.id));
      const seen = await db
        .select({ seq: messages.seq })
        .from(messages)
        .where(and(flow, lt(messages.seq, origin.seq)))
        .orderBy(desc(messages.seq))
        .limit(settings?.n ?? 0);
      before = seen.at(-1)?.seq ?? origin.seq;
    }

    const page = (
      await selectLines(db)
        .where(and(flow, before === undefined ? undefined : lt(messages.seq, before)))
        .orderBy(desc(messages.seq))
        .limit(OPEN_PAGE + 1)
    ).reverse();
    const more = page.length > OPEN_PAGE;
    if (more) page.shift();
    const replies = new Map<string, number>();
    if (!rootId && page.length) {
      const counts = await db
        .select({ root: messages.threadRootId, n: count() })
        .from(messages)
        .where(
          inArray(
            messages.threadRootId,
            page.map((m) => m.id),
          ),
        )
        .groupBy(messages.threadRootId);
      for (const c of counts) replies.set(c.root!, c.n);
    }
    const line = (m: MessageLine) => {
      const n = replies.get(m.id);
      return `- [mensagem ${m.id}] ${author(m)}, ${when(m.createdAt)}: ${clip(m.body, OPEN_BODY_MAX)}${n ? ` (Thread: ${n} ${n === 1 ? "resposta" : "respostas"})` : ""}`;
    };

    const out: string[] = [];
    if (rootId) {
      const [root] = await selectLines(db).where(eq(messages.id, rootId));
      out.push(`Thread em ${conversation.label}. A mensagem que abriu a Thread:`, line(root!), "Respostas:");
    } else {
      out.push(`${conversation.label}, fluxo principal:`);
    }
    if (page.length === 0) {
      out.push(before !== undefined ? "Nenhuma mensagem antes dessas." : "Nenhuma mensagem.");
    } else {
      out.push(...page.map(line));
      if (more) out.push(`Há mensagens mais antigas: chame de novo com antes_de = ${page[0]!.id}.`);
    }
    return out.join("\n");
  },
};

/** Listar Canais: os Canais do alcance, públicos e privados (as DMs não são Canais). */
const listChannels: ToolDefinition = {
  id: "listar_canais",
  title: "listar Canais",
  label: "listando os Canais",
  description: "Lista os Canais do Workspace que esta resposta alcança, cada um com o nome e se é público ou privado.",
  origin: "workspace",
  access: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run({ db, run }) {
    const found = (await reachOf(db, run)).conversations.filter((c) => c.kind === "public" || c.kind === "private");
    if (found.length === 0) return "Nenhum Canal.";
    return found.map((c) => `- ${c.label} (${c.kind === "public" ? "público" : "privado"})`).join("\n");
  },
};

/**
 * Listar Membros: todo Membro vê os Membros do Workspace (`GET /api/members`), então a lista toda
 * não tem o que cortar. Os de uma conversa, só se ela está no alcance (quem está num Canal
 * privado é dele).
 */
const listMembers: ToolDefinition = {
  id: "listar_membros",
  title: "listar Membros",
  label: "listando os Membros",
  description:
    'Lista os Membros do Workspace (pessoas), com o identificador de Menção e o "sobre mim". Com conversa (#canal ou o id de uma DM), só quem participa dela.',
  origin: "workspace",
  access: "read",
  inputSchema: {
    type: "object",
    properties: {
      conversa: { type: "string", description: "Só quem participa desta conversa: #canal ou o id de uma DM." },
    },
    additionalProperties: false,
  },
  async run({ db, run }, raw) {
    const args = input(raw);
    const where: SQL[] = [isActive];
    let header = "Membros do Workspace:";
    if (typeof args.conversa === "string" && args.conversa.trim()) {
      const conversation = (await reachOf(db, run)).find(args.conversa);
      if (!conversation) throw new ToolFailure(NOT_IN_REACH);
      where.push(
        inArray(
          members.id,
          db
            .select({ id: channelParticipants.memberId })
            .from(channelParticipants)
            .where(eq(channelParticipants.channelId, conversation.id)),
        ),
      );
      header = `Quem participa de ${conversation.label}:`;
    }
    const rows = await db
      .select({ name: members.displayName, about: members.about, role: members.role, handle: mentionHandles.handle })
      .from(members)
      .leftJoin(mentionHandles, eq(mentionHandles.memberId, members.id))
      .where(and(...where))
      .orderBy(asc(members.displayName), asc(members.id));
    if (rows.length === 0) return `${header}\nninguém.`;
    return [
      header,
      ...rows.map(
        (m) =>
          `- ${m.name}${m.handle ? ` (@${m.handle})` : ""}${m.role === "admin" ? ", Admin" : ""}${m.about ? `: ${m.about}` : ""}`,
      ),
    ].join("\n");
  },
};

/** As Ferramentas de leitura do Workspace com alcance (#47). */
export const WORKSPACE_READ_TOOLS: readonly ToolDefinition[] = [
  searchMessages,
  openConversation,
  listChannels,
  listMembers,
];
