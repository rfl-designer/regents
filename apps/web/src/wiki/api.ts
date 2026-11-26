import type { CreateWikiInput, WikiDto, WikiSourceDto } from "@shearim/contracts";
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
};
