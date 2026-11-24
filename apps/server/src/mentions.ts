import { asc } from "drizzle-orm";
import type { Agent } from "./agents";
import { type Db, schema } from "./db/client";

/**
 * Extração de Menções (Spec, módulo 3), na forma mínima do #20: cada `@palavra` do texto
 * casa com o nome de um Agente, sem diferença de maiúsculas nem de acentos.
 *
 * SEAM do #19 (identificador de Menção único entre Membros e Agentes): troque `handleOf`
 * pelo identificador gravado de cada Agente e Membro, e devolva também os Membros
 * mencionados. Quem chama (`conversations.ts`) só precisa da lista de Agentes.
 */
export async function mentionedAgents(db: Db, body: string): Promise<Agent[]> {
  const handles = mentionHandles(body);
  if (handles.size === 0) return [];
  const all = await db.select().from(schema.agents).orderBy(asc(schema.agents.createdAt));
  // Na ordem em que aparecem no texto, sem repetir.
  const byHandle = new Map(all.map((a) => [handleOf(a.name), a]));
  return [...handles].flatMap((h) => byHandle.get(h) ?? []);
}

/** As `@palavras` do texto, normalizadas, na ordem em que aparecem. */
export function mentionHandles(body: string): Set<string> {
  const found = new Set<string>();
  for (const m of body.matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_-]+)/gu)) found.add(normalize(m[1]!));
  return found;
}

/** O identificador de Menção de um Agente enquanto o #19 não chega: o nome normalizado. */
export function handleOf(name: string) {
  return normalize(name.replace(/\s+/g, ""));
}

function normalize(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
