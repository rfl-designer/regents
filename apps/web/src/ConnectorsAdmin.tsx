import type { ConnectorCredentialMode, ConnectorDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";
import { goToLogin, loginReturn } from "./connector-login";
import { dateTimeShort } from "./format";

function messageOf(err: unknown, fallback: string) {
  const body = err instanceof ApiFailure ? err.body : null;
  return body && "message" in body && typeof body.message === "string" ? body.message : fallback;
}

/**
 * Só para o Admin: os Conectores (servidores MCP remotos). A credencial do Workspace se liga pelo
 * login do servidor, quando ele oferece, ou colando um token; fica cifrada e não volta. As
 * Ferramentas de cada um se concedem na tela do Agente.
 */
export function ConnectorsSettings() {
  const [connectors, setConnectors] = useState<ConnectorDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [back] = useState(loginReturn);

  useEffect(() => {
    api.connectors().then(setConnectors, () => setLoadError(true));
  }, []);

  const replace = (c: ConnectorDto) => setConnectors((list) => list?.map((x) => (x.id === c.id ? c : x)) ?? null);

  return (
    <main className="settings">
      <h1 className="channel-name">Conectores</h1>
      <p className="hint">
        Um Conector liga o Workspace a um sistema de fora pelo servidor do Conector. Quem fala com um Agente que tem as
        Ferramentas dele alcança o que o token alcança; a descrição do Agente diz isso. Ferramenta sem a marca de "só
        leitura" do servidor é escrita e passa por Pedido de aprovação.
      </p>
      {back && "ok" in back && (
        <p className="hint" role="status">
          Login concluído: a credencial ficou gravada.
        </p>
      )}
      {back && "error" in back && (
        <p className="error" role="alert">
          {back.error}
        </p>
      )}
      {loadError && (
        <p className="error" role="alert">
          Não foi possível carregar os Conectores.
        </p>
      )}
      {connectors === null && !loadError && <p className="hint">Carregando…</p>}
      {connectors && connectors.length === 0 && <p className="hint">Nenhum Conector.</p>}
      <ul className="agent-list" aria-label="Conectores">
        {connectors?.map((c) => (
          <ConnectorItem
            key={c.id}
            connector={c}
            onChanged={replace}
            onRemoved={() => setConnectors((list) => list?.filter((x) => x.id !== c.id) ?? null)}
          />
        ))}
      </ul>
      <NewConnector onCreated={(c) => setConnectors((list) => [...(list ?? []), c])} />
    </main>
  );
}

function ConnectorItem(props: { connector: ConnectorDto; onChanged(c: ConnectorDto): void; onRemoved(): void }) {
  const c = props.connector;
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const reload = () =>
    act(async () => props.onChanged(await api.connector(c.id)), "Não foi possível reler o catálogo.");
  const saveToken = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    void act(async () => {
      props.onChanged(await api.setConnectorToken(c.id, token));
      setToken("");
    }, "O token não foi gravado.");
  };
  const relogin = () =>
    act(
      async () => goToLogin((await api.connectorRelogin(c.id, location.origin)).authorizationUrl),
      "O login não começou.",
    );
  const remove = () => {
    if (!confirm(`Remover o ${c.name}? As Ferramentas dele saem de todos os Agentes.`)) return;
    void act(async () => {
      await api.removeConnector(c.id);
      props.onRemoved();
    }, "O Conector não foi removido.");
  };

  return (
    <li className="settings-row" aria-label={`Conector ${c.name}`}>
      <div className="meta">
        <strong>{c.name}</strong>
        <span className="hint">{c.url}</span>
        <button type="button" className="link" disabled={busy} onClick={reload}>
          Reler Ferramentas
        </button>
        <button type="button" className="link" disabled={busy} onClick={remove}>
          Remover
        </button>
      </div>
      {c.credential === "member" ? (
        <p className="hint">
          Credencial de cada Membro: cada um liga a sua em Meus Conectores, e a resposta usa a de quem pediu. O catálogo
          se relê com a sua.
        </p>
      ) : c.credentialState === "refused" ? (
        <p className="error" role="alert">
          O {c.name} recusou a credencial do Workspace
          {c.refusedAt ? ` em ${dateTimeShort(c.refusedAt)}` : ""}. As Ferramentas dele falham até você colar outro
          token.
        </p>
      ) : (
        <p className="hint">Credencial do Workspace gravada.</p>
      )}
      {c.catalogError && (
        <p className="error" role="alert">
          {c.catalogError}
        </p>
      )}
      <ul aria-label={`Ferramentas do ${c.name}`}>
        {c.tools.map((t) => (
          <li key={t.id} className="hint">
            {t.title} <span className="tag">{t.access === "read" ? "leitura" : "escrita"}</span>
            {t.description && (
              <>
                <br />
                <small>{t.description}</small>
              </>
            )}
          </li>
        ))}
        {c.tools.length === 0 && <li className="hint">O servidor não oferece Ferramentas.</li>}
      </ul>
      {c.credential === "workspace" && (
        <form className="row" onSubmit={saveToken}>
          <input
            type="password"
            aria-label={`Token novo do ${c.name}`}
            placeholder="Colar um token novo"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" disabled={busy || !token.trim()}>
            Trocar token
          </button>
          <button type="button" disabled={busy} onClick={relogin}>
            Ligar de novo pelo login
          </button>
        </form>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function NewConnector({ onCreated }: { onCreated(c: ConnectorDto): void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState<ConnectorCredentialMode>("workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createConnector({ name, url, token, credential }));
      setName("");
      setUrl("");
      setToken("");
    } catch (err) {
      setError(messageOf(err, "O Conector não foi adicionado. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  /** Sem token: o login do servidor (quando ele não oferece, o motivo diz para colar um token). */
  async function login() {
    setBusy(true);
    setError(null);
    try {
      goToLogin((await api.connectorLogin({ name, url, credential, origin: location.origin })).authorizationUrl);
    } catch (err) {
      setError(messageOf(err, "O login não começou. Tente de novo."));
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label="Conector novo">
      <h2>Adicionar Conector</h2>
      <input aria-label="Nome" placeholder="Nome (ex. CRM)" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        aria-label="Endereço do Conector"
        placeholder="https://…/mcp"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <fieldset className="row" aria-label="De quem é a credencial">
        <label>
          <input
            type="radio"
            name="credential"
            checked={credential === "workspace"}
            onChange={() => setCredential("workspace")}
          />
          do Workspace (um token só, para todos)
        </label>
        <label>
          <input
            type="radio"
            name="credential"
            checked={credential === "member"}
            onChange={() => setCredential("member")}
          />
          de cada Membro (cada um liga a sua no Perfil)
        </label>
      </fieldset>
      <input
        type="password"
        aria-label={credential === "workspace" ? "Token do Workspace" : "O seu token"}
        placeholder={credential === "workspace" ? "Token do Workspace" : "O seu token (vira a sua credencial)"}
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <div className="row">
        <button type="submit" disabled={busy || !name.trim() || !url.trim() || !token.trim()}>
          Adicionar com o token
        </button>
        <button type="button" disabled={busy || !name.trim() || !url.trim()} onClick={login}>
          Ligar pelo login do servidor
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
