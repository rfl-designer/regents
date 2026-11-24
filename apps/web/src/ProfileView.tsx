import type { MeDto } from "@shearim/contracts";
import { type FormEvent, useState } from "react";
import { Avatar } from "./Avatar";
import { ApiFailure, api } from "./api";

type Status = { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string };

/**
 * O perfil de quem está usando: nome, identificador de Menção e "sobre mim".
 * O nome e a foto vieram da tailnet na primeira entrada; o nome editado aqui fica.
 */
export function ProfileView({ me, onSaved }: { me: MeDto; onSaved(me: MeDto): void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [handle, setHandle] = useState(me.handle);
  const [about, setAbout] = useState(me.about);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const saved = await api.updateProfile({ displayName, handle, about });
      setDisplayName(saved.displayName);
      setHandle(saved.handle);
      setAbout(saved.about);
      setStatus({ kind: "saved" });
      onSaved(saved);
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setStatus({ kind: "error", message: body && "message" in body ? body.message : "Não foi salvo. Tente de novo." });
    }
  }

  return (
    <main className="settings">
      <h1 className="channel-name">Meu perfil</h1>
      <form className="settings-row profile" onSubmit={save} aria-label="Meu perfil">
        <div className="row">
          <Avatar name={me.displayName} photo={me.profilePicUrl} />
          <span className="hint">{me.login} · a foto vem da tailnet</span>
        </div>
        <label>
          Nome
          <input value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Identificador de Menção
          <span className="handle-input">
            @
            <input
              value={handle}
              maxLength={32}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setHandle(e.target.value)}
            />
          </span>
          <span className="hint">Quem escrever @{handle || "…"} numa mensagem menciona você.</span>
        </label>
        <label>
          Sobre mim (opcional)
          <textarea
            rows={3}
            maxLength={500}
            placeholder="O que você faz no time, para as pessoas e os Agentes saberem."
            value={about}
            onChange={(e) => setAbout(e.target.value)}
          />
        </label>
        <div className="row">
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
    </main>
  );
}
