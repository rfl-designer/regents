import type { WikiChannelDto } from "@shearim/contracts";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type Db, schema } from "../db/client";
import { seenBy } from "../participation";
import type { ToolRun } from "../tools/port";

const { wikis, wikiChannels, wikiVersions, channels } = schema;

/** Uma Wiki que alcança a resposta, com a versão atual (a que ela lê). */
export interface WikiInReach {
  id: string;
  name: string;
  description: string;
  versionId: string;
  versionNumber: number;
}

/** A resposta: a conversa (o Canal, a DM ou a de uma Thread), a mensagem de origem e o Agente. */
export type Answer = Pick<ToolRun, "channelId" | "originMessageId" | "agentId">;

/**
 * As Wikis que alcançam a resposta (spec #74, ADR 0014), por nome, calculadas na hora: na montagem
 * do contexto e em cada chamada de "ler a Wiki". Entra uma Wiki que
 * (a) está ligada ao Canal da conversa, e
 * (b) tem versão publicada (a nunca sincronizada não tem o que ler), e
 * (c) tem no alcance dela o autor e todos os Membros que veem a conversa.
 *
 * Hoje (#81) só a Wiki pública passa em (c): todo Membro está no alcance dela. A restrita (#83)
 * entra quando a lista dela contém todos os que veem a conversa (a mesma peça de `reachOf`), e a
 * ligação a Agentes (#84) entra em (a), com `answer.agentId`. Fora daqui, nenhuma Wiki aparece:
 * nem no catálogo, nem na Ferramenta, nem no Andamento.
 */
export async function wikisInReach(db: Db, answer: Answer): Promise<WikiInReach[]> {
  return db
    .select({
      id: wikis.id,
      name: wikis.name,
      description: wikis.description,
      versionId: wikiVersions.id,
      versionNumber: wikiVersions.number,
    })
    .from(wikiChannels)
    .innerJoin(wikis, eq(wikis.id, wikiChannels.wikiId))
    .innerJoin(wikiVersions, eq(wikiVersions.id, wikis.currentVersionId))
    .where(
      and(eq(wikiChannels.channelId, answer.channelId), eq(wikis.scope, "public"), isNotNull(wikis.currentVersionId)),
    )
    .orderBy(asc(sql`lower(${wikis.name})`));
}

/** A Wiki com este nome (sem diferenciar maiúsculas), se ela alcança a resposta. */
export async function wikiInReachNamed(db: Db, answer: Answer, name: string) {
  const wanted = name.trim().toLowerCase();
  return (await wikisInReach(db, answer)).find((w) => w.name.toLowerCase() === wanted);
}

/**
 * Os Canais na tela de ligações da Wiki (#81): os que o Admin vê (os públicos e os privados de que
 * ele participa), por nome, com a marca de ligado. Um Canal privado fora dele não aparece, nem pelo
 * nome: ser Admin não dá leitura das conversas.
 */
export async function wikiChannelsFor(db: Db, wikiId: string, adminId: string): Promise<WikiChannelDto[]> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, kind: channels.kind, linkedAt: wikiChannels.linkedAt })
    .from(channels)
    .leftJoin(wikiChannels, and(eq(wikiChannels.channelId, channels.id), eq(wikiChannels.wikiId, wikiId)))
    .where(and(sql`${channels.kind} in ('public', 'private')`, seenBy(db, adminId, channels.id)))
    .orderBy(asc(sql`lower(${channels.name})`));
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    kind: r.kind as WikiChannelDto["kind"],
    linked: r.linkedAt !== null,
  }));
}

/** O Canal `channelId`, se é um Canal que o Admin vê (para ligar ou desligar a Wiki). */
export async function channelForLink(db: Db, channelId: string, adminId: string) {
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(eq(channels.id, channelId), sql`${channels.kind} in ('public', 'private')`, seenBy(db, adminId, channels.id)),
    );
  return row;
}

export async function linkWikiToChannel(db: Db, wikiId: string, channelId: string, now: Date) {
  await db.insert(wikiChannels).values({ wikiId, channelId, linkedAt: now }).onConflictDoNothing();
}

export async function unlinkWikiFromChannel(db: Db, wikiId: string, channelId: string) {
  await db.delete(wikiChannels).where(and(eq(wikiChannels.wikiId, wikiId), eq(wikiChannels.channelId, channelId)));
}
