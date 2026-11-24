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

/** Um passo roteirizado de um `claude -p` (`{ kind: "steps" }`), na ordem. */
export type FakeStep =
  /**
   * Um bloco de texto, em deltas de até 8 caracteres (`stream_event` com `text_delta`).
   * `{resultado}` no texto vira o resultado da última Ferramenta chamada (`{ tool }`).
   */
  | { text: string }
  /**
   * Chama uma Ferramenta como o Claude Code: como cliente MCP de verdade, conecta no servidor do
   * `--mcp-config` (na primeira vez, com `tools/list`), emite o `tool_use` (`mcp__<servidor>__<name>`)
   * no `stream-json`, chama `tools/call`, emite o `tool_result` e começa um turno novo. Cada passo
   * vai para `fake.mcp()`.
   */
  | { tool: { name: string; input?: Record<string, unknown> } }
  /** Um bloco de pensamento (`thinking` vazio, como nos modelos atuais). */
  | { thinking: true }
  /** Fica mudo por um tempo (de verdade: é um processo). */
  | { sleepMs: number }
  /** Fica mudo para sempre, até levar sinal. */
  | { hang: true }
  /** `system/api_retry`: a API está sendo tentada de novo. */
  | { apiRetry: { attempt: number; max: number; error?: AssistantErrorCategory; errorStatus?: number | null } }
  /** `rate_limit_event`. `resetsAt` em segundos desde a época, como no binário real. */
  | {
      rateLimit: {
        status: "allowed" | "allowed_warning" | "rejected";
        resetsAt?: number;
        rateLimitType?: string;
        isUsingOverage?: boolean;
      };
    }
  /** Morre aqui, sem `result`, com este exit code. */
  | { die: number };

/** Como um `{ kind: "steps" }` termina, se os passos não morreram nem travaram. */
export type FakeEnd =
  /** `result` de sucesso, exit 0. `text` padrão: o texto dos passos. */
  | {
      result: "success";
      text?: string;
      credentialExpiresAt?: string;
      /** Vai em `result.structured_output` (o que o `--json-schema` devolve). */
      structuredOutput?: unknown;
      costUsd?: number;
      usage?: { input_tokens: number; output_tokens: number };
      /** Depois do `result`, fica de pé em vez de sair (até levar sinal). */
      lingers?: boolean;
    }
  /** `assistant` com `error` (se houver) e `result` com `is_error: true`, `subtype: "success"`, exit 1. */
  | {
      result: "error";
      error?: AssistantErrorCategory;
      apiErrorStatus?: number | null;
      message?: string;
      /** Padrão: `api_error`. */
      terminalReason?: string;
    };

/**
 * O que `claude -p` faz. `reply`, `error`, `die` e `hang` cobrem a chamada mínima de validação;
 * `steps` roteiriza uma execução inteira, passo a passo.
 *
 * Todo `-p` registra os sinais que leva (`fake.signals()`). No `SIGINT`, o padrão (`abort`) é o
 * do binário real: `result` com `aborted_streaming` e exit 0; `ignore` fica de pé, para testar a
 * escalada para `SIGTERM`. No `SIGTERM`, o padrão (`exit`) sai 143 sem `result`; `ignore` fica de
 * pé até o `SIGKILL`.
 */
export type FakeRun =
  /** Responde `text` em deltas e termina com `result` de sucesso, exit 0. */
  (
    | { kind: "reply"; text?: string; credentialExpiresAt?: string }
    /** `assistant` com `error` e `result` com `is_error: true`, exit 1 (como o binário real). */
    | { kind: "error"; error: AssistantErrorCategory; apiErrorStatus?: number | null; message?: string }
    /** Sai sem `result`, com este exit code. */
    | { kind: "die"; exitCode?: number }
    /** Fica mudo para sempre (até levar sinal). */
    | { kind: "hang" }
    /** Os passos em ordem e, se nenhum morreu nem travou, o fim (padrão: sucesso). */
    | { kind: "steps"; steps: FakeStep[]; end?: FakeEnd }
  ) & { onSigint?: "abort" | "ignore"; onSigterm?: "exit" | "ignore" };

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
  /**
   * Uma fila de roteiros, um por start do `-p`: cada start tira o primeiro. Vazia, vale `run`.
   * Para "a 1ª tentativa trava, a 2ª responde".
   */
  runs?: FakeRun[];
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
  pid: number;
  argv: string[];
  /** O que chegou pelo stdin (só no `-p`, lido até o fim antes de começar). */
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
}

/** Um passo do `fake-claude` como cliente MCP (`fake.mcp()`). */
export type FakeMcpEntry =
  | { pid: number; listed: string[] }
  | { pid: number; called: string; input: unknown; result: { content: string; isError: boolean } }
  /** O endpoint recusou (o status HTTP, quando veio) ou não respondeu. */
  | { pid: number; refused: string };

/** Um sinal que um `-p` levou. */
export interface FakeClaudeSignal {
  pid: number;
  signal: "SIGINT" | "SIGTERM";
  /** `Date.now()` de quando chegou. */
  at: number;
}
