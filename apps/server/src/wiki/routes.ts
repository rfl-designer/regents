import type { CreateWikiInput } from "@shearim/contracts";
import { Hono } from "hono";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { adminOnly, type Env } from "../members";
import { addSources, DEFAULT_SOURCE_MAX_BYTES, listSources, readUploads } from "./sources";
import { createWiki, findWiki, listWikis, wikiNamed } from "./wikis";

const NAME_MAX = 80;

/**
 * As rotas da Wiki na administração (#78). Só o Admin cria, sobe Fontes e vê a lista inteira,
 * mesmo as Wikis restritas a uma lista sem ele (`403 not_admin` para os outros). Isso não dá a ele
 * leitura delas nas conversas: ali vale o alcance (ADR 0014).
 */
export function wikiRoutes(deps: { db: Db; clock: Clock; sourceMaxBytes?: number }) {
  const { db, clock } = deps;
  const sourceMaxBytes = deps.sourceMaxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  const routes = new Hono<Env>();

  routes.get("/wiki-settings", adminOnly, async (c) => c.json(await listWikis(db)));

  routes.post("/wikis", adminOnly, async (c) => {
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<Record<keyof CreateWikiInput, unknown>>;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return invalid("Dê um nome à Wiki.");
    if (name.length > NAME_MAX) return invalid(`O nome da Wiki tem no máximo ${NAME_MAX} caracteres.`);
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!description)
      return invalid("Diga na descrição o que a Wiki cobre: os Agentes a usam para saber quando consultá-la.");
    const wiki = await createWiki(db, { name, description, by: c.get("member").id, now: clock.now() });
    if (!wiki) {
      const taken = await wikiNamed(db, name);
      return c.json({ error: "name_taken", message: `Já existe a Wiki "${taken?.name ?? name}".` }, 409);
    }
    return c.json(wiki, 201);
  });

  routes.get("/wikis/:id/sources", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    return c.json(await listSources(db, wiki.id));
  });

  /**
   * Sobe uma ou várias Fontes (multipart, um campo `files` por arquivo). Todas ou nenhuma: uma
   * recusada (formato, tamanho, texto) recusa o pedido inteiro, com o motivo, e a lista não muda.
   */
  routes.post("/wikis/:id/sources", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
    const files = [body.files].flat().filter((f): f is File => f instanceof File);
    const uploads = await readUploads(files, sourceMaxBytes);
    if ("error" in uploads) return c.json({ error: uploads.error, message: uploads.message }, uploads.status);
    const sources = await addSources(db, { wikiId: wiki.id, uploads, by: c.get("member").id, now: clock.now() });
    if ("exists" in sources) {
      const message = `Já existe a Fonte ${sources.exists} nesta Wiki. Uma Fonte não muda depois de subir: dê outro nome ao arquivo.`;
      return c.json({ error: "source_exists", message }, 409);
    }
    return c.json(sources, 201);
  });

  return routes;
}
