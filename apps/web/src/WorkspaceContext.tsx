import { WORKSPACE_CONTEXT_MAX } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";

/** Só para o Admin: o Contexto do Workspace, que entra em todo Agente, em todo Canal e DM. */
export function WorkspaceContextSettings() {
  const [context, setContext] = useState<string | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  useEffect(() => {
    api.workspaceContext().then(
      (dto) => setContext(dto.context),
      () => setState({ kind: "error", message: "Não foi possível carregar. Recarregue a página." }),
    );
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (context === null) return;
    setState({ kind: "saving" });
    try {
      setContext((await api.setWorkspaceContext(context)).context);
      setState({ kind: "saved" });
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setState({ kind: "error", message: body && "message" in body ? body.message : "Não foi salvo. Tente de novo." });
    }
  }

  return (
    <main className="settings">
      <h1 className="channel-name">Contexto do Workspace</h1>
      <p className="hint">
        Um texto curto sobre quem vocês são e como falam. Entra no contexto de todo Agente, em todo Canal e DM. O que os
        Agentes precisam lembrar fica aqui ou nas Instruções do Canal.
      </p>
      <form className="settings-row" onSubmit={save} aria-label="Contexto do Workspace">
        <textarea
          aria-label="Contexto do Workspace"
          placeholder={context === null ? "Carregando…" : "Sem Contexto do Workspace."}
          rows={6}
          maxLength={WORKSPACE_CONTEXT_MAX}
          disabled={context === null}
          value={context ?? ""}
          onChange={(e) => {
            setContext(e.target.value);
            setState({ kind: "idle" });
          }}
        />
        <div className="row">
          <button type="submit" disabled={context === null || state.kind === "saving"}>
            Salvar
          </button>
          <span className="hint">
            {context?.length ?? 0}/{WORKSPACE_CONTEXT_MAX}
          </span>
          {state.kind === "saved" && <span className="hint">Salvo.</span>}
          {state.kind === "error" && (
            <span className="error" role="alert">
              {state.message}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
