import type { MeDto, MemberSummaryDto } from "@shearim/contracts";
import { asc, eq, getTableColumns, isNull, type SQL, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Identity } from "./identity/port";
import { claimHandle, handleBase } from "./mention-handles";
import { addParticipants } from "./participation";

/** O Membro com o identificador de Menção dele (que mora no espaço de nomes compartilhado). */
export type Member = typeof schema.members.$inferSelect & { handle: string };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

const { members, mentionHandles } = schema;

/** Nome do Canal público que nasce com o Workspace (escolha do ticket #15). */
export const INITIAL_CHANNEL_NAME = "geral";

/** Os Membros que atendem a `where`, já com o identificador. */
export function selectMembers(db: Executor, where?: SQL) {
  return db
    .select({ ...getTableColumns(members), handle: mentionHandles.handle })
    .from(members)
    .innerJoin(mentionHandles, eq(mentionHandles.memberId, members.id))
    .where(where);
}

/** Quem ainda é Membro: o removido ("saiu do Workspace") fica de fora até voltar. */
export const isActive = isNull(members.leftAt);

/** Um Membro pelo id (inclusive quem saiu do Workspace: as mensagens continuam dele). */
export async function memberById(db: Executor, id: string): Promise<Member | undefined> {
  const [found] = await selectMembers(db, eq(members.id, id));
  return found;
}

/**
 * Cria o Membro com o que a tailnet disse na primeira entrada: nome e foto, e o
 * identificador de Menção gerado a partir do nome (com sufixo se colidir).
 * Depois disso, nada da tailnet é regravado: o nome é do Membro.
 */
export async function createMember(
  tx: Tx,
  from: { tailnetUserId: string; login: string; displayName: string; profilePicUrl: string | null },
  role: Member["role"],
  at: Date,
): Promise<Member> {
  const [row] = await tx
    .insert(members)
    .values({ id: crypto.randomUUID(), ...from, role, createdAt: at })
    .returning();
  const handle = await claimHandle(
    tx,
    { kind: "member", id: row!.id },
    handleBase(from.displayName, from.login.split("@")[0] ?? ""),
  );
  return { ...row!, handle };
}

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
  const [found] = await selectMembers(db, eq(members.tailnetUserId, who.userId));
  // Quem foi removido não é Membro: volta só pelo Pedido de entrada.
  if (found) return found.leftAt ? undefined : found;

  return db.transaction(async (tx) => {
    // Serializa a entrada: só um primeiro Admin, mesmo com chegadas simultâneas.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shearim:entrada'))`);
    const [again] = await selectMembers(tx, eq(members.tailnetUserId, who.userId));
    if (again) return again;
    const [anyone] = await tx.select({ id: members.id }).from(members).limit(1);
    if (anyone) return undefined;

    const now = clock.now();
    const admin = await createMember(
      tx,
      {
        tailnetUserId: who.userId,
        login: who.login,
        displayName: who.displayName,
        profilePicUrl: who.profilePicUrl ?? null,
      },
      "admin",
      now,
    );
    const [initial] = await tx
      .insert(schema.channels)
      .values({ id: crypto.randomUUID(), name: INITIAL_CHANNEL_NAME, kind: "public", createdAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.channels.id });
    if (initial) await addParticipants(tx, initial.id, [admin.id], now);
    return admin;
  });
}

export function toMeDto(m: Member): MeDto {
  return {
    id: m.id,
    login: m.login,
    displayName: m.displayName,
    handle: m.handle,
    profilePicUrl: m.profilePicUrl,
    about: m.about,
    role: m.role,
  };
}

export function toMemberDto(m: Member): MemberSummaryDto {
  return {
    id: m.id,
    displayName: m.displayName,
    handle: m.handle,
    profilePicUrl: m.profilePicUrl,
    about: m.about,
    role: m.role,
  };
}

/** Os Membros do Workspace, por nome: quem se pode adicionar a uma conversa e quem é quem. Sem quem saiu. */
export async function listMembers(db: Db): Promise<MemberSummaryDto[]> {
  const rows = await selectMembers(db, isActive).orderBy(asc(members.displayName), asc(members.id));
  return rows.map(toMemberDto);
}
