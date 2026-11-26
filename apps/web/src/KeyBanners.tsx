import type { AgentBudgetDto, KeyIncidentDto } from "@regents/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { dateTimeShort } from "./format";
import { useServerEvents } from "./live";

export const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });

/** O que a faixa do incidente diz, por tipo. */
export const INCIDENT_TEXT: Record<KeyIncidentDto["kind"], { title: string; whatToDo: string }> = {
  auth_failed: {
    title: "A Anthropic recusou a Chave do Workspace",
    whatToDo: "Grave uma Chave válida.",
  },
  billing_failed: {
    title: "A Chave do Workspace está sem crédito",
    whatToDo: "Adicione crédito no Console da Anthropic.",
  },
};

/**
 * As faixas do Admin sobre a Chave (Spec, módulo 9): o incidente aberto (a Chave recusada ou sem
 * crédito), até a primeira chamada bem-sucedida, e cada Agente com o orçamento do mês estourado.
 * Chegam e somem pelo WebSocket (`key_incident.updated`, `agent_budget.updated`).
 */
export function KeyBanners({ onOpenKey, onOpenAgents }: { onOpenKey(): void; onOpenAgents(): void }) {
  const [incident, setIncident] = useState<KeyIncidentDto | null>(null);
  const [over, setOver] = useState<AgentBudgetDto[]>([]);

  const load = useCallback(() => {
    api.workspaceKey().then(
      (k) => setIncident(k.incident),
      () => {},
    );
    api.agents().then(
      (list) =>
        setOver(
          list
            .filter((a) => a.overBudget)
            .map((a) => ({
              agentId: a.id,
              name: a.name,
              monthlyBudgetUsd: a.monthlyBudgetUsd ?? null,
              keySpendUsd: a.keySpendUsd ?? 0,
              overBudget: true,
            })),
        ),
      () => {},
    );
  }, []);
  useEffect(load, [load]);

  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "key_incident.updated") setIncident(event.incident);
    if (event.type === "agent_budget.updated") {
      const { budget } = event;
      setOver((list) => {
        const rest = list.filter((b) => b.agentId !== budget.agentId);
        return budget.overBudget ? [...rest, budget] : rest;
      });
    }
  });

  return (
    <>
      {incident && (
        <section className="offer" aria-label="Incidente da Chave">
          <p role="alert">
            <strong>{INCIDENT_TEXT[incident.kind].title}</strong> desde {dateTimeShort(incident.openedAt)}. Quem não tem
            Conta ligada fica sem resposta. {INCIDENT_TEXT[incident.kind].whatToDo}
          </p>
          <div className="actions">
            <button type="button" onClick={onOpenKey}>
              Ver a Chave
            </button>
          </div>
        </section>
      )}
      {over.length > 0 && (
        <section className="offer" aria-label="Orçamento estourado">
          {over.map((b) => (
            <p key={b.agentId} role="alert">
              <strong>{b.name} estourou o orçamento do mês na Chave</strong> ({usd.format(b.keySpendUsd)} de{" "}
              {usd.format(b.monthlyBudgetUsd ?? 0)}). Até o mês virar ou o orçamento subir, {b.name} só responde a quem
              tem Conta ligada.
            </p>
          ))}
          <div className="actions">
            <button type="button" onClick={onOpenAgents}>
              Ver Agentes
            </button>
          </div>
        </section>
      )}
    </>
  );
}
