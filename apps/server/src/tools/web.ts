import type { BrainTool } from "./port";

/** "buscar na web": pela Chave, a server tool `web_search`; pela Conta, o `WebSearch` do Claude Code. */
export const WEB_SEARCH = "buscar_na_web";
/** "abrir URL": pela Chave, a server tool `web_fetch`; pela Conta, o `WebFetch` do Claude Code. */
export const WEB_FETCH = "abrir_url";

/**
 * As Ferramentas da web (Spec #44): rodam no cérebro, não na porta de Ferramentas. O Admin as
 * concede como qualquer outra; o passo no Andamento sai do próprio fluxo do modelo.
 */
export const WEB_TOOLS: readonly BrainTool[] = [
  {
    id: WEB_SEARCH,
    title: "buscar na web",
    label: "buscando na web",
    description: "Busca na web e traz os resultados com os links.",
    origin: "web",
    access: "read",
    runsIn: "brain",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    id: WEB_FETCH,
    title: "abrir URL",
    label: "abrindo a página",
    description: "Abre uma URL que apareceu na conversa e lê a página.",
    origin: "web",
    access: "read",
    runsIn: "brain",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

/** O passo de "abrir URL" no Andamento: "abrindo <domínio>". */
export function fetchLabel(url: unknown) {
  try {
    if (typeof url === "string") return `abrindo ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    // URL que não se lê: o rótulo genérico
  }
  return "abrindo a página";
}
