import type { MeDto, MemberSummaryDto } from "@shearim/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Identity } from "./identity/port";
import { addParticipants } from "./participation";

export type Member = typeof schema.members.$inferSelect;

/** Nome do Canal público que nasce com o Workspace (escolha do ticket #15). */
export const INITIAL_CHANNEL_NAME = "geral";

/**
 * Acha o Membro de uma identidade da tailnet, pelo `UserProfile.ID`.
 * Numa Instalação vazia, a primeira identidade vira Admin, sem Pedido de entrada,
 * e o Workspace ganha o Canal público inicial. Fora isso, quem não é Membro fica sem.
 */
export async function memberFor(
  db: Db,
  clock: Clock,
  who: Extract<Identity, { kind: "user" }>,
): Promise<Member | undefined> {
  const [found] = await db.select().from(schema.members).where(eq(schema.members.tailnetUserId, who.userId));
  if (found) return found;

  return db.transaction(async (tx) => {
    // Serializa a entrada: só um primeiro Admin, mesmo com chegadas simultâneas.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shearim:entrada'))`);
    const [again] = await tx.select().from(schema.members).where(eq(schema.members.tailnetUserId, who.userId));
    if (again) return again;
    const [anyone] = await tx.select({ id: schema.members.id }).from(schema.members).limit(1);
    if (anyone) return undefined;

    const now = clock.now();
    const [admin] = await tx
      .insert(schema.members)
      .values({
        id: crypto.randomUUID(),
        tailnetUserId: who.userId,
        login: who.login,
        displayName: who.displayName,
        role: "admin",
        createdAt: now,
      })
      .returning();
    const [initial] = await tx
      .insert(schema.channels)
      .values({ id: crypto.randomUUID(), name: INITIAL_CHANNEL_NAME, kind: "public", createdAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.channels.id });
    if (initial) await addParticipants(tx, initial.id, [admin!.id], now);
    return admin;
  });
}

export function toMeDto(m: Member): MeDto {
  return { id: m.id, login: m.login, displayName: m.displayName, role: m.role };
}

/** Os Membros do Workspace, por nome: quem se pode adicionar a uma conversa. */
export async function listMembers(db: Db): Promise<MemberSummaryDto[]> {
  return db
    .select({ id: schema.members.id, displayName: schema.members.displayName })
    .from(schema.members)
    .orderBy(asc(schema.members.displayName), asc(schema.members.id));
}

/** Tamanho máximo do "sobre mim". */
export const ABOUT_ME_MAX = 500;

/**
 * "Sobre mim" do próprio Membro (campo mínimo do #21; o perfil completo é do #19).
 * Devolve o que ficou gravado, ou o erro em pt-BR.
 */
export async function setAboutMe(
  db: Db,
  memberId: string,
  input: unknown,
): Promise<{ aboutMe: string } | { error: string }> {
  if (typeof input !== "string") return { error: 'O "sobre mim" é um texto.' };
  if (input.length > ABOUT_ME_MAX) return { error: `O "sobre mim" tem no máximo ${ABOUT_ME_MAX} caracteres.` };
  const aboutMe = input.trim();
  await db.update(schema.members).set({ aboutMe }).where(eq(schema.members.id, memberId));
  return { aboutMe };
}
