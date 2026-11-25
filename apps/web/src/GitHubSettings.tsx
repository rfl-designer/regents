import type { GitHubDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";
import { dateTimeShort } from "./format";

function messageOf(err: unknown, fallback: string) {
  const body = err instanceof ApiFailure ? err.body : null;
  return body && "message" in body ? body.message : fallback;
}

/** O desfecho do retorno do GitHub (`/github?github=…` ou `?erro=…`), lido uma vez e tirado do endereço. */
function returnOfUrl(): { ok: string } | { error: string } | null {
  const params = new URLSearchParams(location.search);
  const ok = params.get("github");
  const error = params.get("erro");
  if (!ok && !error) return null;
  history.replaceState(history.state, "", location.pathname);
  return error ? { error } : { ok: ok! };
}

/** O navegador do Admin leva o manifest ao GitHub (um formulário de verdade, não um fetch). */
function submitToGitHub(action: string, manifest: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

/**
 * Só para o Admin: o GitHub do Workspace (ADR 0010). Cria o GitHub App da Instalação pelo fluxo de
 * manifest, instala na conta do time (os repositórios se escolhem lá) e mostra a instalação que o
 * GitHub deixou de reconhecer.
 */
export function GitHubSettings() {
  const [status, setStatus] = useState<GitHubDto | null>(null);
  const [organization, setOrganization] = useState("");
  const [back] = useState(returnOfUrl);
  const [state, setState] = useState<{ kind: "idle" | "going" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  useEffect(() => {
    api.github().then(setStatus, () => setState({ kind: "error", message: "Não foi possível carregar." }));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setState({ kind: "going" });
    try {
      const { action, manifest } = await api.githubManifest(location.origin, organization.trim());
      submitToGitHub(action, manifest);
    } catch (err) {
      setState({ kind: "error", message: messageOf(err, "Não foi possível começar. Tente de novo.") });
    }
  }

  async function install() {
    setState({ kind: "going" });
    try {
      location.assign((await api.githubInstall()).url);
    } catch (err) {
      setState({ kind: "error", message: messageOf(err, "Não foi possível começar. Tente de novo.") });
    }
  }

  return (
    <main className="settings">
      <h1 className="channel-name">GitHub</h1>
      <p className="hint">
        Um GitHub App só desta Instalação: os Agentes leem os repositórios que você liberar no GitHub. A chave privada
        do App fica guardada cifrada aqui e não sai daqui.
      </p>
      {back && "error" in back && (
        <p className="error" role="alert">
          {back.error}
        </p>
      )}
      {back && "ok" in back && (
        <p className="hint" role="status">
          {back.ok === "installed" ? "App instalado." : "App criado. Falta instalar na conta do time."}
        </p>
      )}
      {status === null ? (
        <p className="hint" role="status">
          Carregando…
        </p>
      ) : status.state === "none" ? (
        <form className="settings-row" onSubmit={create} aria-label="Criar o GitHub App">
          <p className="hint">Nenhum GitHub App criado.</p>
          <input
            aria-label="Organização no GitHub"
            placeholder="Organização do time no GitHub (opcional)"
            autoComplete="off"
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={state.kind === "going"}>
              Criar o GitHub App
            </button>
          </div>
        </form>
      ) : (
        <section className="settings-row" aria-label="GitHub App">
          <p className="hint" role="status">
            App <a href={status.app?.htmlUrl}>{status.app?.name}</a>
            {status.app?.owner ? ` de ${status.app.owner}` : ""}.{" "}
            {status.installation
              ? `Instalado em ${status.installation.account} em ${dateTimeShort(status.installation.installedAt)}.`
              : "Ainda não instalado."}
          </p>
          {status.failure && (
            <p className="error" role="alert">
              O GitHub não reconhece mais a instalação ({dateTimeShort(status.failure.at)}): {status.failure.reason}.
            </p>
          )}
          <div className="row">
            <button type="button" onClick={install} disabled={state.kind === "going"}>
              {status.installation ? "Instalar de novo ou trocar os repositórios" : "Instalar na conta do time"}
            </button>
          </div>
        </section>
      )}
      {state.kind === "error" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </main>
  );
}
