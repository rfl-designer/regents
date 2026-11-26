/**
 * A citação dos dublês da extração da Memória (ADR 0013): cada operação cita, em `mensagem`, o id
 * de uma mensagem de pessoa da troca. Para os roteiros não precisarem saber os ids, a operação
 * roteirizada sem `mensagem` cita a última mensagem de pessoa da entrada (a respondida, quase
 * sempre). Para testar a operação sem citação, o roteiro põe `mensagem: ""`.
 *
 * Usada pela Messages API falsa (e, por ela, pelo e2e), pelo `scriptedBrain` e pelo `fake-claude`.
 */

/** O id da última mensagem de pessoa da entrada da extração ("[id] Nome (pessoa): …"). */
export function lastPersonId(input: string): string | undefined {
  const people = input.split("## Mensagens de pessoa da troca")[1]?.split("## A resposta de")[0] ?? "";
  return [...people.matchAll(/^\[([0-9a-f-]{36})\] .+? \(pessoa\): /gm)].at(-1)?.[1];
}

/** O JSON da extração com a citação padrão nas operações que não citam nada. */
export function citeLastPerson(json: unknown, input: string): unknown {
  const list = (json as { operacoes?: unknown } | null)?.operacoes;
  const id = lastPersonId(input);
  if (!Array.isArray(list) || !id) return json;
  return {
    ...(json as object),
    operacoes: list.map((op) => (op && typeof op === "object" && !("mensagem" in op) ? { ...op, mensagem: id } : op)),
  };
}

/** O mesmo, para o JSON em texto (o que não se entende fica como veio). */
export function citeLastPersonText(text: string, input: string): string {
  try {
    return JSON.stringify(citeLastPerson(JSON.parse(text), input));
  } catch {
    return text;
  }
}
