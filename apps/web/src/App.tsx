import { type ChannelDto, type DmDto, type MeDto, NO_IDENTITY_TEXT } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { ApiFailure, api, Offline } from "./api";
import { ChannelSettings } from "./ChannelSettings";
import { ChannelView } from "./ChannelView";
import { DmView } from "./DmView";
import { EntryView } from "./EntryView";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { useServerEvents } from "./live";
import { AccountOffer, MyAccount, useAccount } from "./MyAccount";
import { ProfileView } from "./ProfileView";
import { Sidebar } from "./Sidebar";

type State =
  | { kind: "loading" }
  | { kind: "ready"; me: MeDto; channels: ChannelDto[]; dms: DmDto[] }
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

/** Insere ou troca pelo `id`, mantendo a ordem de criação (conversa nova vai para o fim). */
function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((c) => c.id === item.id);
  if (i < 0) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"channel" | "settings" | "account" | "profile">("channel");
  const account = useAccount(state.kind === "ready");

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      const [channels, dms] = await Promise.all([api.channels(), api.dms()]);
      setState({ kind: "ready", me, channels, dms });
    } catch (err) {
      setState(explain(err));
    }
  }, []);

  const setChannels = useCallback((change: (list: ChannelDto[]) => ChannelDto[]) => {
    setState((s) => (s.kind === "ready" ? { ...s, channels: change(s.channels) } : s));
  }, []);
  const setDms = useCallback((change: (list: DmDto[]) => DmDto[]) => {
    setState((s) => (s.kind === "ready" ? { ...s, dms: change(s.dms) } : s));
  }, []);

  const setMe = useCallback((change: (me: MeDto) => MeDto) => {
    setState((s) => (s.kind === "ready" ? { ...s, me: change(s.me) } : s));
  }, []);

  useServerEvents((event) => {
    // A cada (re)conexão, a lista do servidor manda: pode ter mudado enquanto a conexão caiu.
    if (event.type === "ready") {
      setMe(() => event.me);
      api.channels().then(
        (list) => setChannels(() => list),
        () => {},
      );
      api.dms().then(
        (list) => setDms(() => list),
        () => {},
      );
    }
    if (event.type === "channel.updated") setChannels((list) => upsert(list, event.channel));
    if (event.type === "dm.updated") setDms((list) => upsert(list, event.dm));
    // O perfil editado em outra aba: o "Você está como" acompanha.
    if (event.type === "member.updated") {
      setMe((me) => (me.id === event.member.id ? { ...me, ...event.member } : me));
    }
  });

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

  const dm = state.dms.find((d) => d.id === selectedId);
  const channel = dm ? undefined : (state.channels.find((c) => c.id === selectedId) ?? state.channels[0]);
  const open = (id: string) => {
    setSelectedId(id);
    setView("channel");
  };
  return (
    <div className="shell">
      <header className="topbar">
        <strong>Shearim</strong>
        <div className="row">
          <button
            type="button"
            className="whoami"
            aria-current={view === "profile" ? "page" : undefined}
            title="Meu perfil"
            onClick={() => setView("profile")}
          >
            <Avatar name={state.me.displayName} src={state.me.profilePicUrl} />
            <span>Você está como {state.me.displayName}</span>
            <span className="handle">@{state.me.handle}</span>
          </button>
          <button
            type="button"
            className="link"
            aria-pressed={view === "account"}
            onClick={() => setView(view === "account" ? "channel" : "account")}
          >
            {view === "account" ? "Voltar à conversa" : "Minha Conta"}
          </button>
        </div>
      </header>
      {state.me.role === "admin" && <JoinRequestsPanel />}
      {view !== "account" && <AccountOffer state={account} onOpen={() => setView("account")} />}
      <div className="workspace">
        <Sidebar
          me={state.me}
          channels={state.channels}
          dms={state.dms}
          selectedId={view === "channel" ? (dm?.id ?? channel?.id ?? null) : null}
          isAdmin={state.me.role === "admin"}
          settingsOpen={view === "settings"}
          onOpen={open}
          onCreated={(created) => {
            setChannels((list) => upsert(list, created));
            open(created.id);
          }}
          onDmOpened={(opened) => {
            setDms((list) => upsert(list, opened));
            open(opened.id);
          }}
          onOpenSettings={() => setView("settings")}
        />
        {view === "profile" ? (
          <ProfileView key={state.me.id} me={state.me} onSaved={(me) => setMe(() => me)} />
        ) : view === "account" ? (
          <MyAccount state={account} />
        ) : view === "settings" ? (
          <ChannelSettings />
        ) : dm ? (
          <DmView key={dm.id} dm={dm} me={state.me} />
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
