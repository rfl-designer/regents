import { createPrivateKey, sign } from "node:crypto";
import type { GitHubDto } from "@regents/contracts";
import { asc, eq, inArray } from "drizzle-orm";
import { lockLiveAgent } from "../agents";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { SecretBox } from "../secrets";
import { ToolFailure } from "../tools/port";

const { githubApp, agentGithubRepositories } = schema;

/** O escopo de um token de instalação: um repositório, alguns (`dono/nome`) ou, sem os dois, todos. */
export interface GitHubScope {
  repository?: string;
  repositories?: readonly string[];
  permissions: GitHubPermissions;
}

/** Onde fica o GitHub: a web (por onde passa o navegador do Admin) e a API. */
export interface GitHubConfig {
  webUrl: string;
  apiUrl: string;
}

export const GITHUB_DEFAULTS: GitHubConfig = { webUrl: "https://github.com", apiUrl: "https://api.github.com" };

/** As permissões de um token de instalação (`{ contents: "read" }`). */
export type GitHubPermissions = Record<string, "read" | "write">;

/**
 * As permissões que o App pede no manifest: as das Ferramentas de leitura e as das escritas
 * (criar issue e comentar). Cada token pede só um pedaço disto.
 */
export const APP_PERMISSIONS: GitHubPermissions = {
  metadata: "read",
  contents: "read",
  issues: "write",
  pull_requests: "write",
};

/** Os segredos do App, guardados juntos e cifrados. */
interface AppSecrets {
  pem: string;
  webhookSecret: string | null;
  clientSecret: string | null;
}

/** O que a conversão do manifest devolve (`POST /app-manifests/:code/conversions`). */
export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  owner: { login: string } | null;
  html_url: string;
  pem: string;
  webhook_secret: string | null;
  client_secret: string | null;
}

/** O motivo que vai ao modelo, ao Andamento e ao Admin quando o GitHub não reconhece mais a instalação. */
export const INSTALLATION_GONE =
  "a instalação do GitHub App foi removida ou suspensa no GitHub; o Admin precisa instalá-lo de novo";

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "regents",
};

/**
 * O GitHub do Workspace (ADR 0010): o App guardado, o JWT dele, o token de instalação curto de
 * cada chamada e a chamada à API. É o que as rotas do Admin e as Ferramentas do GitHub usam.
 */
export function createGitHub(deps: { db: Db; clock: Clock; secrets: SecretBox; config?: Partial<GitHubConfig> }) {
  const { db, clock, secrets } = deps;
  const config: GitHubConfig = { ...GITHUB_DEFAULTS, ...deps.config };

  async function row() {
    const [r] = await db.select().from(githubApp).where(eq(githubApp.id, 1));
    return r;
  }

  async function save(values: Partial<typeof githubApp.$inferInsert>) {
    await db
      .insert(githubApp)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: githubApp.id, set: values });
  }

  /** O JWT do App (RS256, até 10 min), assinado com a chave privada, para falar como o App. */
  function appJwt(appId: number, pem: string) {
    const iat = Math.floor(clock.now().getTime() / 1000) - 60;
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + 600, iss: String(appId) })}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), createPrivateKey(pem)).toString("base64url")}`;
  }

  async function appSecrets(r: NonNullable<Awaited<ReturnType<typeof row>>>): Promise<AppSecrets | null> {
    if (!r.secretsCiphertext || !r.secretsIv) return null;
    const plain = await secrets.open({ ciphertext: r.secretsCiphertext, iv: r.secretsIv }).catch(() => null);
    return plain ? (JSON.parse(plain) as AppSecrets) : null;
  }

  async function asApp(path: string, init: RequestInit = {}) {
    const r = await row();
    const s = r && (await appSecrets(r));
    if (!r?.appId || !s)
      throw new ToolFailure("o GitHub App não existe ou os segredos dele não abrem com esta chave mestra");
    return fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: { ...API_HEADERS, authorization: `Bearer ${appJwt(r.appId, s.pem)}`, ...init.headers },
    });
  }

  /** A instalação deixou de existir no GitHub: o Admin vê o motivo em `GET /api/github`. */
  async function markGone() {
    await save({ failureReason: INSTALLATION_GONE, failedAt: clock.now() });
  }

  const github = {
    config,

    async status(): Promise<GitHubDto> {
      const r = await row();
      if (!r?.appId) return { state: "none", app: null, installation: null, failure: null };
      return {
        state: r.installationId ? "installed" : "created",
        app: { name: r.name ?? "", slug: r.slug ?? "", owner: r.owner ?? "", htmlUrl: r.htmlUrl ?? "" },
        installation:
          r.installationId && r.installedAt
            ? { id: r.installationId, account: r.installationAccount ?? "", installedAt: r.installedAt.toISOString() }
            : null,
        failure: r.failureReason && r.failedAt ? { reason: r.failureReason, at: r.failedAt.toISOString() } : null,
      };
    },

    /** Um `state` novo para o fluxo que começa (manifest ou instalação). */
    async begin(values: { origin?: string } = {}) {
      const state = crypto.randomUUID();
      await save({ pendingState: state, ...values });
      return state;
    },

    /** Confere e consome o `state` do retorno; devolve o endereço de onde o fluxo começou. */
    async finish(state: string | undefined): Promise<{ origin: string | null } | null> {
      const r = await row();
      if (!state || !r?.pendingState || r.pendingState !== state) return null;
      await save({ pendingState: null });
      return { origin: r.origin };
    },

    /** Troca o código do retorno do manifest pelo App e o guarda, com os segredos cifrados. */
    async convert(code: string) {
      const res = await fetch(`${config.apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: API_HEADERS,
      });
      if (!res.ok) throw new Error(`o GitHub recusou o código do manifest (${res.status})`);
      const app = (await res.json()) as ConvertedApp;
      const sealed = await secrets.seal(
        JSON.stringify({
          pem: app.pem,
          webhookSecret: app.webhook_secret,
          clientSecret: app.client_secret,
        } satisfies AppSecrets),
      );
      // Um App novo começa sem instalação: a do App anterior não vale para ele.
      await save({
        appId: app.id,
        slug: app.slug,
        name: app.name,
        owner: app.owner?.login ?? null,
        htmlUrl: app.html_url,
        secretsCiphertext: sealed.ciphertext,
        secretsIv: sealed.iv,
        createdAt: clock.now(),
        installationId: null,
        installationAccount: null,
        installedAt: null,
        failureReason: null,
        failedAt: null,
      });
    },

    /** A página do GitHub onde o Admin instala o App e escolhe os repositórios. */
    async installUrl(state: string) {
      const r = await row();
      if (!r?.slug) return null;
      return `${config.webUrl}/apps/${encodeURIComponent(r.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    },

    /**
     * Liga a instalação ao Workspace, conferindo no GitHub, como o App, que ela é dele: um
     * `installation_id` de outro App (ou inventado) não liga. Substitui a anterior.
     */
    async link(installationId: number) {
      const res = await asApp(`/app/installations/${installationId}`);
      if (!res.ok) throw new Error(`o GitHub não reconhece a instalação ${installationId} deste App (${res.status})`);
      const inst = (await res.json()) as { account?: { login?: string } };
      await save({
        installationId,
        installationAccount: inst.account?.login ?? null,
        installedAt: clock.now(),
        failureReason: null,
        failedAt: null,
      });
    },

    /**
     * Um token de instalação curto, pedido na hora, limitado ao repositório (`dono/nome`) ou aos
     * repositórios do escopo (sem eles, todos os que a instalação alcança) e às permissões da
     * Ferramenta. Falha com motivo.
     */
    async token(scope: GitHubScope, signal?: AbortSignal) {
      const r = await row();
      if (!r?.installationId) throw new ToolFailure("o GitHub não está instalado no Workspace");
      const wanted = scope.repository ? [scope.repository] : scope.repositories;
      let repositories: string[] | undefined;
      if (wanted) {
        repositories = wanted.map((full) => {
          const [owner, name, ...rest] = full.split("/");
          if (!owner || !name || rest.length) throw new ToolFailure("informe o repositório como dono/nome");
          if (r.installationAccount && owner.toLowerCase() !== r.installationAccount.toLowerCase())
            throw new ToolFailure(`o repositório ${full} não está entre os que o GitHub App alcança`);
          return name;
        });
      }
      let res: Response;
      try {
        res = await asApp(`/app/installations/${r.installationId}/access_tokens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repositories, permissions: scope.permissions }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted || err instanceof ToolFailure) throw err;
        throw new ToolFailure("o GitHub não respondeu");
      }
      if (res.status === 404 || res.status === 403) {
        await markGone();
        throw new ToolFailure(INSTALLATION_GONE);
      }
      if (res.status === 422)
        throw new ToolFailure(
          wanted?.length === 1
            ? `o repositório ${wanted[0]} não está entre os que o GitHub App alcança`
            : `algum dos repositórios ${wanted?.join(", ") ?? ""} não está entre os que o GitHub App alcança`,
        );
      if (!res.ok) throw new ToolFailure(`o GitHub recusou o token de instalação (${res.status})`);
      return ((await res.json()) as { token: string }).token;
    },

    /**
     * As chamadas de uma Ferramenta: um token de instalação novo, limitado como ela pede, e o
     * `get`/`post` da API com ele. Devolvem o JSON, `null` no 404 (a Ferramenta diz o que não
     * achou) ou falham com motivo.
     */
    async session(scope: GitHubScope, signal: AbortSignal) {
      const token = await github.token(scope, signal);
      async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
        let res: Response;
        try {
          res = await fetch(`${config.apiUrl}${path}`, {
            method,
            headers: {
              ...API_HEADERS,
              authorization: `Bearer ${token}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          throw new ToolFailure("o GitHub não respondeu");
        }
        if (res.status === 404) return null;
        if (res.status === 401) {
          await markGone();
          throw new ToolFailure(INSTALLATION_GONE);
        }
        if (res.status === 403) throw new ToolFailure("o GitHub App não tem permissão para isso");
        if (res.status === 410) throw new ToolFailure("as issues estão desligadas nesse repositório");
        if (res.status === 422) {
          const why = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
          throw new ToolFailure(`o GitHub recusou o pedido${why ? ` (${why})` : ""}`);
        }
        if (!res.ok) throw new ToolFailure(`o GitHub respondeu ${res.status}`);
        return (await res.json()) as T;
      }
      return {
        get: <T>(path: string) => call<T>("GET", path),
        post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
      };
    },

    /** Os repositórios que a instalação alcança agora (`dono/nome`, em ordem), perguntados ao GitHub. */
    async installationRepositories(signal?: AbortSignal): Promise<string[]> {
      const api = await github.session({ permissions: { metadata: "read" } }, signal ?? new AbortController().signal);
      const all = await installationRepositoriesOf<{ full_name: string }>(api);
      return all.map((repo) => repo.full_name).sort((a, b) => a.localeCompare(b));
    },

    /**
     * Os repositórios a que o Admin restringiu cada Agente (todos, ou só `agentIds`). Agente sem
     * lista fica de fora do mapa: alcança tudo o que a instalação alcança.
     */
    async agentRepositories(agentIds?: readonly string[]): Promise<Map<string, string[]>> {
      const out = new Map<string, string[]>();
      if (agentIds && agentIds.length === 0) return out;
      const rows = await db
        .select()
        .from(agentGithubRepositories)
        .where(agentIds ? inArray(agentGithubRepositories.agentId, [...agentIds]) : undefined)
        .orderBy(asc(agentGithubRepositories.repository));
      for (const r of rows) out.set(r.agentId, [...(out.get(r.agentId) ?? []), r.repository]);
      return out;
    },

    /** A lista de um Agente (nula: todos os da instalação). */
    async repositoriesOf(agentId: string): Promise<string[] | null> {
      return (await github.agentRepositories([agentId])).get(agentId) ?? null;
    },

    /**
     * Troca a lista de um Agente (nula: tira a lista). Quem chama já conferiu os repositórios.
     * Devolve `false` se o Agente foi apagado (o DELETE ganhou a corrida), e nada muda.
     */
    async restrict(agentId: string, repositories: readonly string[] | null): Promise<boolean> {
      return db.transaction(async (tx) => {
        if (!(await lockLiveAgent(tx, agentId))) return false;
        await tx.delete(agentGithubRepositories).where(eq(agentGithubRepositories.agentId, agentId));
        if (repositories?.length)
          await tx.insert(agentGithubRepositories).values(repositories.map((repository) => ({ agentId, repository })));
        return true;
      });
    },
  };
  return github;
}

export type GitHub = ReturnType<typeof createGitHub>;

/** Todas as páginas de `/installation/repositories` (o GitHub dá no máximo 100 por página). */
export async function installationRepositoriesOf<T>(api: { get<U>(path: string): Promise<U | null> }): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const list =
      (await api.get<{ repositories: T[] }>(`/installation/repositories?per_page=100&page=${page}`))?.repositories ??
      [];
    all.push(...list);
    if (list.length < 100) return all;
  }
}
