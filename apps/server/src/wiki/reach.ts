import type { AgentWikiDto, WikiChannelDto, WikiReachDto, WikiScope } from "@shearim/contracts";
import { and, asc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { type Db, schema, type Tx } from "../db/client";
import { isActive } from "../members";
import { seenBy } from "../participation";
import type { ToolRun } from "../tools/port";
import { type Viewers, viewersOf } from "../viewers";

const { wikis, wikiChannels, wikiAgents, wikiMembers, wikiVersions, channels, members } = schema;

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
 * (a) está ligada ao Canal da conversa ou ao Agente que responde (#84: em qualquer conversa, a DM
 *     inclusive), e
 * (b) tem versão publicada (a nunca sincronizada não tem o que ler), e
 * (c) tem no alcance dela o autor e todos os Membros que veem a conversa.
 *
 * Em (c), quem vê a conversa vem de `viewersOf`, a mesma peça de `reachOf` (`inReachOf`): a
 * ligação ao Agente não abre o alcance. Fora daqui, nenhuma Wiki aparece: nem no catálogo, nem na
 * Ferramenta, nem no Andamento.
 */
export async function wikisInReach(db: Db, answer: Answer): Promise<WikiInReach[]> {
  const viewers = await viewersOf(db, answer);
  if (!viewers) return [];
  return db
    .select({
      id: wikis.id,
      name: wikis.name,
      description: wikis.description,
      versionId: wikiVersions.id,
      versionNumber: wikiVersions.number,
    })
    .from(wikis)
    .innerJoin(wikiVersions, eq(wikiVersions.id, wikis.currentVersionId))
    .where(and(linkedTo(db, answer), isNotNull(wikis.currentVersionId), inReachOf(db, viewers)))
    .orderBy(asc(sql`lower(${wikis.name})`));
}

/** A condição (a), em SQL sobre `wikis`: ligada ao Canal da conversa ou ao Agente que responde. */
function linkedTo(db: Db, answer: Answer): SQL {
  const toChannel = db
    .select({ id: wikiChannels.wikiId })
    .from(wikiChannels)
    .where(eq(wikiChannels.channelId, answer.channelId));
  const toAgent = db.select({ id: wikiAgents.wikiId }).from(wikiAgents).where(eq(wikiAgents.agentId, answer.agentId));
  return or(inArray(wikis.id, toChannel), inArray(wikis.id, toAgent))!;
}

/**
 * A condição "a Wiki tem no alcance todos os que veem a conversa" (ADR 0014), em SQL sobre
 * `wikis`. A pública, sempre. A restrita, só fora do Canal público (onde todo Membro vê) e quando a
 * lista dela tem cada um dos que veem, o autor incluído. Sem ninguém que veja, só a pública: a
 * lista nunca abre por vazio.
 */
function inReachOf(db: Db, viewers: Viewers): SQL {
  const isPublic = eq(wikis.scope, "public");
  if (viewers === "everyone" || viewers.length === 0) return isPublic;
  const listed = db
    .select({ id: wikiMembers.wikiId })
    .from(wikiMembers)
    .where(inArray(wikiMembers.memberId, [...viewers]))
    .groupBy(wikiMembers.wikiId)
    .having(sql`count(distinct ${wikiMembers.memberId}) = ${viewers.length}`);
  return or(isPublic, inArray(wikis.id, listed))!;
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

/**
 * As Wikis na tela do Agente (#84): todas as do Workspace, por nome, com a marca de ligada a ele.
 * O Admin vê toda Wiki na administração, mesmo a restrita a uma lista sem ele.
 */
export async function agentWikisOf(db: Db, agentId: string): Promise<AgentWikiDto[]> {
  const rows = await db
    .select({
      id: wikis.id,
      name: wikis.name,
      description: wikis.description,
      scope: wikis.scope,
      linkedAt: wikiAgents.linkedAt,
    })
    .from(wikis)
    .leftJoin(wikiAgents, and(eq(wikiAgents.wikiId, wikis.id), eq(wikiAgents.agentId, agentId)))
    .orderBy(asc(sql`lower(${wikis.name})`));
  return rows.map(({ linkedAt, ...w }) => ({ ...w, linked: linkedAt !== null }));
}

/** Liga a Wiki ao Agente, na transação que travou o Agente vivo (`lockLiveAgent`). */
export async function linkWikiToAgent(tx: Tx, wikiId: string, agentId: string, now: Date) {
  await tx.insert(wikiAgents).values({ wikiId, agentId, linkedAt: now }).onConflictDoNothing();
}

export async function unlinkWikiFromAgent(db: Db, wikiId: string, agentId: string) {
  await db.delete(wikiAgents).where(and(eq(wikiAgents.wikiId, wikiId), eq(wikiAgents.agentId, agentId)));
}

/** O Agente apagado leva as ligações dele a Wikis (no `DELETE /api/agents/:id`). */
export async function leaveAgentWikis(tx: Tx, agentId: string) {
  await tx.delete(wikiAgents).where(eq(wikiAgents.agentId, agentId));
}

/** Se o Membro está na lista da Wiki (o alcance de leitura da restrita). */
export async function inWikiList(db: Db, wikiId: string, memberId: string) {
  const [row] = await db
    .select({ id: wikiMembers.memberId })
    .from(wikiMembers)
    .where(and(eq(wikiMembers.wikiId, wikiId), eq(wikiMembers.memberId, memberId)));
  return row !== undefined;
}

/** Os ids dos Membros ativos na lista da Wiki. */
export async function wikiListIds(db: Db, wikiId: string): Promise<string[]> {
  const rows = await db
    .select({ id: wikiMembers.memberId })
    .from(wikiMembers)
    .innerJoin(members, eq(members.id, wikiMembers.memberId))
    .where(and(eq(wikiMembers.wikiId, wikiId), isActive));
  return rows.map((r) => r.id);
}

/** A tela do alcance (#83): o escopo e os Membros ativos, por nome, com a marca de quem está na lista. */
export async function wikiReachFor(db: Db, wiki: { id: string; scope: WikiScope }): Promise<WikiReachDto> {
  const rows = await db
    .select({ id: members.id, name: members.displayName, listedAt: wikiMembers.addedAt })
    .from(members)
    .leftJoin(wikiMembers, and(eq(wikiMembers.memberId, members.id), eq(wikiMembers.wikiId, wiki.id)))
    .where(isActive)
    .orderBy(asc(members.displayName), asc(members.id));
  return {
    scope: wiki.scope,
    members: rows.map((r) => ({ id: r.id, name: r.name, inList: r.listedAt !== null })),
  };
}

/**
 * Os ids que não são de Membros ativos (para recusar a lista com o motivo). Vazio: todos servem.
 */
export async function unknownMembers(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await db
    .select({ id: members.id })
    .from(members)
    .where(and(inArray(members.id, [...ids]), isActive));
  const known = new Set(found.map((m) => m.id));
  return ids.filter((id) => !known.has(id));
}

/** Troca o alcance e a lista inteira da Wiki, numa transação. Vale na próxima resposta. */
export async function setWikiReach(
  db: Db,
  wikiId: string,
  input: { scope: WikiScope; memberIds: readonly string[]; now: Date },
) {
  await db.transaction(async (tx) => {
    await tx.update(wikis).set({ scope: input.scope }).where(eq(wikis.id, wikiId));
    await tx.delete(wikiMembers).where(eq(wikiMembers.wikiId, wikiId));
    if (input.memberIds.length) {
      await tx
        .insert(wikiMembers)
        .values([...new Set(input.memberIds)].map((memberId) => ({ wikiId, memberId, addedAt: input.now })));
    }
  });
}

/** Quem sai do Workspace sai de toda lista de Wiki: se voltar, volta fora delas. */
export async function leaveWikiLists(tx: Tx, memberId: string) {
  await tx.delete(wikiMembers).where(eq(wikiMembers.memberId, memberId));
}
