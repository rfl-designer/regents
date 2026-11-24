/**
 * O roteiro do `fake-claude`: o que o binário falso faz em cada subcomando.
 * O teste grava o roteiro (`fake.script({...})`) e o binário o relê a cada start,
 * então dá para mudar o comportamento entre um passo e outro do mesmo teste.
 */

/** A conta que a "página da Anthropic" loga. Os nomes dos campos são os do `auth status --json` real. */
export interface FakeAccount {
  email: string;
  orgId: string;
  orgName: string;
  /** `pro` | `max` | `team` | `enterprise` ... */
  subscriptionType: string;
  /** Ex. `max_5x`. */
  planTier: string | null;
  /** ISO 8601. */
  loginExpiresAt: string;
}

/** Categorias de `assistant.error` do `stream-json` (ver nota 02 / `sdk.d.ts`). */
export type AssistantErrorCategory =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "account_on_hold"
  | "verification_required"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown";

/**
 * O que `claude -p` faz. Hoje cobre a chamada mínima de validação da Conta.
 * O #26 acrescenta aqui um `{ kind: "steps", steps: [...] }` com texto em deltas,
 * pensamento, silêncio, `api_retry`, `rate_limit_event`, morte e resposta a `SIGINT`.
 */
export type FakeRun =
  /** Responde `text` em deltas e termina com `result` de sucesso, exit 0. */
  | { kind: "reply"; text?: string; credentialExpiresAt?: string }
  /** `assistant` com `error` e `result` com `is_error: true`, exit 1 (como o binário real). */
  | { kind: "error"; error: AssistantErrorCategory; apiErrorStatus?: number | null; message?: string }
  /** Sai sem `result`, com este exit code. */
  | { kind: "die"; exitCode?: number }
  /** Fica mudo para sempre (até levar sinal). */
  | { kind: "hang" };

export interface FakeClaudeScript {
  login?: {
    /**
     * `ok` (padrão): imprime a URL (num hyperlink OSC 8) e lê o código no stdin.
     * `silent`: não imprime nada e não sai. `die`: sai 1 sem imprimir a URL.
     */
    mode?: "ok" | "silent" | "die";
    /** O código que a página mostra; outro código colado sai 1. Padrão: `FAKE_LOGIN_CODE`. */
    code?: string;
    /** Quem entra. O que faltar vem de `DEFAULT_FAKE_ACCOUNT`. */
    account?: Partial<FakeAccount>;
  };
  /** Padrão: `{ kind: "reply", text: "ok" }`. */
  run?: FakeRun;
}

export const FAKE_LOGIN_CODE = "codigo-da-pagina-da-anthropic";

export const DEFAULT_FAKE_ACCOUNT: FakeAccount = {
  email: "fulana@exemplo.com",
  orgId: "org-fulana",
  orgName: "fulana@exemplo.com's Organization",
  subscriptionType: "max",
  planTier: "max_5x",
  loginExpiresAt: "2026-12-24T12:00:00.000Z",
};

/** O token falso que o login grava na pasta. Nenhuma resposta do Shearim deve contê-lo. */
export const FAKE_ACCESS_TOKEN = "sk-ant-oat01-TOKEN-FALSO-QUE-O-SHEARIM-NUNCA-LE";

/** Uma linha do log de chamadas: um start do binário. */
export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}
