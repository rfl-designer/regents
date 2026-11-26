import { isChannelKind } from "@shearim/contracts";
import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { type Db, isUuid, schema } from "../db/client";
import { participantsOf } from "../participation";
import { viewersOf } from "../viewers";
import type { ToolRun } from "./port";

const { channels, channelParticipants } = schema;

/** Uma conversa dentro do alcance, com o nome que o modelo vê ("#geral", "DM com Ana e Faro"). */
export interface ReachableConversation {
  id: string;
  kind: "public" | "private" | "dm" | "group";
  /** O nome do Canal; nulo numa DM. */
  name: string | null;
  /** Como a conversa aparece para o modelo: `#geral`, ou `DM com Ana e Faro [id …]`. */
  label: string;
}

/** O alcance de uma execução: as conversas que as Ferramentas do Workspace podem ler. */
export interface Reach {
  /** Em ordem de criação. */
  conversations: ReachableConversation[];
  /** A conversa pedida pelo modelo (`#nome`, `nome` de Canal ou id), se está no alcance. */
  find(ref: unknown): ReachableConversation | undefined;
}

/**
 * O alcance de leitura no Workspace (Spec #44): a interseção do que vê cada Membro que vê a
 * conversa da execução, o autor da mensagem de origem incluído. Calculado na hora de cada
 * chamada, com a participação de agora.
 *
 * - Num Canal público, todo Membro vê a conversa: só os Canais públicos entram.
 * - Num Canal privado ou numa DM, entram os Canais públicos e as conversas fechadas de que
 *   todos os participantes (pessoas, sem quem saiu) e o autor participam. Numa DM só entre o
 *   autor e o Agente, isso é tudo o que o autor vê.
 *
 * Os Agentes não contam: participar de uma conversa não abre o alcance a ela. Quem vê a conversa
 * vem de `viewersOf`, a mesma peça do alcance da Wiki.
 */
export async function reachOf(db: Db, run: Pick<ToolRun, "channelId" | "originMessageId">): Promise<Reach> {
  const viewers = await viewersOf(db, run);
  if (!viewers) return reachFrom([]);

  const publicOnly = eq(channels.kind, "public");
  let where = publicOnly;
  if (viewers !== "everyone" && viewers.length) {
    // As conversas em que todos os que veem esta participam.
    const shared = db
      .select({ id: channelParticipants.channelId })
      .from(channelParticipants)
      .where(inArray(channelParticipants.memberId, [...viewers]))
      .groupBy(channelParticipants.channelId)
      .having(sql`count(distinct ${channelParticipants.memberId}) = ${viewers.length}`);
    where = or(publicOnly, inArray(channels.id, shared))!;
  }
  const rows = await db
    .select({ id: channels.id, kind: channels.kind, name: channels.name })
    .from(channels)
    .where(where)
    .orderBy(asc(channels.createdAt), asc(channels.id));
  const dms = rows.filter((r) => !isChannelKind(r.kind));
  const participants = await participantsOf(
    db,
    dms.map((r) => r.id),
  );
  return reachFrom(
    rows.map((r) => ({
      ...r,
      label: isChannelKind(r.kind)
        ? `#${r.name}`
        : `DM com ${(participants.get(r.id) ?? []).map((p) => p.displayName).join(", ")} [id ${r.id}]`,
    })),
  );
}

function reachFrom(conversations: ReachableConversation[]): Reach {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return {
    conversations,
    find(ref) {
      if (typeof ref !== "string") return undefined;
      const text = ref.trim();
      if (isUuid(text)) return byId.get(text);
      const name = text.replace(/^#+/, "").trim().toLowerCase();
      return conversations.find((c) => c.name !== null && c.name.toLowerCase() === name);
    },
  };
}
