/** O tamanho de parte padrão, em caracteres (`SHEARIM_WIKI_PART_MAX_CHARS`): cerca de 10 mil tokens. */
export const DEFAULT_PART_MAX_CHARS = 40_000;

/** O começo do bloco seguinte: depois de uma linha em branco, ou numa linha de título markdown. */
const BREAK = /\n[ \t]*\n\s*|\n(?=#{1,6}[ \t])/g;

/**
 * Divide uma Fonte em partes de até `max` caracteres (spec #74, "Sincronização", passo 2). O corte
 * cai na última quebra de parágrafo ou de título antes do limite; sem nenhuma, no último espaço; sem
 * espaço, no próprio limite. Uma Fonte que cabe numa parte vai inteira.
 */
export function sourceParts(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = 0;
    for (const m of rest.matchAll(BREAK)) {
      if (m.index > max) break;
      if (m.index > 0) cut = m.index;
    }
    if (!cut) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
