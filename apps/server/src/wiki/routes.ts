import type { CreateWikiInput, SetWikiReachInput, WikiPageViewDto, WikiScope } from "@shearim/contracts";
import { Hono } from "hono";
import { findAgent, lockLiveAgent } from "../agents";
import type { Clock } from "../clock";
import { type Db, isUuid } from "../db/client";
import type { Audience, EventHub } from "../events";
import { adminOnly, type Env } from "../members";
import {
  agentWikisOf,
  channelForLink,
  linkWikiToAgent,
  linkWikiToChannel,
  setWikiReach,
  unknownMembers,
  unlinkWikiFromAgent,
  unlinkWikiFromChannel,
  wikiChannelsFor,
  wikiReachFor,
} from "./reach";
import { addSources, DEFAULT_SOURCE_MAX_BYTES, listSources, readUploads, removeSource } from "./sources";
import type { WikiSyncs } from "./sync";
import { listVersions, pageDtos, readPage, versionNumbered, versionNumberOf } from "./versions";
import {
  createWiki,
  findWiki,
  listReadableWikis,
  listWikis,
  readableWiki,
  toWikiDto,
  wikiAudience,
  wikiNamed,
} from "./wikis";

const NAME_MAX = 80;
const SCOPES: readonly WikiScope[] = ["public", "restricted"];

/** Quem estava na audiência `before` e ficou fora de `after`: a Wiki saiu do alcance deles. */
function leftOut(before: Audience, after: Audience): Audience | undefined {
  if (after === "everyone" || "everyoneBut" in after) return undefined;
  if (before === "everyone") return { everyoneBut: after.members };
  if ("everyoneBut" in before) return undefined;
  const gone = before.members.filter((id) => !after.members.includes(id));
  return gone.length ? { members: gone } : undefined;
}

/**
 * As rotas da Wiki na administração (#78). Só o Admin cria, sobe Fontes e vê a lista inteira,
 * mesmo as Wikis restritas a uma lista sem ele (`403 not_admin` para os outros). Isso não dá a ele
 * leitura delas nas conversas: ali vale o alcance (ADR 0014).
 */
export function wikiRoutes(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  syncs: WikiSyncs;
  sourceMaxBytes?: number;
}) {
  const { db, clock, events } = deps;
  const sourceMaxBytes = deps.sourceMaxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  const routes = new Hono<Env>();

  routes.get("/wiki-settings", adminOnly, async (c) => c.json(await listWikis(db)));

  /** As Wikis que o Membro lê (a barra lateral): as do alcance dele, com versão publicada. */
  routes.get("/wikis", async (c) => c.json(await listReadableWikis(db, c.get("member").id)));

  /**
   * Uma página da versão atual, para o Membro ler (#82). Fora do alcance, sem versão ou inexistente,
   * a Wiki "não existe" (404), sem dizer qual caso é. Só leitura: a Wiki muda só pela
   * Sincronização, e não há rota de edição de página, nem para o Admin.
   */
  routes.get("/wikis/:id/pages/:slug", async (c) => {
    const wiki = await readableWiki(db, c.req.param("id"), c.get("member").id);
    if (!wiki?.currentVersionId) return c.json({ error: "not_found", message: "Essa Wiki não existe." }, 404);
    const view = await pageView(wiki, wiki.currentVersionId, c.req.param("slug"));
    return view ? c.json(view) : c.json({ error: "not_found", message: noPage(wiki) }, 404);
  });

  /**
   * Uma página de uma versão, que a citação abre (#85): a versão lida, mesmo que haja uma mais nova
   * ou que a página não exista mais na atual. O mesmo alcance da versão atual.
   */
  routes.get("/wikis/:id/versions/:number/pages/:slug", async (c) => {
    const wiki = await readableWiki(db, c.req.param("id"), c.get("member").id);
    if (!wiki?.currentVersionId) return c.json({ error: "not_found", message: "Essa Wiki não existe." }, 404);
    const versionId = await versionNumbered(db, wiki.id, Number(c.req.param("number")));
    const view = versionId && (await pageView(wiki, versionId, c.req.param("slug")));
    return view ? c.json(view) : c.json({ error: "not_found", message: noPage(wiki) }, 404);
  });

  const noPage = (wiki: { name: string }) => `Essa página não existe na Wiki ${wiki.name}.`;

  /** A página `slug` da versão, para o Membro ler, e se ela existe na versão atual. */
  async function pageView(
    wiki: NonNullable<Awaited<ReturnType<typeof readableWiki>>>,
    versionId: string,
    slug: string,
  ): Promise<WikiPageViewDto | undefined> {
    const read = await readPage(db, versionId, slug);
    const currentId = wiki.currentVersionId;
    if (!read || !currentId) return undefined;
    return {
      wiki: await toWikiDto(db, wiki),
      version: await versionNumberOf(db, versionId),
      inCurrentVersion: versionId === currentId || (await readPage(db, currentId, slug)) !== undefined,
      ...read,
    };
  }

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

  /**
   * Remove uma Fonte (#88) e devolve a lista nova. A Wiki atual não muda: a Fonte que uma versão
   * reflete fica "a remover" até a próxima Sincronização; a que nenhuma reflete sai direto.
   */
  routes.delete("/wikis/:id/sources/:source", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    const sourceId = c.req.param("source");
    if (!wiki || !isUuid(sourceId)) return c.json({ error: "not_found" }, 404);
    const removed = await removeSource(db, { wikiId: wiki.id, sourceId, now: clock.now() });
    if (!removed) return c.json({ error: "not_found", message: "Essa Fonte não está ativa nesta Wiki." }, 404);
    if (removed === "sync_running") {
      const message = "Há uma Sincronização em curso nesta Wiki. Remova a Fonte quando ela terminar.";
      return c.json({ error: "sync_running", message }, 409);
    }
    events.publish(await wikiAudience(db, wiki), { type: "wiki.updated", wiki: await toWikiDto(db, wiki) });
    return c.json(await listSources(db, wiki.id));
  });

  /**
   * "Sincronizar" (ADR 0015): o clique do Admin autoriza a Sincronização inteira, sem Pedido de
   * aprovação. Ela começa na hora (202) e segue em tempo real (`wiki_sync.updated`). Recusada com
   * o motivo (409) quando já há uma em curso na Wiki ou quando não há nada pendente.
   */
  routes.post("/wikis/:id/sync", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    const sync = await deps.syncs.request(wiki.id, c.get("member").id);
    if ("error" in sync) return c.json(sync, 409);
    return c.json(sync, 202);
  });

  /**
   * "Cancelar": só o Admin. A chamada em curso é interrompida como numa execução (pela Conta,
   * `SIGINT` antes de `SIGTERM`), o rascunho é descartado e a Wiki fica como estava. `409` quando
   * não há Sincronização em curso na Wiki.
   */
  routes.post("/wikis/:id/sync/cancel", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    const sync = await deps.syncs.cancel(wiki.id);
    if (!sync) {
      return c.json({ error: "nothing_to_cancel", message: "Não há Sincronização em curso nesta Wiki." }, 409);
    }
    return c.json(sync);
  });

  routes.get("/wikis/:id/versions", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    return c.json(await listVersions(db, wiki.id));
  });

  /** As páginas de uma versão, por slug (a administração: o Admin vê toda Wiki, mesmo restrita). */
  routes.get("/wikis/:id/versions/:number/pages", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    const version = wiki && (await versionNumbered(db, wiki.id, Number(c.req.param("number"))));
    if (!version) return c.json({ error: "not_found" }, 404);
    return c.json(await pageDtos(db, version));
  });

  /**
   * As ligações da Wiki a Canais (#81): os Canais que o Admin vê, com a marca de ligado. Todo Agente
   * que responde num Canal ligado (a Articuladora inclusive) consulta a Wiki ali, dentro do alcance.
   */
  routes.get("/wikis/:id/channels", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    return c.json(await wikiChannelsFor(db, wiki.id, c.get("member").id));
  });

  /** Liga (`PUT`) ou desliga (`DELETE`) a Wiki de um Canal; vale na próxima resposta ali. */
  for (const method of ["put", "delete"] as const) {
    routes[method]("/wikis/:id/channels/:channel", adminOnly, async (c) => {
      const me = c.get("member").id;
      const wiki = await findWiki(db, c.req.param("id"));
      const channelId = c.req.param("channel");
      const channel = wiki && isUuid(channelId) ? await channelForLink(db, channelId, me) : undefined;
      if (!wiki || !channel) return c.json({ error: "not_found" }, 404);
      if (method === "put") await linkWikiToChannel(db, wiki.id, channel.id, clock.now());
      else await unlinkWikiFromChannel(db, wiki.id, channel.id);
      return c.json(await wikiChannelsFor(db, wiki.id, me));
    });
  }

  /**
   * As Wikis na tela do Agente (#84): todas, com a marca de ligada a ele. O Agente ligado consulta
   * a Wiki em qualquer conversa, a DM inclusive, dentro do alcance dela.
   */
  routes.get("/agents/:id/wikis", adminOnly, async (c) => {
    const [agent] = await findAgent(db, c.req.param("id"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    return c.json(await agentWikisOf(db, agent.id));
  });

  /** Liga (`PUT`) ou desliga (`DELETE`) a Wiki do Agente; vale na próxima resposta dele. */
  for (const method of ["put", "delete"] as const) {
    routes[method]("/agents/:id/wikis/:wiki", adminOnly, async (c) => {
      const [agent] = await findAgent(db, c.req.param("id"));
      const wiki = await findWiki(db, c.req.param("wiki"));
      if (!agent || !wiki) return c.json({ error: "not_found" }, 404);
      if (method === "put") {
        const done = await db.transaction(async (tx) => {
          // Quem apaga o Agente leva as ligações dele: ligar espera ou desiste.
          if (!(await lockLiveAgent(tx, agent.id))) return false;
          await linkWikiToAgent(tx, wiki.id, agent.id, clock.now());
          return true;
        });
        if (!done) return c.json({ error: "not_found" }, 404);
      } else {
        await unlinkWikiFromAgent(db, wiki.id, agent.id);
      }
      return c.json(await agentWikisOf(db, agent.id));
    });
  }

  /** O alcance da Wiki (#83): pública, ou restrita a uma lista de Membros ativos. */
  routes.get("/wikis/:id/reach", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    return c.json(await wikiReachFor(db, wiki));
  });

  /**
   * Troca o alcance e a lista inteira; vale na próxima resposta e na próxima leitura. Quem passa a
   * ver a Wiki recebe `wiki.updated`; quem deixa de ver recebe só `wiki.left`, com o id.
   */
  routes.put("/wikis/:id/reach", adminOnly, async (c) => {
    const wiki = await findWiki(db, c.req.param("id"));
    if (!wiki) return c.json({ error: "not_found" }, 404);
    const input = ((await c.req.json().catch(() => null)) ?? {}) as Partial<Record<keyof SetWikiReachInput, unknown>>;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);
    const scope = SCOPES.find((s) => s === input.scope);
    if (!scope) return invalid("O alcance da Wiki é público ou restrito a uma lista de Membros.");
    const ids = input.memberIds ?? [];
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && isUuid(id))) {
      return invalid("A lista da Wiki é uma lista de Membros do Workspace.");
    }
    if ((await unknownMembers(db, ids)).length) return invalid("Alguém na lista não é Membro do Workspace.");

    const before = await wikiAudience(db, wiki);
    await setWikiReach(db, wiki.id, { scope, memberIds: ids, now: clock.now() });
    const changed = (await findWiki(db, wiki.id))!;
    const after = await wikiAudience(db, changed);
    const gone = leftOut(before, after);
    if (gone) events.publish(gone, { type: "wiki.left", wikiId: wiki.id });
    events.publish(after, { type: "wiki.updated", wiki: await toWikiDto(db, changed) });
    return c.json(await wikiReachFor(db, changed));
  });

  return routes;
}
