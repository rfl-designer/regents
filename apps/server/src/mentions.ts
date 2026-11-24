import { type MentionDto, mentionPattern, normalizeHandle } from "@shearim/contracts";
import { asc, inArray } from "drizzle-orm";
import { type Db, schema } from "./db/client";
import { type HandleOwner, resolveHandles } from "./mention-handles";
import { type Conversation, canSee } from "./participation";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

const { messageMentions } = schema;

/** Os identificadores citados no texto, normalizados, na ordem da primeira aparição. */
export function extractHandles(body: string): string[] {
  const seen = new Set<string>();
  for (const [, name] of body.matchAll(mentionPattern())) seen.add(normalizeHandle(name!));
  return [...seen];
}

/**
 * Quem o texto menciona, Membro ou Agente, na ordem da primeira aparição.
 * É o seam da Menção: as pessoas viram registro aqui (`recordMentions`); os Agentes (#20)
 * são os `kind: "agent"` desta lista, que pulam a Articuladora.
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
 * Registra as Menções a pessoas de uma mensagem recém-gravada. Só conta quem vê a conversa:
 * num Canal privado, citar quem está de fora não o avisa nem lhe mostra nada.
 */
export async function recordMentions(
  tx: Executor,
  messageId: string,
  conversation: Conversation,
  body: string,
): Promise<MentionDto[]> {
  const mentions: MentionDto[] = [];
  for (const owner of await mentionedIn(tx, body)) {
    if (owner.kind === "member" && (await canSee(tx, owner.id, conversation))) {
      mentions.push({ kind: "member", id: owner.id });
    }
  }
  if (mentions.length) {
    await tx.insert(messageMentions).values(mentions.map((m, ordinal) => ({ messageId, memberId: m.id, ordinal })));
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
  for (const r of rows) byMessage.get(r.messageId)?.push({ kind: "member", id: r.memberId });
  return byMessage;
}
