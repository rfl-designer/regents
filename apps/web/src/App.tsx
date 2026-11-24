import type { ChannelDto, MeDto } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { AgentsSettings, WorkspaceKeySettings } from "./AgentsAdmin";
import { ApiFailure, api, Offline } from "./api";
import { ChannelSettings } from "./ChannelSettings";
import { ChannelView } from "./ChannelView";
import { useServerEvents } from "./live";
import { type AdminView, Sidebar } from "./Sidebar";

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

/** Insere ou troca pelo `id`, mantendo a ordem de criação (Canal novo vai para o fim). */
function upsert(list: ChannelDto[], channel: ChannelDto) {
  const i = list.findIndex((c) => c.id === channel.id);
  if (i < 0) return [...list, channel];
  const next = [...list];
  next[i] = channel;
  return next;
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"channel" | AdminView>("channel");

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

  const setChannels = useCallback((change: (list: ChannelDto[]) => ChannelDto[]) => {
    setState((s) => (s.kind === "ready" ? { ...s, channels: change(s.channels) } : s));
  }, []);

  useServerEvents((event) => {
    // A cada (re)conexão, a lista do servidor manda: pode ter mudado enquanto a conexão caiu.
    if (event.type === "ready")
      api.channels().then(
        (list) => setChannels(() => list),
        () => {},
      );
    if (event.type === "channel.updated") setChannels((list) => upsert(list, event.channel));
  });

  if (state.kind === "loading") return <main className="center">Carregando…</main>;
  if (state.kind === "blocked") {
    return (
      <main className="center">
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
      </main>
    );
  }

  const channel = state.channels.find((c) => c.id === selectedId) ?? state.channels[0];
  const open = (id: string) => {
    setSelectedId(id);
    setView("channel");
  };
  return (
    <div className="shell">
      <header className="topbar">
        <strong>Shearim</strong>
        <span className="whoami">Você está como {state.me.displayName}</span>
      </header>
      <div className="workspace">
        <Sidebar
          channels={state.channels}
          selectedId={view === "channel" ? (channel?.id ?? null) : null}
          isAdmin={state.me.role === "admin"}
          adminView={view === "channel" ? null : view}
          onOpen={open}
          onCreated={(created) => {
            setChannels((list) => upsert(list, created));
            open(created.id);
          }}
          onOpenAdmin={setView}
        />
        {view === "settings" ? (
          <ChannelSettings />
        ) : view === "agents" ? (
          <AgentsSettings />
        ) : view === "key" ? (
          <WorkspaceKeySettings />
        ) : channel ? (
          <ChannelView
            key={channel.id}
            channel={channel}
            me={state.me}
            onChanged={(changed) => setChannels((list) => upsert(list, changed))}
          />
        ) : (
          <main className="center">Nenhum Canal ainda.</main>
        )}
      </div>
    </div>
  );
}
