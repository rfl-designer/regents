import type { MeDto, MemoryItemDto } from "@shearim/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useServerEvents } from "./live";
import { MemoryArchived, MemoryItem, sortMemory } from "./Memory";

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

  const load = useCallback(() => {
    api.workspaceMemory().then(
      (list) => {
        setLoadError(false);
        setItems(Object.fromEntries(list.map((i) => [i.id, i])));
      },
      () => setLoadError(true),
    );
  }, []);
  useEffect(load, [load]);

  useServerEvents((event) => {
    // Depois de uma queda da conexão, o que mudou nesse meio tempo não chegou: recarrega.
    if (event.type === "ready") load();
    if (event.type === "memory.updated" && event.item.scope === "workspace") show(event.item);
  });

  const { all, active, archived } = sortMemory(Object.values(items ?? {}));

  return (
    <main className="settings">
      <h1 className="channel-name">Memória do Workspace</h1>
      <p className="hint">
        O que vale em todo o Workspace: entra primeiro na Memória de toda resposta de Agente, em todo Canal e DM. Quem
        escreve é um Admin, direto aqui ou promovendo um item da Memória da Conversa de um Canal público. O Shearim não
        guarda aqui sozinho.
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
      <MemoryArchived archived={archived} all={all} />
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
