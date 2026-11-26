import { normalizeHandle } from "@regents/contracts";
import { eq, inArray } from "drizzle-orm";
import { type Db, schema } from "./db/client";

/**
 * O espaço de nomes dos identificadores de Menção (Spec, módulo 2): um só para Membros e
 * Agentes. `@rafael` é de exatamente um participante do Workspace, pessoa ou Agente.
 *
 * A tabela `mention_handles` é a autoridade: a chave primária é o identificador, e cada
 * linha tem um dono (`member_id` ou `agent_id`, um só). A unicidade entre as duas espécies
 * vem do banco, sem lock. Quem cria um participante pede o identificador aqui, dentro da
 * mesma transação: o Membro na entrada (`members.ts`, `join-requests.ts`); o Agente (#20)
 * ao ser criado, com `claimHandle(tx, { kind: "agent", id }, nome)`. O Agente apagado (#65)
 * devolve o dele com `releaseHandle`.
 */
export type HandleOwner = { kind: "member"; id: string } | { kind: "agent"; id: string };

type Executor = Pick<Db, "select" | "insert" | "delete">;

const { mentionHandles } = schema;

export const HANDLE_MAX = 32;
/** Só letras sem acento, números e `_`: o que cabe depois do `@` sem ambiguidade com pontuação. */
const HANDLE = /^[a-z0-9_]+$/;

/** O identificador que o Membro digitou, normalizado, ou `undefined` se não serve. */
export function parseHandle(text: string): string | undefined {
  const handle = normalizeHandle(text);
  return handle.length > 0 && handle.length <= HANDLE_MAX && HANDLE.test(handle) ? handle : undefined;
}

/**
 * A base de um identificador gerado: a primeira palavra do nome que tenha letra ou número
 * ("Rafael Oliveira" → `rafael`, "João" → `joao`), senão os `fallbacks` (ex.: o login antes
 * do `@`), senão `pessoa`. Fica com folga para o sufixo.
 */
export function handleBase(name: string, ...fallbacks: string[]) {
  const candidates = [name.split(/\s+/)[0] ?? "", ...fallbacks];
  for (const text of candidates) {
    const base = normalizeHandle(text).replace(/[^a-z0-9_]/g, "");
    if (base) return base.slice(0, HANDLE_MAX - 4);
  }
  return "pessoa";
}

function ownerColumns(owner: HandleOwner) {
  return owner.kind === "member" ? { memberId: owner.id } : { agentId: owner.id };
}

function ownerIs(owner: HandleOwner) {
  return owner.kind === "member" ? eq(mentionHandles.memberId, owner.id) : eq(mentionHandles.agentId, owner.id);
}

/**
 * Dá ao dono o primeiro identificador livre a partir de `base`: `base`, `base2`, `base3`…
 * Chame dentro da transação que cria o dono. Devolve o identificador.
 */
export async function claimHandle(tx: Executor, owner: HandleOwner, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const handle = n === 1 ? base : `${base}${n}`;
    const [claimed] = await tx
      .insert(mentionHandles)
      .values({ handle, ...ownerColumns(owner) })
      .onConflictDoNothing()
      .returning({ handle: mentionHandles.handle });
    if (claimed) return claimed.handle;
  }
}

/**
 * Troca o identificador do dono por `handle` (já validado com `parseHandle`).
 * `taken` quando é de outro participante; trocar pelo próprio é `ok`.
 * Chame dentro de uma transação: o antigo sai antes de o novo entrar.
 */
export async function changeHandle(
  tx: Executor,
  owner: HandleOwner,
  handle: string,
): Promise<{ ok: true } | { ok: false; reason: "taken" }> {
  const [current] = await tx.select().from(mentionHandles).where(ownerIs(owner));
  if (current?.handle === handle) return { ok: true };
  await tx.delete(mentionHandles).where(ownerIs(owner));
  const [claimed] = await tx
    .insert(mentionHandles)
    .values({ handle, ...ownerColumns(owner) })
    .onConflictDoNothing()
    .returning({ handle: mentionHandles.handle });
  return claimed ? { ok: true } : { ok: false, reason: "taken" };
}

/**
 * Tira o identificador do dono: ele volta a ficar livre (o Agente renomeado, antes de pedir o do
 * nome novo, e o Agente apagado, #65). Chame dentro da transação que muda o dono.
 */
export async function releaseHandle(tx: Executor, owner: HandleOwner): Promise<void> {
  await tx.delete(mentionHandles).where(ownerIs(owner));
}

/** De quem é cada identificador pedido (os que não são de ninguém ficam de fora). */
export async function resolveHandles(db: Executor, handles: readonly string[]): Promise<Map<string, HandleOwner>> {
  const owners = new Map<string, HandleOwner>();
  if (handles.length === 0) return owners;
  const rows = await db
    .select()
    .from(mentionHandles)
    .where(inArray(mentionHandles.handle, [...new Set(handles)]));
  for (const r of rows) {
    if (r.memberId) owners.set(r.handle, { kind: "member", id: r.memberId });
    else if (r.agentId) owners.set(r.handle, { kind: "agent", id: r.agentId });
  }
  return owners;
}
