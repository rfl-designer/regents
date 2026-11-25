import { type ReadTool, type ToolDefinition, ToolFailure } from "../tools/port";
import type { GitHub, GitHubPermissions } from "./connector";

/** O tamanho máximo de um arquivo que volta ao modelo (o resto é cortado, com aviso). */
const MAX_FILE_CHARS = 60_000;
/** Quantas issues ou pull requests uma listagem traz. */
const PAGE = 30;

const REPO = {
  type: "string",
  description: "O repositório, como dono/nome (ex.: time/site). Veja os que existem em listar repositórios.",
};
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

/**
 * As Ferramentas do GitHub (ADR 0010; Spec #44): só leitura por enquanto. Cada chamada pede um
 * token de instalação novo, limitado ao repositório da chamada e às permissões desta Ferramenta.
 */
export function githubTools(github: GitHub): ToolDefinition[] {
  /** Uma leitura do GitHub com as permissões dela, num repositório (ou em todos, `repository: false`). */
  const read = (
    def: Omit<ReadTool, "origin" | "access" | "run">,
    permissions: GitHubPermissions,
    run: (
      api: Awaited<ReturnType<GitHub["session"]>>,
      input: unknown,
      repository: string | undefined,
    ) => Promise<string>,
    opts: { repository?: boolean } = {},
  ): ReadTool => ({
    ...def,
    origin: "github",
    access: "read",
    async run(_ctx, input, signal) {
      const repository = opts.repository === false ? undefined : str(input, "repositorio", "o repositório");
      if (repository) repoPath(repository);
      return run(await github.session({ repository, permissions }, signal), input, repository);
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
        const res = await api.get<{
          repositories: {
            full_name: string;
            private: boolean;
            description: string | null;
            default_branch: string;
          }[];
        }>("/installation/repositories?per_page=100");
        const list = res?.repositories ?? [];
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
    ),
  ];
}
