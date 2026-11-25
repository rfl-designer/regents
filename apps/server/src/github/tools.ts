import { type ReadTool, type ToolDefinition, ToolFailure, WRITE_NOTE, type WriteTool } from "../tools/port";
import { type GitHub, type GitHubPermissions, installationRepositoriesOf } from "./connector";

/** O tamanho máximo de um arquivo que volta ao modelo (o resto é cortado, com aviso). */
const MAX_FILE_CHARS = 60_000;
/** Os limites do GitHub para o título de uma issue e para um corpo (de issue ou de comentário). */
const TITLE_MAX = 256;
const BODY_MAX = 65_536;
/** Quantas issues ou pull requests uma listagem traz. */
const PAGE = 30;

const REPO = {
  type: "string",
  description: "O repositório, como dono/nome (ex.: time/site). Veja os que existem em listar repositórios.",
};
/** Um nome de repositório do GitHub (`dono/nome`), o único texto do modelo que o rótulo repete. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER = { type: "integer", minimum: 1, description: "O número da issue ou do pull request." };
const STATE = {
  type: "string",
  enum: ["abertas", "fechadas", "todas"],
  description: "Quais trazer (padrão: abertas).",
};

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  html_url: string;
  pull_request?: unknown;
}
interface Pull extends Issue {
  head: { ref: string };
  base: { ref: string };
  merged?: boolean;
}
interface Comment {
  user: { login: string } | null;
  body: string;
}

function str(input: unknown, key: string, label: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolFailure(`informe ${label}`);
  return v.trim();
}

function num(input: unknown, key: string): number {
  const v = (input as Record<string, unknown> | null)?.[key];
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ToolFailure("informe o número");
  return n;
}

function stateOf(input: unknown): "open" | "closed" | "all" {
  const v = (input as Record<string, unknown> | null)?.estado;
  if (v === undefined || v === null || v === "abertas") return "open";
  if (v === "fechadas") return "closed";
  if (v === "todas") return "all";
  throw new ToolFailure("o estado é abertas, fechadas ou todas");
}

/** `dono/nome` para o caminho da API, cada parte codificada. */
function repoPath(repository: string) {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) throw new ToolFailure("informe o repositório como dono/nome");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

const stateText = (s: string, female: boolean) =>
  s === "open" ? (female ? "aberta" : "aberto") : female ? "fechada" : "fechado";

const comments = (list: Comment[]) =>
  list.length
    ? ["", "Comentários:", ...list.map((c) => `- ${c.user?.login ?? "?"}: ${c.body}`)]
    : ["", "Sem comentários."];

/** "lendo a issue 214 de time/site"; sem número válido, "lendo uma issue de time/site". */
function numbered(what: "a issue" | "o pull request", repository: string, input: unknown) {
  const n = (input as Record<string, unknown> | null)?.numero;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return `lendo ${what} ${n} de ${repository}`;
  return `lendo ${what === "a issue" ? "uma issue" : "um pull request"} de ${repository}`;
}

function text(input: unknown, key: string, label: string, max: number, optional = false): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if ((v === undefined || v === null || v === "") && optional) return "";
  if (typeof v !== "string" || !v.trim()) throw new ToolFailure(`informe ${label}`);
  if (v.trim().length > max) throw new ToolFailure(`${label} passa de ${max} caracteres`);
  return v.trim();
}

/**
 * As Ferramentas do GitHub (ADR 0010; Spec #44). Cada chamada pede um token de instalação novo,
 * limitado ao repositório da chamada e às permissões desta Ferramenta. As escritas (criar issue,
 * comentar) viram Pedido de aprovação (ADR 0011) e só saem, como o bot do App, quando o autor aprova.
 */
export function githubTools(github: GitHub): ToolDefinition[] {
  /**
   * A lista do Agente (#58): um repositório fora dela falha antes de chegar ao GitHub. Vale para
   * as leituras, e para as escritas ao criar o Pedido e de novo ao executá-lo.
   */
  async function withinAgent(agentId: string, repository: string) {
    const allowed = await github.repositoriesOf(agentId);
    if (allowed && !allowed.some((r) => r.toLowerCase() === repository.toLowerCase()))
      throw new ToolFailure(
        `o repositório ${repository} não está entre os repositórios do GitHub que este Agente alcança`,
      );
    return allowed;
  }

  /**
   * Uma leitura do GitHub com as permissões dela, num repositório (ou em todos, `repository: false`).
   * `named` é o rótulo com o repositório ("lendo a issue 214 de time/site"), quando o repositório é
   * um nome do GitHub que o Agente alcança; senão, vale o genérico.
   */
  const read = (
    def: Omit<ReadTool, "origin" | "access" | "run">,
    permissions: GitHubPermissions,
    run: (
      api: Awaited<ReturnType<GitHub["session"]>>,
      input: unknown,
      repository: string | undefined,
    ) => Promise<string>,
    opts: { repository?: boolean; named?: (repository: string, input: unknown) => string } = {},
  ): ReadTool => ({
    ...def,
    origin: "github",
    access: "read",
    ...(opts.named
      ? {
          async describe(ctx, input) {
            const repository = (input as Record<string, unknown> | null)?.repositorio;
            if (typeof repository !== "string" || !REPO_NAME.test(repository.trim())) return {};
            await withinAgent(ctx.run.agentId, repository.trim());
            return { label: opts.named!(repository.trim(), input) };
          },
        }
      : {}),
    async run(ctx, input, signal) {
      const repository = opts.repository === false ? undefined : str(input, "repositorio", "o repositório");
      if (repository) repoPath(repository);
      // A lista do Agente (#58): o token nem pede os outros repositórios, então eles não aparecem
      // numa listagem e uma leitura deles falha antes de chegar ao GitHub.
      const allowed = repository
        ? await withinAgent(ctx.run.agentId, repository)
        : await github.repositoriesOf(ctx.run.agentId);
      const scope = repository ? { repository } : { repositories: allowed ?? undefined };
      return run(await github.session({ ...scope, permissions }, signal), input, repository);
    },
  });

  return [
    read(
      {
        id: "github_listar_repositorios",
        title: "listar repositórios do GitHub",
        label: "listando os repositórios do GitHub",
        description: "Lista os repositórios do GitHub que o Workspace alcança, com a descrição e a branch padrão.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      { metadata: "read" },
      async (api) => {
        const list = await installationRepositoriesOf<{
          full_name: string;
          private: boolean;
          description: string | null;
          default_branch: string;
        }>(api);
        if (!list.length) return "Nenhum repositório: o GitHub App não alcança nenhum.";
        return list
          .map(
            (r) =>
              `- ${r.full_name} (${r.private ? "privado" : "público"}, branch ${r.default_branch}): ${r.description || "sem descrição"}`,
          )
          .join("\n");
      },
      { repository: false },
    ),

    read(
      {
        id: "github_ler_arquivo",
        title: "ler arquivo do GitHub",
        label: "lendo um arquivo do GitHub",
        description:
          "Lê um arquivo (ou lista uma pasta) de um repositório do GitHub, na branch padrão ou numa referência.",
        inputSchema: {
          type: "object",
          properties: {
            repositorio: REPO,
            caminho: { type: "string", description: "O caminho no repositório (ex.: src/app.ts). Vazio: a raiz." },
            ref: { type: "string", description: "Branch, tag ou commit (padrão: a branch padrão)." },
          },
          required: ["repositorio", "caminho"],
          additionalProperties: false,
        },
      },
      { contents: "read" },
      async (api, input, repository) => {
        const raw = (input as { caminho?: unknown }).caminho;
        const path = typeof raw === "string" ? raw.replace(/^\/+|\/+$/g, "") : "";
        const ref = (input as { ref?: unknown }).ref;
        const query = typeof ref === "string" && ref.trim() ? `?ref=${encodeURIComponent(ref.trim())}` : "";
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        const got = await api.get<
          | { type: string; path: string; content?: string; encoding?: string }
          | { type: string; path: string; name: string }[]
        >(`${repoPath(repository!)}/contents/${encoded}${query}`);
        if (!got) throw new ToolFailure(`não achei ${path || "a raiz"} em ${repository}`);
        if (Array.isArray(got))
          return [
            `Pasta ${path || "/"} de ${repository}:`,
            ...got.map((e) => `- ${e.path}${e.type === "dir" ? "/" : ""}`),
          ].join("\n");
        if (got.type !== "file" || got.content === undefined)
          throw new ToolFailure(`${path} em ${repository} não é um arquivo`);
        const text = Buffer.from(got.content, got.encoding === "base64" ? "base64" : "utf8").toString("utf8");
        const cut = text.length > MAX_FILE_CHARS;
        return [
          `Arquivo ${got.path} de ${repository}:`,
          "",
          cut ? text.slice(0, MAX_FILE_CHARS) : text,
          ...(cut ? ["", `(cortado em ${MAX_FILE_CHARS} caracteres)`] : []),
        ].join("\n");
      },
      { named: (repo) => `lendo um arquivo de ${repo}` },
    ),

    read(
      {
        id: "github_listar_issues",
        title: "listar issues do GitHub",
        label: "listando as issues do GitHub",
        description: `Lista as issues de um repositório do GitHub (até ${PAGE}, as mais recentes), sem os pull requests.`,
        inputSchema: {
          type: "object",
          properties: { repositorio: REPO, estado: STATE },
          required: ["repositorio"],
          additionalProperties: false,
        },
      },
      { issues: "read" },
      async (api, input, repository) => {
        const list = await api.get<Issue[]>(`${repoPath(repository!)}/issues?state=${stateOf(input)}&per_page=${PAGE}`);
        if (!list) throw new ToolFailure(`não achei o repositório ${repository}`);
        const issues = list.filter((i) => !i.pull_request);
        if (!issues.length) return `Nenhuma issue em ${repository}.`;
        return issues
          .map((i) => `- #${i.number} [${stateText(i.state, true)}] ${i.title} (por ${i.user?.login ?? "?"})`)
          .join("\n");
      },
      { named: (repo) => `listando as issues de ${repo}` },
    ),

    read(
      {
        id: "github_ler_issue",
        title: "ler issue do GitHub",
        label: "lendo uma issue do GitHub",
        description: "Lê uma issue de um repositório do GitHub, com a descrição e os comentários.",
        inputSchema: {
          type: "object",
          properties: { repositorio: REPO, numero: NUMBER },
          required: ["repositorio", "numero"],
          additionalProperties: false,
        },
      },
      { issues: "read" },
      async (api, input, repository) => {
        const n = num(input, "numero");
        const issue = await api.get<Issue>(`${repoPath(repository!)}/issues/${n}`);
        if (!issue) throw new ToolFailure(`não achei a issue ${n} em ${repository}`);
        if (issue.pull_request) return `#${n} em ${repository} é um pull request: use ler pull request do GitHub.`;
        const list = (await api.get<Comment[]>(`${repoPath(repository!)}/issues/${n}/comments?per_page=50`)) ?? [];
        return [
          `Issue #${issue.number} de ${repository} [${stateText(issue.state, true)}]: ${issue.title}`,
          `Por ${issue.user?.login ?? "?"} · ${issue.html_url}`,
          "",
          issue.body || "(sem descrição)",
          ...comments(list),
        ].join("\n");
      },
      { named: (repo, input) => numbered("a issue", repo, input) },
    ),

    read(
      {
        id: "github_listar_pull_requests",
        title: "listar pull requests do GitHub",
        label: "listando os pull requests do GitHub",
        description: `Lista os pull requests de um repositório do GitHub (até ${PAGE}, os mais recentes).`,
        inputSchema: {
          type: "object",
          properties: { repositorio: REPO, estado: STATE },
          required: ["repositorio"],
          additionalProperties: false,
        },
      },
      { pull_requests: "read" },
      async (api, input, repository) => {
        const list = await api.get<Pull[]>(`${repoPath(repository!)}/pulls?state=${stateOf(input)}&per_page=${PAGE}`);
        if (!list) throw new ToolFailure(`não achei o repositório ${repository}`);
        if (!list.length) return `Nenhum pull request em ${repository}.`;
        return list
          .map(
            (p) =>
              `- #${p.number} [${stateText(p.state, false)}] ${p.title} (${p.head.ref} → ${p.base.ref}, por ${p.user?.login ?? "?"})`,
          )
          .join("\n");
      },
      { named: (repo) => `listando os pull requests de ${repo}` },
    ),

    read(
      {
        id: "github_ler_pull_request",
        title: "ler pull request do GitHub",
        label: "lendo um pull request do GitHub",
        description: "Lê um pull request de um repositório do GitHub, com a descrição, as branches e os comentários.",
        inputSchema: {
          type: "object",
          properties: { repositorio: REPO, numero: NUMBER },
          required: ["repositorio", "numero"],
          additionalProperties: false,
        },
      },
      { pull_requests: "read" },
      async (api, input, repository) => {
        const n = num(input, "numero");
        const pull = await api.get<Pull>(`${repoPath(repository!)}/pulls/${n}`);
        if (!pull) throw new ToolFailure(`não achei o pull request ${n} em ${repository}`);
        const list = (await api.get<Comment[]>(`${repoPath(repository!)}/issues/${n}/comments?per_page=50`)) ?? [];
        const state = pull.merged ? "mesclado" : stateText(pull.state, false);
        return [
          `Pull request #${pull.number} de ${repository} [${state}]: ${pull.title}`,
          `${pull.head.ref} → ${pull.base.ref} · por ${pull.user?.login ?? "?"} · ${pull.html_url}`,
          "",
          pull.body || "(sem descrição)",
          ...comments(list),
        ].join("\n");
      },
      { named: (repo, input) => numbered("o pull request", repo, input) },
    ),

    {
      id: "github_criar_issue",
      title: "criar issue no GitHub",
      label: "preparando a issue do GitHub",
      description: `Cria uma issue num repositório do GitHub, como o bot do GitHub App. ${WRITE_NOTE}`,
      origin: "github",
      access: "write",
      inputSchema: {
        type: "object",
        properties: {
          repositorio: REPO,
          titulo: { type: "string", description: "O título exato da issue." },
          corpo: { type: "string", description: "A descrição exata da issue, em Markdown (opcional)." },
        },
        required: ["repositorio", "titulo"],
        additionalProperties: false,
      },
      async prepare(ctx, input, signal) {
        const asked = str(input, "repositorio", "o repositório");
        repoPath(asked);
        const title = text(input, "titulo", "o título", TITLE_MAX);
        const body = text(input, "corpo", "a descrição", BODY_MAX, true);
        await withinAgent(ctx.run.agentId, asked);
        // Confere já que o GitHub alcança o repositório: a falha aparece antes do Pedido, não depois.
        const api = await github.session({ repository: asked, permissions: { metadata: "read" } }, signal);
        const repo = await api.get<{ full_name: string }>(repoPath(asked));
        if (!repo) throw new ToolFailure(`não achei o repositório ${asked}`);
        const repository = repo.full_name;
        return {
          action: { repository, title, body },
          summary: `Criar uma issue em ${repository}, com o título “${title}” e ${body ? `a descrição “${body}”` : "sem descrição"}`,
        };
      },
      async perform(ctx, action, signal) {
        const repository = String(action.repository);
        await withinAgent(ctx.run.agentId, repository);
        const api = await github.session({ repository, permissions: { issues: "write" } }, signal);
        const created = await api.post<Issue>(`${repoPath(repository)}/issues`, {
          title: String(action.title),
          ...(action.body ? { body: String(action.body) } : {}),
        });
        if (!created) throw new ToolFailure(`não achei o repositório ${repository}`);
        return `issue #${created.number} criada em ${repository}: ${created.html_url}`;
      },
    } satisfies WriteTool,

    {
      id: "github_comentar",
      title: "comentar no GitHub",
      label: "preparando o comentário no GitHub",
      description: `Comenta numa issue ou num pull request de um repositório do GitHub, como o bot do GitHub App. ${WRITE_NOTE}`,
      origin: "github",
      access: "write",
      inputSchema: {
        type: "object",
        properties: {
          repositorio: REPO,
          numero: NUMBER,
          texto: { type: "string", description: "O texto exato do comentário, em Markdown." },
        },
        required: ["repositorio", "numero", "texto"],
        additionalProperties: false,
      },
      async prepare(ctx, input, signal) {
        const asked = str(input, "repositorio", "o repositório");
        repoPath(asked);
        const number = num(input, "numero");
        const body = text(input, "texto", "o texto do comentário", BODY_MAX);
        await withinAgent(ctx.run.agentId, asked);
        // Lê o alvo: confirma que existe e diz no resumo se é issue ou pull request, e qual.
        const api = await github.session(
          { repository: asked, permissions: { issues: "read", pull_requests: "read" } },
          signal,
        );
        const target = await api.get<Issue>(`${repoPath(asked)}/issues/${number}`);
        if (!target) throw new ToolFailure(`não achei a issue ou o pull request ${number} em ${asked}`);
        const pull = Boolean(target.pull_request);
        const where = `${pull ? "no pull request" : "na issue"} #${number} de ${asked}`;
        return {
          action: { repository: asked, number, pull, body },
          summary: `Comentar ${where} (“${target.title}”): “${body}”`,
        };
      },
      async perform(ctx, action, signal) {
        const repository = String(action.repository);
        const number = Number(action.number);
        const pull = action.pull === true;
        await withinAgent(ctx.run.agentId, repository);
        // Num pull request, a permissão de escrita é a de pull requests; numa issue, a de issues.
        const permissions: GitHubPermissions = pull ? { pull_requests: "write" } : { issues: "write" };
        const api = await github.session({ repository, permissions }, signal);
        const where = `${pull ? "no pull request" : "na issue"} #${number} de ${repository}`;
        const created = await api.post<{ html_url: string }>(`${repoPath(repository)}/issues/${number}/comments`, {
          body: String(action.body),
        });
        if (!created)
          throw new ToolFailure(`não achei ${pull ? "o pull request" : "a issue"} ${number} em ${repository}`);
        return `comentário publicado ${where}: ${created.html_url}`;
      },
    } satisfies WriteTool,
  ];
}
