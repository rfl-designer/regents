import type { MyConnectorDto } from "@shearim/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";
import { goToLogin, loginReturn } from "./connector-login";
import { dateTimeShort } from "./format";
import { useServerEvents } from "./live";

function messageOf(err: unknown, fallback: string) {
  const body = err instanceof ApiFailure ? err.body : null;
  return body && "message" in body && typeof body.message === "string" ? body.message : fallback;
}

/**
 * Perfil › Conectores: os Conectores que pedem a credencial de cada Membro. O Membro liga a dele
 * pelo login do servidor, quando ele oferece, ou colando um token (fica cifrado e não volta) e desliga quando quiser. Sem ela, as Ferramentas do
 * Conector ficam indisponíveis nas mensagens dele; a recusa do sistema de fora aparece aqui.
 */
export function MyConnectors() {
  const [list, setList] = useState<MyConnectorDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [back] = useState(loginReturn);
  const load = useCallback(() => {
    api.myConnectors().then(setList, () => setLoadError(true));
  }, []);
  useEffect(load, [load]);
  const replace = (c: MyConnectorDto) => setList((l) => l?.map((x) => (x.id === c.id ? c : x)) ?? null);
  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "my_connector.updated") replace(event.connector);
  });

  return (
    <main className="settings">
      <h1 className="channel-name">Meus Conectores</h1>
      <p className="hint">
        Estes Conectores usam a credencial de cada Membro: quando você fala com um Agente que tem as Ferramentas deles,
        ele alcança o que o seu token alcança, e o Andamento mostra a todos que usou o seu.
      </p>
      {back && "ok" in back && (
        <p className="hint" role="status">
          Login concluído: a sua credencial ficou ligada.
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
      {list === null && !loadError && <p className="hint">Carregando…</p>}
      {list && list.length === 0 && <p className="hint">Nenhum Conector pede a sua credencial.</p>}
      <ul className="agent-list" aria-label="Meus Conectores">
        {list?.map((c) => (
          <MyConnectorItem key={c.id} connector={c} onChanged={replace} />
        ))}
      </ul>
    </main>
  );
}

function MyConnectorItem(props: { connector: MyConnectorDto; onChanged(c: MyConnectorDto): void }) {
  const c = props.connector;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
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

  const connect = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    void act(async () => {
      props.onChanged(await api.connectMine(c.id, token));
      setToken("");
    }, "O token não foi gravado.");
  };
  const login = () =>
    act(
      async () => goToLogin((await api.connectMineLogin(c.id, location.origin)).authorizationUrl),
      "O login não começou.",
    );
  const disconnect = () =>
    act(async () => {
      await api.disconnectMine(c.id);
      props.onChanged({ ...c, credentialState: "off", refusedAt: null });
    }, "Não foi possível desligar.");

  return (
    <li className="settings-row" aria-label={`Conector ${c.name}`}>
      <div className="meta">
        <strong>{c.name}</strong>
        <span className="hint">{c.url}</span>
        {c.credentialState !== "off" && (
          <button type="button" className="link" disabled={busy} onClick={disconnect}>
            Desligar
          </button>
        )}
      </div>
      {c.credentialState === "ok" && <p className="hint">Ligado com a sua credencial.</p>}
      {c.credentialState === "off" && (
        <p className="hint">Desligado: as Ferramentas dele ficam indisponíveis para você.</p>
      )}
      {c.credentialState === "refused" && (
        <p className="error" role="alert">
          O {c.name} recusou a sua credencial{c.refusedAt ? ` em ${dateTimeShort(c.refusedAt)}` : ""}. Cole um token
          novo ou entre pelo login para ligar de novo.
        </p>
      )}
      {c.credentialState !== "ok" && (
        <form className="row" onSubmit={connect}>
          <input
            type="password"
            aria-label={`Seu token do ${c.name}`}
            placeholder={`Colar o seu token do ${c.name}`}
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" disabled={busy || !token.trim()}>
            Ligar com o token
          </button>
          <button type="button" disabled={busy} onClick={login}>
            Ligar pelo login
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
