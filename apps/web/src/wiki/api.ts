import type {
  AgentWikiDto,
  CreateWikiInput,
  SetWikiReachInput,
  WikiChannelDto,
  WikiDto,
  WikiPageViewDto,
  WikiReachDto,
  WikiSourceDto,
  WikiSyncDto,
  WikiVersionDto,
} from "@shearim/contracts";
import { call, json } from "../api";

/** As chamadas da Wiki (spec #74). */
export const wikiApi = {
  /** Todas as Wikis, para o Admin (mesmo as restritas). */
  adminList: () => call<WikiDto[]>("/api/wiki-settings"),
  create: (input: CreateWikiInput) => call<WikiDto>("/api/wikis", json("POST", input)),
  /** Apaga a Wiki: ela sai de todos os Canais e Agentes na hora. */
  remove: (wikiId: string) => call<void>(`/api/wikis/${wikiId}`, { method: "DELETE" }),
  sources: (wikiId: string) => call<WikiSourceDto[]>(`/api/wikis/${wikiId}/sources`),
  /** Sobe as Fontes juntas: todas ou nenhuma. */
  upload: (wikiId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return call<WikiSourceDto[]>(`/api/wikis/${wikiId}/sources`, { method: "POST", body: form });
  },
  /** Remove uma Fonte: ela fica "a remover" até a próxima Sincronização, ou sai direto. Devolve a lista nova. */
  removeSource: (wikiId: string, sourceId: string) =>
    call<WikiSourceDto[]>(`/api/wikis/${wikiId}/sources/${sourceId}`, { method: "DELETE" }),
  /** "Sincronizar": começa na hora; o estado segue por `wiki_sync.updated`. */
  sync: (wikiId: string) => call<WikiSyncDto>(`/api/wikis/${wikiId}/sync`, { method: "POST" }),
  /** "Cancelar": a Sincronização em curso termina em `canceled`, e a Wiki fica como estava. */
  cancelSync: (wikiId: string) => call<WikiSyncDto>(`/api/wikis/${wikiId}/sync/cancel`, { method: "POST" }),
  versions: (wikiId: string) => call<WikiVersionDto[]>(`/api/wikis/${wikiId}/versions`),
  /** "Voltar a esta versão": ela passa a ser a atual, sem destilar de novo. Devolve a lista nova. */
  restore: (wikiId: string, number: number) =>
    call<WikiVersionDto[]>(`/api/wikis/${wikiId}/versions/${number}/restore`, { method: "POST" }),
  /** Os Canais que o Admin vê, com a marca de ligado à Wiki. */
  channels: (wikiId: string) => call<WikiChannelDto[]>(`/api/wikis/${wikiId}/channels`),
  /** Liga ou desliga a Wiki de um Canal; devolve a lista nova. */
  setChannel: (wikiId: string, channelId: string, linked: boolean) =>
    call<WikiChannelDto[]>(`/api/wikis/${wikiId}/channels/${channelId}`, { method: linked ? "PUT" : "DELETE" }),
  /** Todas as Wikis, com a marca de ligada ao Agente (a tela do Agente). */
  ofAgent: (agentId: string) => call<AgentWikiDto[]>(`/api/agents/${agentId}/wikis`),
  /** Liga ou desliga a Wiki do Agente; devolve a lista nova. */
  setAgent: (agentId: string, wikiId: string, linked: boolean) =>
    call<AgentWikiDto[]>(`/api/agents/${agentId}/wikis/${wikiId}`, { method: linked ? "PUT" : "DELETE" }),
  /** O alcance: pública, ou restrita à lista (os Membros ativos, com a marca). */
  reach: (wikiId: string) => call<WikiReachDto>(`/api/wikis/${wikiId}/reach`),
  /** Troca o alcance e a lista inteira; devolve a tela nova. */
  setReach: (wikiId: string, input: SetWikiReachInput) =>
    call<WikiReachDto>(`/api/wikis/${wikiId}/reach`, json("PUT", input)),
  /** As Wikis que o Membro lê (a barra lateral): o servidor decide pelo alcance. */
  list: () => call<WikiDto[]>("/api/wikis"),
  /** Uma página da versão atual, para ler. */
  page: (wikiId: string, slug: string) =>
    call<WikiPageViewDto>(`/api/wikis/${wikiId}/pages/${encodeURIComponent(slug)}`),
  /** A página numa versão (a que a citação abre, #85). */
  pageAt: (wikiId: string, version: number, slug: string) =>
    call<WikiPageViewDto>(`/api/wikis/${wikiId}/versions/${version}/pages/${encodeURIComponent(slug)}`),
};
