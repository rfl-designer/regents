import type { ChannelSettingsDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";

/**
 * Só para o Admin: as Instruções e o N de todo Canal, inclusive os privados de que
 * ele não participa. Daqui não se lê mensagem nenhuma.
 */
export function ChannelSettings() {
  const [list, setList] = useState<ChannelSettingsDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api.channelSettings().then(setList, () => setLoadError(true));
  }, []);

  return (
    <main className="settings">
      <h1 className="channel-name">Instruções dos Canais</h1>
      <p className="hint">
        As Instruções entram no contexto de todo Agente que fala no Canal. N é quantas mensagens recentes eles recebem
        (0 para nenhuma). Editar um Canal privado daqui não mostra as mensagens dele.
      </p>
      {loadError && <p className="notice">Não foi possível carregar os Canais. Recarregue a página.</p>}
      {list?.map((c) => (
        <SettingsRow key={c.id} channel={c} />
      ))}
    </main>
  );
}

function SettingsRow({ channel }: { channel: ChannelSettingsDto }) {
  const [instructions, setInstructions] = useState(channel.instructions);
  const [n, setN] = useState(String(channel.recentMessages));
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const saved = await api.updateChannelSettings(channel.id, { instructions, recentMessages: Number(n) });
      setInstructions(saved.instructions);
      setN(String(saved.recentMessages));
      setStatus({ kind: "saved" });
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setStatus({ kind: "error", message: body && "message" in body ? body.message : "Não foi salvo. Tente de novo." });
    }
  }

  return (
    <form className="settings-row" onSubmit={save} aria-label={`Instruções de #${channel.name}`}>
      <h2>
        # {channel.name}
        {channel.kind === "private" && (
          <>
            {" "}
            <span className="tag">privado</span>
          </>
        )}
      </h2>
      <textarea
        aria-label={`Instruções do Canal #${channel.name}`}
        placeholder="Sem Instruções do Canal."
        rows={3}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <div className="row">
        <label>
          N{" "}
          <input
            aria-label={`N de #${channel.name}`}
            type="number"
            min={0}
            step={1}
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
        </label>
        <button type="submit" disabled={status.kind === "saving"}>
          Salvar
        </button>
        {status.kind === "saved" && <span className="hint">Salvo.</span>}
        {status.kind === "error" && (
          <span className="error" role="alert">
            {status.message}
          </span>
        )}
      </div>
    </form>
  );
}
