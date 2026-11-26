/**
 * Dublê do GitHub (Spec #44, "Testing Decisions"; ADR 0010): um servidor HTTP falso com o lado da
 * web (o formulário do manifest e a página de instalação, por onde passa o navegador do Admin) e
 * o lado da API (a conversão do manifest, a instalação, o token de instalação e as rotas de
 * repositórios, arquivos, issues e pull requests).
 *
 * - A conversão devolve uma chave privada RSA de verdade; o falso confere a assinatura do JWT do
 *   App com a chave pública.
 * - O token de instalação guarda o repositório e as permissões pedidos (`tokens`), e cada rota
 *   confere os dois: fora do repositório dá 404, sem a permissão dá 403, como no GitHub.
 * - `uninstall()` remove a instalação no GitHub: o token passa a dar 404.
 * - As escritas (criar issue, comentar) pedem a permissão em `write` e saem como o bot do App
 *   (`<slug>[bot]`); ficam no repositório (`issuesOf`).
 */
import { generateKeyPairSync, verify } from "node:crypto";

type Level = "read" | "write";
export type Permissions = Record<string, Level>;

export interface FakeIssue {
  number: number;
  title: string;
  body?: string;
  state?: "open" | "closed";
  author?: string;
  comments?: { author: string; body: string; id?: number }[];
  /** É pull request: a branch de origem e a de destino. */
  pull?: { head: string; base: string; merged?: boolean };
}

export interface FakeRepo {
  fullName: string;
  description?: string;
  private?: boolean;
  defaultBranch?: string;
  files?: Record<string, string>;
  issues?: FakeIssue[];
}

/** Um token de instalação emitido: para quem, para quais repositórios e com quais permissões. */
export interface IssuedToken {
  token: string;
  installationId: number;
  /** Os repositórios pedidos (nomes curtos), ou `null`: todos os da instalação. */
  repositories: string[] | null;
  permissions: Permissions;
}

/** Uma chamada à API feita com token de instalação: a rota e o token com que veio. */
export interface ApiCall {
  method: string;
  path: string;
  token: IssuedToken | null;
  status: number;
  /** O `user-agent` da chamada. */
  userAgent: string | null;
}

const APP_PERMISSIONS_FALLBACK: Permissions = { metadata: "read" };

export async function startFakeGitHub() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const repos = new Map<string, FakeRepo>();
  const manifests = new Map<string, { manifest: Record<string, unknown>; owner: string }>();
  let app: { id: number; slug: string; name: string; owner: string; manifest: Record<string, unknown> } | null = null;
  const installations = new Map<number, { account: string; repositories: string[] }>();
  let nextInstall: { account?: string; repositories?: string[] } = {};
  let nextAppName: string | undefined;
  const tokens = new Map<string, IssuedToken>();
  const calls: ApiCall[] = [];
  let seq = 0;

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const notFound = () => json({ message: "Not Found" }, 404);

  function checkJwt(req: Request): boolean {
    const raw = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = raw.split(".");
    if (!h || !p || !s || !app) return false;
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
    if (!ok) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; iat: number; exp: number };
    return claims.iss === String(app.id) && claims.exp > claims.iat && claims.exp - claims.iat <= 660;
  }

  function repoOf(installation: { account: string; repositories: string[] }, fullName: string) {
    return installation.repositories.includes(fullName) ? repos.get(fullName) : undefined;
  }

  function shortName(fullName: string) {
    return fullName.split("/")[1]!;
  }

  function issueJson(repo: FakeRepo, i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? null,
      state: i.state ?? "open",
      user: { login: i.author ?? "alguem" },
      comments: i.comments?.length ?? 0,
      html_url: `https://github.example/${repo.fullName}/${i.pull ? "pull" : "issues"}/${i.number}`,
      ...(i.pull ? { pull_request: { url: `pulls/${i.number}` } } : {}),
    };
  }

  function pullJson(repo: FakeRepo, i: FakeIssue) {
    return {
      ...issueJson(repo, i),
      head: { ref: i.pull!.head },
      base: { ref: i.pull!.base },
      merged: i.pull!.merged ?? false,
    };
  }

  /** As rotas que pedem token de instalação, conferindo repositório e permissão. */
  function withToken(req: Request, path: string, url: URL, body_?: unknown): Response {
    const raw = req.headers.get("authorization")?.replace(/^(token|Bearer) /, "") ?? "";
    const token = tokens.get(raw) ?? null;
    const record = (res: Response) => {
      calls.push({ method: req.method, path, token, status: res.status, userAgent: req.headers.get("user-agent") });
      return res;
    };
    const installation = token ? installations.get(token.installationId) : undefined;
    if (!token || !installation) return record(json({ message: "Bad credentials" }, 401));
    const reach = installation.repositories.filter(
      (r) => token.repositories === null || token.repositories.includes(shortName(r)),
    );
    const need = (perm: string, write = false) => {
      const level = token.permissions[perm];
      return write ? level === "write" : level === "read" || level === "write";
    };
    const bot = `${app?.slug ?? "app"}[bot]`;
    const forbidden = () => json({ message: "Resource not accessible by integration" }, 403);

    if (path === "/installation/repositories") {
      const all = reach.map((r) => repos.get(r)!).filter(Boolean);
      // Paginado como o de verdade: `per_page` (padrão 30, no máximo 100) e `page`.
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
      const page = Number(url.searchParams.get("page") ?? 1);
      const list = all.slice((page - 1) * perPage, page * perPage);
      return record(
        json({
          total_count: all.length,
          repositories: list.map((r) => ({
            full_name: r.fullName,
            name: shortName(r.fullName),
            private: r.private ?? true,
            description: r.description ?? null,
            default_branch: r.defaultBranch ?? "main",
          })),
        }),
      );
    }

    const m = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return record(notFound());
    const fullName = `${m[1]}/${m[2]}`;
    const rest = m[3] ?? "";
    if (!reach.includes(fullName)) return record(notFound());
    const repo = repoOf(installation, fullName);
    if (!repo) return record(notFound());

    if (rest === "" && req.method === "GET")
      return record(
        json({
          full_name: repo.fullName,
          private: repo.private ?? true,
          description: repo.description ?? null,
          default_branch: repo.defaultBranch ?? "main",
          has_issues: true,
        }),
      );

    if (req.method === "POST" && rest === "/issues") {
      if (!need("issues", true)) return record(forbidden());
      const body = (body_ ?? {}) as { title?: string; body?: string };
      if (!body.title) return record(json({ message: "Validation Failed" }, 422));
      repo.issues ??= [];
      const number = Math.max(0, ...repo.issues.map((i) => i.number)) + 1;
      const created: FakeIssue = { number, title: body.title, body: body.body, author: bot };
      repo.issues.push(created);
      return record(json(issueJson(repo, created), 201));
    }
    const commentOn = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (req.method === "POST" && commentOn) {
      const found = repo.issues?.find((i) => i.number === Number(commentOn[1]));
      if (!(need("issues", true) || (found?.pull && need("pull_requests", true)))) return record(forbidden());
      if (!found) return record(notFound());
      const text = ((body_ ?? {}) as { body?: string }).body;
      if (!text) return record(json({ message: "Validation Failed" }, 422));
      const id = 9_000_000 + ++seq;
      found.comments ??= [];
      found.comments.push({ author: bot, body: text, id });
      const kind = found.pull ? "pull" : "issues";
      return record(
        json(
          {
            id,
            body: text,
            user: { login: bot },
            html_url: `https://github.example/${repo.fullName}/${kind}/${found.number}#issuecomment-${id}`,
          },
          201,
        ),
      );
    }
    if (req.method !== "GET") return record(notFound());

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      if (!need("contents")) return record(forbidden());
      const file = decodeURIComponent(contents[1]!);
      const content = repo.files?.[file];
      if (content === undefined) return record(notFound());
      return record(
        json({
          type: "file",
          path: file,
          size: content.length,
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        }),
      );
    }

    const state = url.searchParams.get("state") ?? "open";
    const matchesState = (i: FakeIssue) => state === "all" || (i.state ?? "open") === state;
    if (rest === "/issues") {
      if (!need("issues")) return record(forbidden());
      return record(json((repo.issues ?? []).filter(matchesState).map((i) => issueJson(repo, i))));
    }
    const issue = rest.match(/^\/issues\/(\d+)(\/comments)?$/);
    if (issue) {
      const found = repo.issues?.find((i) => i.number === Number(issue[1]));
      // Os comentários de um pull request saem também com a permissão de pull requests.
      const allowed = need("issues") || (issue[2] && found?.pull && need("pull_requests"));
      if (!allowed) return record(forbidden());
      if (!found) return record(notFound());
      if (issue[2])
        return record(json((found.comments ?? []).map((c) => ({ user: { login: c.author }, body: c.body }))));
      return record(json(issueJson(repo, found)));
    }
    if (rest === "/pulls") {
      if (!need("pull_requests")) return record(forbidden());
      return record(
        json(
          (repo.issues ?? [])
            .filter((i) => i.pull)
            .filter(matchesState)
            .map((i) => pullJson(repo, i)),
        ),
      );
    }
    const pull = rest.match(/^\/pulls\/(\d+)$/);
    if (pull) {
      if (!need("pull_requests")) return record(forbidden());
      const found = repo.issues?.find((i) => i.pull && i.number === Number(pull[1]));
      return record(found ? json(pullJson(repo, found)) : notFound());
    }
    return record(notFound());
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // ---------- web: o navegador do Admin ----------
      const newApp = path.match(/^(?:\/organizations\/([^/]+))?\/settings\/apps\/new$/);
      if (newApp && req.method === "POST") {
        const form = await req.formData();
        const manifest = JSON.parse(String(form.get("manifest"))) as Record<string, unknown>;
        const code = `codigo-${++seq}`;
        manifests.set(code, { manifest, owner: newApp[1] ?? "pessoa-admin" });
        const back = new URL(String(manifest.redirect_url));
        back.searchParams.set("code", code);
        const state = url.searchParams.get("state");
        if (state) back.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      const install = path.match(/^\/apps\/([^/]+)\/installations\/new$/);
      if (install && req.method === "GET") {
        if (!app || app.slug !== install[1]) return notFound();
        const id = 70_000 + ++seq;
        installations.set(id, {
          account: nextInstall.account ?? app.owner,
          repositories: nextInstall.repositories ?? [...repos.keys()],
        });
        const back = new URL(String(app.manifest.setup_url));
        back.searchParams.set("installation_id", String(id));
        back.searchParams.set("setup_action", "install");
        const state = url.searchParams.get("state");
        if (state) back.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }

      // ---------- API ----------
      if (!path.startsWith("/api/")) return notFound();
      const apiPath = path.slice("/api".length);

      const conversion = apiPath.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (conversion && req.method === "POST") {
        const found = manifests.get(conversion[1]!);
        if (!found) return notFound();
        manifests.delete(conversion[1]!);
        const name = nextAppName ?? String(found.manifest.name);
        nextAppName = undefined;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        app = {
          id: 4200 + ++seq,
          slug,
          name,
          owner: found.owner,
          manifest: found.manifest,
        };
        return json(
          {
            id: app.id,
            slug,
            name: app.name,
            owner: { login: found.owner },
            html_url: `${url.origin}/apps/${slug}`,
            client_id: "Iv1.cliente",
            client_secret: "segredo-do-cliente-do-app",
            webhook_secret: "segredo-do-webhook-do-app",
            pem: privateKey,
            permissions: found.manifest.default_permissions ?? APP_PERMISSIONS_FALLBACK,
          },
          201,
        );
      }

      const inst = apiPath.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/);
      if (inst) {
        if (!checkJwt(req)) return json({ message: "A JSON web token could not be decoded" }, 401);
        const id = Number(inst[1]);
        const installation = installations.get(id);
        if (!installation) return notFound();
        if (!inst[2]) return json({ id, account: { login: installation.account }, app_id: app!.id });
        const body = (await req.json().catch(() => ({}))) as { repositories?: string[]; permissions?: Permissions };
        const names = installation.repositories.map(shortName);
        if (body.repositories?.some((r) => !names.includes(r)))
          return json({ message: "There is at least one repository that does not exist or is not accessible" }, 422);
        const appPerms = (app!.manifest.default_permissions as Permissions | undefined) ?? APP_PERMISSIONS_FALLBACK;
        const permissions = body.permissions ?? appPerms;
        for (const [perm, level] of Object.entries(permissions)) {
          const has = appPerms[perm];
          if (!has || (level === "write" && has !== "write"))
            return json({ message: `The permissions requested are not granted to this installation: ${perm}` }, 422);
        }
        const issued: IssuedToken = {
          token: `ghs_${crypto.randomUUID().replaceAll("-", "")}`,
          installationId: id,
          repositories: body.repositories ?? null,
          permissions,
        };
        tokens.set(issued.token, issued);
        return json({ token: issued.token, expires_at: "2099-01-01T00:00:00Z", permissions }, 201);
      }

      const sent = req.method === "POST" ? await req.json().catch(() => null) : undefined;
      return withToken(req, apiPath, url, sent);
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    /** O que o app recebe em `deps.github`. */
    config: { webUrl: base, apiUrl: `${base}/api` },
    /** Um repositório na conta do time (antes de instalar: a instalação alcança os que existem). */
    repo(repo: FakeRepo) {
      repos.set(repo.fullName, repo);
    },
    /** O que o Admin escolhe na próxima página de instalação (padrão: todos os repositórios). */
    willInstall(choice: { account?: string; repositories?: string[] }) {
      nextInstall = choice;
    },
    /**
     * O nome com que o GitHub guarda o próximo App, no lugar do nome do manifest (um App criado
     * antes, com outro nome, ou renomeado pelo Admin no GitHub).
     */
    nameNextApp(name: string) {
      nextAppName = name;
    },
    /** O manifest com que o App foi criado. */
    get app() {
      return app;
    },
    /** As issues (e pull requests) de um repositório agora, com os comentários. */
    issuesOf(fullName: string): FakeIssue[] {
      return repos.get(fullName)?.issues ?? [];
    },
    /** Remove a instalação no GitHub (o Admin desinstalou o App lá). */
    uninstall() {
      installations.clear();
    },
    /** Os tokens de instalação emitidos, na ordem. */
    get tokens() {
      return [...tokens.values()];
    },
    /** As chamadas feitas com token de instalação, na ordem. */
    get calls() {
      return [...calls];
    },
    stop: () => server.stop(true),
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;
