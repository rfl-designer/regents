import { eq } from "drizzle-orm";
import { type AccountStanding, accountStanding } from "./accounts";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { KeyLedger } from "./key-budget";
import type { Spent } from "./model/call";
import type { Payer, TerminalModelEvent } from "./model/port";
import type { SecretBox } from "./secrets";
import { readWorkspaceKey } from "./workspace-key";

/**
 * Quem paga uma chamada de modelo: o que as execuções (`executions.ts`) e a Sincronização da Wiki
 * (`wiki/sync.ts`) dividem da tabela de quem paga (Spec, módulo 6; ADR 0002).
 */

/**
 * "Chave utilizável" (Spec, módulo 6): existe Chave e o Agente tem orçamento no mês (conferido
 * antes de cada chamada pela Chave, inclusive na troca no meio). Sem ela, o motivo (o de todos,
 * sem a Conta).
 */
export async function keyUsable(
  deps: { db: Db; secrets: SecretBox; ledger: Pick<KeyLedger, "usable"> },
  agentId: string,
): Promise<{ apiKey: string } | { reason: string }> {
  const apiKey = await readWorkspaceKey(deps.db, deps.secrets);
  if (!apiKey) return { reason: "o Workspace não tem Chave" };
  const budget = await deps.ledger.usable(agentId);
  return budget.ok ? { apiKey } : { reason: budget.reason };
}

/** A chamada pela Chave, se a Chave é utilizável para o Agente; senão, o motivo. */
export async function keyPayer(
  deps: Parameters<typeof keyUsable>[0],
  agentId: string,
): Promise<Extract<Payer, { kind: "key" }> | { kind: "none"; reason: string }> {
  const key = await keyUsable(deps, agentId);
  return "apiKey" in key ? { kind: "key", apiKey: key.apiKey } : { kind: "none", reason: key.reason };
}

/** O porquê de a Conta não pagar, para o motivo de "sem quem pague". */
const ACCOUNT_WHY: Record<Exclude<AccountStanding["state"], "linked">, string> = {
  limited: "está no limite",
  needs_relink: "precisa ser ligada de novo",
  not_linked: "não está ligada",
};

/**
 * A tabela de quem paga (Spec, módulo 6) para quem não espera na fila: a Conta de `memberId`
 * Ligada paga; senão, a Chave utilizável; senão, ninguém, com o motivo dos dois lados (`account`:
 * "está no limite"; `key`: "o Workspace não tem Chave"). A Sincronização da Wiki decide assim antes
 * de cada chamada (#80).
 */
export async function accountOrKey(
  deps: Parameters<typeof keyUsable>[0] & { clock: Clock },
  memberId: string,
  agentId: string,
): Promise<Payer | { kind: "none"; account: string; key: string }> {
  const [row] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.memberId, memberId));
  const standing = accountStanding(row, deps.clock.now());
  if (standing.state === "linked") return { kind: "account", memberId, configDir: standing.configDir };
  const key = await keyPayer(deps, agentId);
  if (key.kind === "key") return key;
  return { kind: "none", account: ACCOUNT_WHY[standing.state], key: key.reason };
}

/**
 * O que as execuções e a Sincronização pedem às Contas: marcar o que a chamada pela Conta viu, para que as
 * próximas nem tentem por ela (Spec, módulo 6, "Troca no meio").
 */
export interface PayingAccounts {
  markLimited(memberId: string, configDir: string, until: Date | null): Promise<void>;
  markNeedsRelink(memberId: string, configDir: string): Promise<void>;
  /**
   * Segura a pasta `configDir` enquanto um `claude -p` roda nela: depois de ligar de novo, a pasta
   * antiga só é apagada quando o último solta (ADR 0005). `null` quando a pasta já saiu de uso (a
   * Conta acabou de ser ligada de novo): a execução volta para a fila e decide de novo quem paga.
   */
  lease(configDir: string): (() => void) | null;
  /** O fim com sucesso pela pasta `configDir`: a validade (`credential_expires_at`) e o uso extra. */
  runEnded(
    memberId: string,
    configDir: string,
    seen: { credentialExpiresAt?: Date; extraUsage?: boolean },
  ): Promise<void>;
}

/**
 * Uma chamada pela Chave acabou, chegando ou não ao fim (cancelada, parada pela vigia, falha no
 * meio): a recusa da Anthropic (`auth_failed`, `billing_failed`) abre o incidente da Chave, e o uso
 * que a API informou conta no orçamento do Agente (`by`), no modelo que respondeu.
 */
export async function keyCallEnded(
  ledger: Pick<KeyLedger, "charged" | "refused">,
  by: Parameters<KeyLedger["charged"]>[0],
  spent: Spent,
  end: TerminalModelEvent | undefined,
) {
  if (end?.type === "auth_failed" || end?.type === "billing_failed") await ledger.refused(end.type);
  if (spent.usage) {
    await ledger.charged(by, { ...spent.usage, startedAt: spent.startedAt, succeeded: spent.succeeded === true });
  }
}

/**
 * Uma chamada pela Conta acabou (Spec, módulo 6, "Troca no meio"): no limite ou recusada, a Conta
 * fica "No limite até HH:MM" ou "Precisa ligar de novo", e quem chama decide de novo quem paga
 * (`decide_again`: o parcial é descartado e a chamada é refeita inteira). No `done`, a validade da
 * credencial e o uso extra.
 */
export async function accountCallEnded(
  accounts: Pick<PayingAccounts, "markLimited" | "markNeedsRelink" | "runEnded">,
  payer: Extract<Payer, { kind: "account" }>,
  end: TerminalModelEvent | undefined,
): Promise<"decide_again" | "settled"> {
  if (end?.type === "limit") {
    await accounts.markLimited(payer.memberId, payer.configDir, end.resetsAt);
    return "decide_again";
  }
  if (end?.type === "auth_failed") {
    await accounts.markNeedsRelink(payer.memberId, payer.configDir);
    return "decide_again";
  }
  if (end?.type === "done") {
    const { credentialExpiresAt, extraUsage } = end;
    await accounts.runEnded(payer.memberId, payer.configDir, { credentialExpiresAt, extraUsage });
  }
  return "settled";
}
