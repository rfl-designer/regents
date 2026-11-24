import { eq } from "drizzle-orm";
import type { Agent } from "./agents";
import { type Db, schema } from "./db/client";
import { addAgent } from "./participation";

/**
 * A Articuladora (ADR 0004): o Agente embutido do Shearim, Sophya por padrão, em todo Canal.
 * A linha dela em `agents` tem a marca `builtin` e nasce na migração `0012`. O Admin muda o
 * nome, a foto e o modelo; a descrição, as instruções e o contrato de roteamento são daqui, do
 * código, e mudam só com uma versão nova do Shearim.
 */

/** A descrição pública dela (o que todo Membro vê e o que os outros Agentes leem em "quem é quem"). */
export const ARTICULADORA_DESCRIPTION =
  "A Articuladora do Shearim: está em todo Canal, decide a cada mensagem se alguém precisa responder, responde ela mesma ou passa para os Agentes do Canal, e conhece todos os Agentes do Workspace.";

/** As instruções dela quando responde (a resposta dela e a Menção a ela). */
export const ARTICULADORA_INSTRUCTIONS = [
  "Você é a Articuladora do Workspace: conhece todos os Agentes e ajuda as pessoas a chegar em quem serve.",
  "Responda você mesma o que for geral, curto ou sobre o próprio time.",
  "Quando um Agente de fora deste Canal serviria melhor, sugira em texto que a pessoa o mencione com o @identificador dele, ou o adicione ao Canal. Você não passa a mensagem para ele.",
  "Cite só os Canais da lista que você recebeu: são os que quem escreveu pode ver.",
].join("\n");

/** O modelo barato e fixo do roteamento (Spec, módulo 4). Conta no orçamento dela (#28). */
export const ROUTING_MODEL = "claude-haiku-5-5";

type Executor = Pick<Db, "select" | "insert">;

/** A linha da Articuladora. Toda Instalação migrada tem uma (e só uma). */
export async function articuladoraOf(db: Executor): Promise<Agent> {
  const [row] = await db.select().from(schema.agents).where(eq(schema.agents.builtin, true));
  if (!row) throw new Error("A Articuladora não existe: o banco não passou pela migração 0012?");
  return row;
}

/** Põe a Articuladora num Canal novo (público ou privado), na mesma transação que o cria. */
export async function addArticuladora(tx: Executor, channelId: string, at: Date) {
  await addAgent(tx as Db, channelId, (await articuladoraOf(tx)).id, at);
}

/** O Agente como o mundo o vê: a Articuladora com a descrição e as instruções do Shearim. */
export function withBuiltinText<T extends Pick<Agent, "builtin" | "description" | "instructions">>(agent: T): T {
  return agent.builtin
    ? { ...agent, description: ARTICULADORA_DESCRIPTION, instructions: ARTICULADORA_INSTRUCTIONS }
    : agent;
}
