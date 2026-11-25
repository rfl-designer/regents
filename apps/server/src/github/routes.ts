import {
  type AgentGitHubDto,
  GITHUB_PATH,
  type GitHubInstallDto,
  type GitHubManifestDto,
  type StartGitHubManifestInput,
} from "@shearim/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, isUuid, schema } from "../db/client";
import type { Env } from "../members";
import { ToolFailure } from "../tools/port";
import { APP_PERMISSIONS, type GitHub } from "./connector";

/** Volta o navegador do Admin à tela do GitHub no PWA, com o desfecho do retorno. */
const backToPwa = (outcome: { ok: string } | { error: string }) =>
  "ok" in outcome ? `${GITHUB_PATH}?github=${outcome.ok}` : `${GITHUB_PATH}?erro=${encodeURIComponent(outcome.error)}`;

/**
 * O GitHub do Workspace, só para o Admin (ADR 0010): criar o GitHub App pelo fluxo de manifest e
 * instalá-lo na conta do time. Quem redireciona é o navegador do Admin: os retornos chegam aqui
 * com a identidade dele, e o `state` do fluxo em andamento é conferido.
 */
export function githubRoutes(deps: { db: Db; github: GitHub }) {
  const { db, github } = deps;
  const routes = new Hono<Env>();

  async function agentExists(id: string) {
    if (!isUuid(id)) return false;
    const [row] = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, id));
    return Boolean(row);
  }

  /** Os repositórios que a instalação alcança, ou o motivo de não saber (sem instalação, instalação removida). */
  async function available(): Promise<{ list: string[]; failure: string | null }> {
    try {
      return { list: await github.installationRepositories(), failure: null };
    } catch (err) {
      if (!(err instanceof ToolFailure)) throw err;
      return { list: [], failure: err.reason };
    }
  }

  async function agentGitHub(agentId: string): Promise<AgentGitHubDto> {
    const { list, failure } = await available();
    return { repositories: await github.repositoriesOf(agentId), available: list, failure };
  }

  /**
   * Os repositórios de um Agente, na tela dele (só Admin): os que a instalação alcança, para
   * escolher, e a lista dele. Sem lista, o Agente alcança tudo o que a instalação alcança.
   */
  routes.get("/agents/:id/github", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    if (!(await agentExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json(await agentGitHub(id));
  });

  routes.put("/agents/:id/github", async (c) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    const id = c.req.param("id");
    if (!(await agentExists(id))) return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => null)) as { repositories?: unknown } | null;
    const invalid = (message: string) => c.json({ error: "invalid_input", message }, 400);
    const raw = input?.repositories;
    if (raw === null) {
      await github.restrict(id, null);
      return c.json(await agentGitHub(id));
    }
    if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string"))
      return invalid("Os repositórios são uma lista de dono/nome, ou nula para todos os da instalação.");
    if (!raw.length)
      return invalid("Escolha ao menos um repositório, ou deixe o Agente alcançar todos os da instalação.");
    const { list, failure } = await available();
    if (failure)
      return c.json({ error: "github_unavailable", message: `Não deu para conferir no GitHub: ${failure}.` }, 409);
    // Guarda como a instalação escreve (`Time/Site` vira `time/site` se é assim que ela o chama).
    const chosen: string[] = [];
    for (const r of raw as string[]) {
      const found = list.find((a) => a.toLowerCase() === r.trim().toLowerCase());
      if (!found) return invalid(`O repositório ${r} não está entre os que a instalação do GitHub alcança.`);
      if (!chosen.includes(found)) chosen.push(found);
    }
    await github.restrict(id, chosen);
    return c.json({ repositories: [...chosen].sort((a, b) => a.localeCompare(b)), available: list, failure: null });
  });

  routes.use("/github/*", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });
  routes.use("/github", async (c, next) => {
    if (c.get("member").role !== "admin") return c.json({ error: "not_admin" }, 403);
    await next();
  });

  routes.get("/github", async (c) => c.json(await github.status()));

  routes.post("/github/manifest", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<StartGitHubManifestInput> | null;
    let origin: string;
    try {
      const url = new URL(String(input?.origin ?? ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      origin = url.origin;
    } catch {
      return c.json({ error: "invalid_input", message: "O endereço da Instalação não é válido." }, 400);
    }
    const organization = typeof input?.organization === "string" ? input.organization.trim() : "";
    if (organization && !/^[A-Za-z0-9-]+$/.test(organization))
      return c.json({ error: "invalid_input", message: "O nome da organização não é válido." }, 400);
    const state = await github.begin({ origin });
    const manifest = {
      name: `Shearim ${new URL(origin).hostname.split(".")[0]}`.slice(0, 34),
      url: origin,
      public: false,
      redirect_url: `${origin}/api/github/manifest/callback`,
      setup_url: `${origin}/api/github/installation/callback`,
      setup_on_update: true,
      // O Shearim não recebe webhooks (fica na tailnet); o GitHub exige o endereço mesmo assim.
      hook_attributes: { url: `${origin}/api/github/webhook`, active: false },
      default_permissions: APP_PERMISSIONS,
      default_events: [],
    };
    const base = organization
      ? `${github.config.webUrl}/organizations/${organization}/settings/apps/new`
      : `${github.config.webUrl}/settings/apps/new`;
    return c.json({
      action: `${base}?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest),
    } satisfies GitHubManifestDto);
  });

  routes.get("/github/manifest/callback", async (c) => {
    const started = await github.finish(c.req.query("state"));
    if (!started)
      return c.redirect(backToPwa({ error: "O retorno do GitHub não é do fluxo em andamento. Comece de novo." }));
    const code = c.req.query("code");
    if (!code) return c.redirect(backToPwa({ error: "O GitHub não mandou o código do App." }));
    try {
      await github.convert(code);
    } catch (err) {
      console.error("shearim: a criação do GitHub App falhou", err);
      return c.redirect(backToPwa({ error: "O GitHub não criou o App. Comece de novo." }));
    }
    return c.redirect(backToPwa({ ok: "created" }));
  });

  routes.post("/github/installation", async (c) => {
    const url = await github.installUrl(await github.begin());
    if (!url) return c.json({ error: "no_app", message: "Crie o GitHub App antes de instalar." }, 409);
    return c.json({ url } satisfies GitHubInstallDto);
  });

  routes.get("/github/installation/callback", async (c) => {
    const id = Number(c.req.query("installation_id"));
    // Trocar os repositórios no GitHub também volta aqui (`setup_on_update`), sem o `state`.
    const update = c.req.query("setup_action") === "update" && (await github.status()).installation?.id === id;
    const started = update || (await github.finish(c.req.query("state")));
    if (!started)
      return c.redirect(backToPwa({ error: "O retorno do GitHub não é do fluxo em andamento. Comece de novo." }));
    if (!Number.isSafeInteger(id) || id <= 0)
      return c.redirect(backToPwa({ error: "O GitHub não mandou a instalação." }));
    try {
      await github.link(id);
    } catch (err) {
      console.error("shearim: a instalação do GitHub App não foi confirmada", err);
      return c.redirect(backToPwa({ error: "O GitHub não confirmou a instalação. Instale de novo." }));
    }
    return c.redirect(backToPwa({ ok: "installed" }));
  });

  return routes;
}
