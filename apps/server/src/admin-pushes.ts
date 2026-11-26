import {
  AGENTS_PATH,
  type AgentBudgetDto,
  type JoinRequestAdminDto,
  type KeyIncidentDto,
  MEMBERS_PATH,
  WORKSPACE_KEY_PATH,
} from "@regents/contracts";
import type { Db } from "./db/client";
import type { JoinRequestHooks } from "./join-requests";
import type { KeyHooks } from "./key-budget";
import { activeAdminIds } from "./members";
import type { Push } from "./push";

/**
 * Os pushes do Admin (Spec, módulo 12, "Gatilhos"): a cada Pedido de entrada (história 20), um por
 * incidente da Chave (história 47) e no estouro do orçamento, no máximo um por Agente por mês
 * (história 52; quem garante o "no máximo" é o `budgetExceeded` do `key-budget.ts`). Vão a todo
 * Admin ativo; quem foi removido do Workspace não recebe. Os de backup e da chave do nó são da
 * Instalação (`installation/status.ts`).
 */
export function adminPushes(deps: { db: Db; notify: Push["notify"] }): JoinRequestHooks & KeyHooks {
  const { db, notify } = deps;

  async function toAdmins(n: Parameters<Push["notify"]>[1]) {
    for (const id of await activeAdminIds(db)) notify(id, n);
  }

  /** O aviso já saiu da transação que o pediu: uma falha aqui vai para o log, nunca desfaz nada. */
  const later = (what: string, work: Promise<void>) =>
    void work.catch((err) => console.error(`regents: o push ${what} falhou`, err));

  return {
    joinRequestCreated(request: JoinRequestAdminDto) {
      const line = [request.login, request.device, request.sharee ? "de outra tailnet" : null].filter(Boolean);
      later(
        "do Pedido de entrada",
        toAdmins({
          title: `${request.displayName} pede para entrar no Regents`,
          body: line.join(" · "),
          path: MEMBERS_PATH,
          // Um por pedido: dois pedidos seguidos não se substituem.
          tag: `pedido-${request.id}`,
          urgency: "high",
          ...(request.profilePicUrl ? { icon: request.profilePicUrl } : {}),
        }),
      );
    },

    keyIncidentOpened(incident: KeyIncidentDto) {
      later(
        "do incidente da Chave",
        toAdmins({
          ...(incident.kind === "auth_failed"
            ? {
                title: "A Chave do Workspace foi recusada",
                body: "A Anthropic não aceitou a Chave. Os Agentes não respondem por ela até você trocá-la.",
              }
            : {
                title: "A Chave do Workspace está sem crédito",
                body: "Os Agentes não respondem pela Chave até a conta da Anthropic ter crédito de novo.",
              }),
          path: WORKSPACE_KEY_PATH,
          // Um incidente de cada vez: o novo toma o lugar do anterior.
          tag: "chave-incidente",
          urgency: "high",
        }),
      );
    },

    budgetExceeded(budget: AgentBudgetDto) {
      const of = budget.monthlyBudgetUsd === null ? "" : ` de ${usd(budget.monthlyBudgetUsd)}`;
      later(
        "do estouro de orçamento",
        toAdmins({
          title: `${budget.name} estourou o orçamento do mês`,
          body:
            `Gastou ${usd(budget.keySpendUsd)}${of} na Chave. ` +
            `Até o mês virar ou o orçamento subir, ${budget.name} não usa a Chave.`,
          path: AGENTS_PATH,
          tag: `orcamento-${budget.agentId}`,
          urgency: "normal",
        }),
      );
    },
  };
}

/** `US$ 4,00`. */
const usd = (value: number) =>
  `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
