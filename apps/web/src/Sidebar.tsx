import type { ChannelDto } from "@shearim/contracts";
import { type FormEvent, useState } from "react";
import { ApiFailure, api } from "./api";

interface Props {
  channels: ChannelDto[];
  selectedId: string | null;
  isAdmin: boolean;
  settingsOpen: boolean;
  onOpen(id: string): void;
  onCreated(channel: ChannelDto): void;
  onOpenSettings(): void;
}

/** A lista de conversas: os Canais que o Membro vê (as DMs do #18 entram aqui, em outra seção). */
export function Sidebar(props: Props) {
  const [creating, setCreating] = useState(false);

  return (
    <nav className="sidebar" aria-label="Conversas">
      <h2>Canais</h2>
      <ul>
        {props.channels.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="conversation"
              aria-current={c.id === props.selectedId ? "page" : undefined}
              onClick={() => props.onOpen(c.id)}
            >
              # {c.name}
              {c.kind === "private" && (
                <>
                  {" "}
                  <span className="tag">privado</span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      {creating ? (
        <NewChannel
          onCancel={() => setCreating(false)}
          onCreated={(channel) => {
            setCreating(false);
            props.onCreated(channel);
          }}
        />
      ) : (
        <button type="button" className="link" onClick={() => setCreating(true)}>
          + Novo Canal
        </button>
      )}
      {props.isAdmin && (
        <button
          type="button"
          className="link"
          aria-current={props.settingsOpen ? "page" : undefined}
          onClick={props.onOpenSettings}
        >
          Instruções dos Canais
        </button>
      )}
    </nav>
  );
}

function NewChannel({ onCancel, onCreated }: { onCancel(): void; onCreated(channel: ChannelDto): void }) {
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createChannel({ name, kind: isPrivate ? "private" : "public" }));
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setError(body && "message" in body ? body.message : "Não foi possível criar o Canal. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-channel" onSubmit={submit} aria-label="Novo Canal">
      <input
        aria-label="Nome do Canal"
        placeholder="nome-do-canal"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label>
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Privado: só quem
        participa vê
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          Criar
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
