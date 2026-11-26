import { type AgentDto, conversationPath, type MeDto, type MemoryItemDto } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import { useServerEvents } from "./live";
import { MemoryArchived, MemoryItem, sortMemory } from "./Memory";

/**
 * A tela do Agente (#65), ao lado da conversa (no celular, por cima): só de leitura para todo
 * Membro, com o que ele é, o que alcança e a Memória do Agente, só com os itens cuja conversa de
 * origem quem olha vê (Admin inclusive). Quem vê a origem desfaz e corrige. O Admin também liga e
 * desliga a Memória dele (#67) e o apaga (a Memória do Agente sai junto; a da Conversa fica).
 *
 * `conversationId` é a conversa aberta: a origem que é dela salta para a mensagem (`onOpen`); a
 * de outra conversa abre a conversa.
 */
export function AgentPanel({
  agentId,
  me,
  conversationId,
  onOpen,
  onClose,
}: {
  agentId: string;
  me: MeDto;
  conversationId: string;
  onOpen(item: MemoryItemDto): void;
  onClose(): void;
}) {
  const admin = me.role === "admin";
  const [agent, setAgent] = useState<AgentDto | null | "gone">(null);
  /** O nome que a tela mostra, guardado para depois de o Agente ser apagado. */
  const [name, setName] = useState("Agente");
  const [items, setItems] = useState<Record<string, MemoryItemDto>>({});
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api
      .agents()
      .then(async (agents) => {
        const found = agents.find((a) => a.id === agentId);
        // O Agente apagado não tem mais Memória (o servidor dá 404): só o aviso.
        const memory = found ? await api.agentMemory(agentId) : [];
        setFailed(false);
        setAgent(found ?? "gone");
        if (found) setName(found.name);
        setItems(Object.fromEntries(memory.map((i) => [i.id, i])));
      })
      .catch(() => setFailed(true));
  }, [agentId]);
  useEffect(load, [load]);

  useServerEvents((event) => {
    if (event.type === "ready") load();
    // O evento só chega a quem vê a origem: a mesma regra da lista.
    if (event.type === "memory.updated" && event.item.scope === "agent" && event.item.agent?.id === agentId) {
      const { item } = event;
      setItems((prev) => ({ ...prev, [item.id]: item }));
    }
    if (event.type === "agent.deleted" && event.agentId === agentId) {
      setAgent("gone");
      setItems({});
    }
  });

  const { all, active, archived } = sortMemory(Object.values(items));
  const changed = (item: MemoryItemDto) => setItems((prev) => ({ ...prev, [item.id]: item }));

  return (
    <aside className="thread-panel memory-panel agent-panel" aria-label={`Agente ${name}`}>
      <header className="thread-head">
        <strong>{name}</strong>
        <span className="muted">Agente</span>
        <button type="button" className="link" onClick={onClose}>
          Fechar
        </button>
      </header>
      <div className="memory-body">
        {failed && <p className="error">Não foi possível carregar o Agente. Tente de novo.</p>}
        {agent === "gone" && <p className="notice">Este Agente foi apagado.</p>}
        {agent && agent !== "gone" && (
          <>
            <AgentAbout agent={agent} />
            {admin && (
              <AgentAdminActions
                agent={agent}
                onChanged={(a) => {
                  setAgent(a);
                  setName(a.name);
                }}
                onDeleted={() => setAgent("gone")}
              />
            )}
            <section aria-label={`Memória de ${agent.name}`}>
              <h2 className="memory-subhead">Memória</h2>
              <p className="micro muted agent-note">
                O jeito de trabalhar de {agent.name}: as correções que as pessoas deram a ele. Aparecem só as que
                nasceram em conversas que você vê.
              </p>
              {active.length === 0 ? (
                <p className="notice agent-note">Nada guardado que você veja.</p>
              ) : (
                <ul className="memory-items" aria-label="Itens da Memória do Agente">
                  {active.map((i) => (
                    <MemoryItem
                      key={i.id}
                      item={i}
                      editable
                      onChanged={changed}
                      onOpen={(item) => {
                        if (item.conversationId === conversationId) onOpen(item);
                        else if (item.conversationId && item.origin) {
                          location.assign(`${conversationPath(item.conversationId)}?m=${item.origin.messageId}`);
                        }
                      }}
                    />
                  ))}
                </ul>
              )}
              <MemoryArchived archived={archived} all={all} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function AgentAbout({ agent: a }: { agent: AgentDto }) {
  return (
    <section className="agent-about">
      <div className="agent-head">
        <Avatar name={a.name} agent photo={a.photo} />
        <div>
          <strong>{a.name}</strong> <span className="muted">@{a.handle}</span>
          {a.builtin && <span className="tag">Articuladora</span>}
          <p className="micro muted">{a.model}</p>
        </div>
      </div>
      {a.description && <p>{a.description}</p>}
      {a.reach.map((line) => (
        <p key={line} className="micro">
          {line}
        </p>
      ))}
      <p className="micro muted">Ferramentas: {a.tools.length ? a.tools.map((t) => t.title).join(", ") : "nenhuma"}</p>
      <p className="micro">{a.memoryEnabled ? "Memória ligada" : "Memória desligada: não guarda nem lê"}</p>
    </section>
  );
}

/** Só o Admin: liga ou desliga a Memória (#67) e apaga o Agente (não a Articuladora), confirmando antes. */
function AgentAdminActions({
  agent: a,
  onChanged,
  onDeleted,
}: {
  agent: AgentDto;
  onChanged(agent: AgentDto): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function act(run: () => Promise<void>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-admin" aria-label="Só o Admin">
      <label>
        <input
          type="checkbox"
          checked={a.memoryEnabled}
          disabled={busy}
          onChange={(e) =>
            act(
              async () => onChanged(await api.updateAgent(a.id, { memoryEnabled: e.target.checked })),
              "Não deu para mudar a Memória. Tente de novo.",
            )
          }
        />{" "}
        Memória ligada
      </label>
      {!a.builtin &&
        (confirming ? (
          <div className="failcard-actions">
            <p className="micro">
              Apagar {a.name}? A Memória do Agente sai junto. As mensagens dele e a Memória da Conversa que ele gerou
              ficam.
            </p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api.deleteAgent(a.id);
                  onDeleted();
                }, "Não deu para apagar. Tente de novo.")
              }
            >
              Apagar
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => setConfirming(false)}>
              Voltar
            </button>
          </div>
        ) : (
          <button type="button" className="link" onClick={() => setConfirming(true)}>
            Apagar Agente
          </button>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
