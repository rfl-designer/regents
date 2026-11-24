import { type MentionDto, mentionPattern, normalizeHandle } from "@shearim/contracts";
import { asc, inArray } from "drizzle-orm";
import { type Db, schema, type Tx } from "./db/client";
import { type HandleOwner, resolveHandles } from "./mention-handles";
import { type Conversation, canSee } from "./participation";

type Executor = Db | Tx;

const { messageMentions } = schema;

/** Os identificadores citados no texto, normalizados, na ordem da primeira aparição. */
export function extractHandles(body: string): string[] {
  const seen = new Set<string>();
  for (const [, name] of body.matchAll(mentionPattern())) seen.add(normalizeHandle(name!));
  return [...seen];
}

/**
 * Quem o texto menciona, Membro ou Agente, na ordem da primeira aparição, pelo identificador
 * de Menção (`mention_handles`, um espaço de nomes só para as duas espécies).
 */
export async function mentionedIn(db: Executor, body: string): Promise<HandleOwner[]> {
  const handles = extractHandles(body);
  const owners = await resolveHandles(db, handles);
  const found: HandleOwner[] = [];
  for (const h of handles) {
    const owner = owners.get(h);
    if (owner && !found.some((o) => o.kind === owner.kind && o.id === owner.id)) found.push(owner);
  }
  return found;
}

/**
 * Registra as Menções de uma mensagem recém-gravada, na ordem do texto. A pessoa só conta se
 * vê a conversa: num Canal privado, citar quem está de fora não o avisa nem lhe mostra nada.
 * O Agente citado conta sempre; é a Menção que o faz responder (quem chama decide onde).
 */
export async function recordMentions(
  tx: Executor,
  messageId: string,
  conversation: Conversation,
  body: string,
): Promise<MentionDto[]> {
  const mentions: MentionDto[] = [];
  for (const owner of await mentionedIn(tx, body)) {
    if (owner.kind === "agent" || (await canSee(tx, owner.id, conversation))) mentions.push(owner);
  }
  if (mentions.length) {
    await tx.insert(messageMentions).values(
      mentions.map((m, ordinal) => ({
        messageId,
        ordinal,
        ...(m.kind === "member" ? { memberId: m.id } : { agentId: m.id }),
      })),
    );
  }
  return mentions;
}

/** As Menções de cada mensagem pedida. */
export async function mentionsOf(db: Executor, messageIds: readonly string[]): Promise<Map<string, MentionDto[]>> {
  const byMessage = new Map<string, MentionDto[]>(messageIds.map((id) => [id, []]));
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select()
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, [...messageIds]))
    .orderBy(asc(messageMentions.ordinal));
  for (const r of rows) {
    const mention: MentionDto = r.memberId ? { kind: "member", id: r.memberId } : { kind: "agent", id: r.agentId! };
    byMessage.get(r.messageId)?.push(mention);
  }
  return byMessage;
}
