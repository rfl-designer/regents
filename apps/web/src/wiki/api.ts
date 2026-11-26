import type {
  CreateWikiInput,
  WikiChannelDto,
  WikiDto,
  WikiPageViewDto,
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
  sources: (wikiId: string) => call<WikiSourceDto[]>(`/api/wikis/${wikiId}/sources`),
  /** Sobe as Fontes juntas: todas ou nenhuma. */
  upload: (wikiId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return call<WikiSourceDto[]>(`/api/wikis/${wikiId}/sources`, { method: "POST", body: form });
  },
  /** "Sincronizar": começa na hora; o estado segue por `wiki_sync.updated`. */
  sync: (wikiId: string) => call<WikiSyncDto>(`/api/wikis/${wikiId}/sync`, { method: "POST" }),
  /** "Cancelar": a Sincronização em curso termina em `canceled`, e a Wiki fica como estava. */
  cancelSync: (wikiId: string) => call<WikiSyncDto>(`/api/wikis/${wikiId}/sync/cancel`, { method: "POST" }),
  versions: (wikiId: string) => call<WikiVersionDto[]>(`/api/wikis/${wikiId}/versions`),
  /** Os Canais que o Admin vê, com a marca de ligado à Wiki. */
  channels: (wikiId: string) => call<WikiChannelDto[]>(`/api/wikis/${wikiId}/channels`),
  /** Liga ou desliga a Wiki de um Canal; devolve a lista nova. */
  setChannel: (wikiId: string, channelId: string, linked: boolean) =>
    call<WikiChannelDto[]>(`/api/wikis/${wikiId}/channels/${channelId}`, { method: linked ? "PUT" : "DELETE" }),
  /** As Wikis que o Membro lê (a barra lateral): o servidor decide pelo alcance. */
  list: () => call<WikiDto[]>("/api/wikis"),
  /** Uma página da versão atual, para ler. */
  page: (wikiId: string, slug: string) =>
    call<WikiPageViewDto>(`/api/wikis/${wikiId}/pages/${encodeURIComponent(slug)}`),
};
