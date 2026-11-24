import type { MeDto } from "@shearim/contracts";
import { eq, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { Identity } from "./identity/port";

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
    await tx
      .insert(schema.channels)
      .values({ id: crypto.randomUUID(), name: INITIAL_CHANNEL_NAME, kind: "public", createdAt: now })
      .onConflictDoNothing();
    return admin;
  });
}

export function toMeDto(m: Member): MeDto {
  return { id: m.id, login: m.login, displayName: m.displayName, role: m.role };
}
