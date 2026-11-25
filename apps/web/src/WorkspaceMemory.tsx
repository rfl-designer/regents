import type { MeDto, MemoryItemDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { archivedNote, MemoryItem } from "./ChannelView";
import { useServerEvents } from "./live";

/** O tamanho máximo de um item da Memória (o mesmo do servidor). */
const MAX_ITEM = 500;

/**
 * A Memória do Workspace (spec #60, #66): o que vale em todo o Workspace e entra primeiro em toda
 * resposta de Agente, em todo Canal e DM. Todo Membro vê; só o Admin escreve, desfaz e corrige
 * (e promove, na lista "Memória" de um Canal público).
 */
export function WorkspaceMemory({ me }: { me: MeDto }) {
  const isAdmin = me.role === "admin";
  const [items, setItems] = useState<Record<string, MemoryItemDto> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const show = (item: MemoryItemDto) => setItems((prev) => ({ ...prev, [item.id]: item }));

  useEffect(() => {
    api.workspaceMemory().then(
      (list) => setItems(Object.fromEntries(list.map((i) => [i.id, i]))),
      () => setLoadError(true),
    );
  }, []);

  useServerEvents((event) => {
    if (event.type === "memory.updated" && event.item.scope === "workspace") show(event.item);
  });

  const all = Object.values(items ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = all.filter((i) => i.state === "active");
  const archived = all.filter((i) => i.state === "archived");
  const byId = new Map(all.map((i) => [i.id, i]));

  return (
    <main className="settings">
      <h1 className="channel-name">Memória do Workspace</h1>
      <p className="hint">
        O que vale em todo o Workspace: entra primeiro na Memória de toda resposta de Agente, em todo Canal e DM. Quem
        escreve é um Admin, direto aqui ou promovendo um item da Memória de um Canal público. O Shearim não guarda aqui
        sozinho.
      </p>
      {isAdmin && <WriteItem onWritten={show} />}
      {loadError ? (
        <p className="error" role="alert">
          Não foi possível carregar. Recarregue a página.
        </p>
      ) : items === null ? (
        <p className="hint">Carregando…</p>
      ) : active.length === 0 ? (
        <p className="notice">Nada na Memória do Workspace ainda.</p>
      ) : (
        <ul className="memory-items" aria-label="Itens da Memória do Workspace">
          {active.map((i) => (
            <MemoryItem key={i.id} item={i} editable={isAdmin} onChanged={show} />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <section className="memory-archived" aria-label="Arquivados">
          <h2 className="memory-subhead">Arquivados</h2>
          <ul className="memory-items">
            {archived.map((i) => (
              <li key={i.id} className="memory-item archived">
                <p className="memory-text">{i.text}</p>
                <p className="micro muted">{archivedNote(i, i.replacedById ? byId.get(i.replacedById) : undefined)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** Só para o Admin: escreve um item direto na Memória do Workspace. */
function WriteItem({ onWritten }: { onWritten(item: MemoryItemDto): void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  async function write(e: FormEvent) {
    e.preventDefault();
    setState("saving");
    try {
      onWritten(await api.writeWorkspaceMemory(text));
      setText("");
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <form className="settings-row" onSubmit={write} aria-label="Escrever na Memória do Workspace">
      <textarea
        aria-label="Novo item da Memória do Workspace"
        placeholder="Ex.: O reembolso sai pelo Flouz."
        rows={2}
        maxLength={MAX_ITEM}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
        }}
      />
      <div className="row">
        <button type="submit" disabled={state === "saving" || !text.trim()}>
          Guardar
        </button>
        {state === "error" && (
          <span className="error" role="alert">
            Não foi guardado. Tente de novo.
          </span>
        )}
      </div>
    </form>
  );
}
