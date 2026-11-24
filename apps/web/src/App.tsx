import type { ChannelDto, MeDto } from "@shearim/contracts";
import { useEffect, useState } from "react";
import { ApiFailure, api, Offline } from "./api";
import { ChannelView } from "./ChannelView";

type State =
  | { kind: "loading" }
  | { kind: "ready"; me: MeDto; channels: ChannelDto[] }
  | { kind: "blocked"; title: string; detail: string };

const NO_IDENTITY: Record<string, string> = {
  tagged: "Este aparelho entrou na tailnet com uma tag, e nós com tag não têm uma pessoa por trás.",
  funnel: "O acesso veio pela internet aberta (Funnel), e o Shearim só atende quem está na tailnet.",
  unknown: "A tailnet não disse quem é você.",
};

function explain(err: unknown): State {
  if (err instanceof Offline) {
    return {
      kind: "blocked",
      title: "Sem conexão com o Shearim",
      detail: "Confira se o Tailscale está ligado neste aparelho e tente de novo.",
    };
  }
  if (err instanceof ApiFailure && err.body?.error === "no_identity") {
    return {
      kind: "blocked",
      title: "Não sabemos quem é você",
      detail: `${NO_IDENTITY[err.body.reason] ?? NO_IDENTITY.unknown} Entre pela tailnet com a sua própria conta.`,
    };
  }
  if (err instanceof ApiFailure && err.body?.error === "not_a_member") {
    return {
      kind: "blocked",
      title: "Você ainda não é Membro deste Workspace",
      detail: "Peça a um Admin para deixar você entrar.",
    };
  }
  return { kind: "blocked", title: "Algo deu errado", detail: "Recarregue a página para tentar de novo." };
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        const channels = await api.channels();
        setState({ kind: "ready", me, channels });
      } catch (err) {
        setState(explain(err));
      }
    })();
  }, []);

  if (state.kind === "loading") return <main className="center">Carregando…</main>;
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
      {channel ? <ChannelView channel={channel} /> : <main className="center">Nenhum Canal ainda.</main>}
    </div>
  );
}
