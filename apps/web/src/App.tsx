import { type ChannelDto, type MeDto, NO_IDENTITY_TEXT } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiFailure, api, Offline } from "./api";
import { ChannelView } from "./ChannelView";
import { EntryView } from "./EntryView";
import { JoinRequestsPanel } from "./JoinRequestsPanel";

type State =
  | { kind: "loading" }
  | { kind: "ready"; me: MeDto; channels: ChannelDto[] }
  /** Tem identidade da tailnet, mas ainda não é Membro: o Pedido de entrada. */
  | { kind: "entry" }
  | { kind: "blocked"; title: string; detail: string };

function explain(err: unknown): State {
  if (err instanceof Offline) {
    return {
      kind: "blocked",
      title: "Sem conexão com o Shearim",
      detail: "Confira se o Tailscale está ligado neste aparelho e tente de novo.",
    };
  }
  // Em geral quem chega sem identidade já recebe a página estática do servidor;
  // isto cobre o PWA aberto do cache ou a identidade que some no meio da sessão.
  if (err instanceof ApiFailure && err.body?.error === "no_identity") {
    const text = NO_IDENTITY_TEXT[err.body.reason] ?? NO_IDENTITY_TEXT.unknown;
    return { kind: "blocked", title: "Não sabemos quem é você", detail: `${text.why} ${text.whatToDo}` };
  }
  if (err instanceof ApiFailure && err.body?.error === "not_a_member") return { kind: "entry" };
  return { kind: "blocked", title: "Algo deu errado", detail: "Recarregue a página para tentar de novo." };
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      const channels = await api.channels();
      setState({ kind: "ready", me, channels });
    } catch (err) {
      setState(explain(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <main className="center">Carregando…</main>;
  if (state.kind === "entry") return <EntryView onApproved={load} />;
  if (state.kind === "blocked") {
    return (
      <main className="center">
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
      </main>
    );
  }

  const channel = state.channels[0];
  return (
    <div className="shell">
      <header className="topbar">
        <strong>Shearim</strong>
        <span className="whoami">Você está como {state.me.displayName}</span>
      </header>
      {state.me.role === "admin" && <JoinRequestsPanel />}
      {channel ? <ChannelView channel={channel} /> : <main className="center">Nenhum Canal ainda.</main>}
    </div>
  );
}
