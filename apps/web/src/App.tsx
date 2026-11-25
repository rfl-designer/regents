import {
  ACCOUNT_PATH,
  AGENTS_PATH,
  type ChannelDto,
  conversationOfPath,
  conversationPath,
  type DmDto,
  GITHUB_PATH,
  INSTALLATION_PATH,
  MEMBERS_PATH,
  type MeDto,
  MY_CONNECTORS_PATH,
  NO_IDENTITY_TEXT,
  SW_NAVIGATE_MESSAGE,
  type UnreadDto,
  WORKSPACE_KEY_PATH,
} from "@shearim/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AgentsSettings, WorkspaceKeySettings } from "./AgentsAdmin";
import { Avatar } from "./Avatar";
import { ApiFailure, api } from "./api";
import { ChannelSettings } from "./ChannelSettings";
import { ChannelView } from "./ChannelView";
import { ConnectorsSettings } from "./ConnectorsAdmin";
import { type Notice, notice, reachOf, useConnectionNotice, useOnline } from "./connection";
import { DevicesView } from "./DevicesView";
import { DmView } from "./DmView";
import { EntryView } from "./EntryView";
import { GitHubSettings } from "./GitHubSettings";
import { InstallationBanner, InstallationSettings, useInstallation } from "./Installation";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { KeyBanners } from "./KeyBanners";
import { setPresence, useServerEvents } from "./live";
import { MembersSettings } from "./MembersAdmin";
import { AccountOffer, expiringValidity, MyAccount, useAccount } from "./MyAccount";
import { MyConnectors } from "./MyConnectors";
import { NotificationsOnboarding } from "./NotificationsOnboarding";
import { closeNotificationsOf, showBadge, usePush } from "./notifications";
import { ProfileView } from "./ProfileView";
import { InstallOnIphone, PushBanners } from "./PushBanners";
import { type AdminView, Sidebar } from "./Sidebar";
import { WorkspaceContextSettings } from "./WorkspaceContext";

type State =
  | { kind: "loading" }
  | { kind: "ready"; me: MeDto; channels: ChannelDto[]; dms: DmDto[] }
  /** Tem identidade da tailnet, mas ainda não é Membro: o Pedido de entrada. */
  | { kind: "entry" }
  /** O servidor não respondeu, ou respondeu sem o tailscaled: a tela tenta de novo sozinha. */
  | { kind: "down"; reach: "unreachable" | "identity_unavailable" }
  | { kind: "blocked"; title: string; detail: string };

/** De quanto em quanto tempo a tela de sem conexão tenta carregar de novo. */
const RELOAD_MS = 2_000;

function explain(err: unknown): State {
  const reach = reachOf(err);
  if (reach === "unreachable" || reach === "identity_unavailable") return { kind: "down", reach };
  // Em geral quem chega sem identidade já recebe a página estática do servidor;
  // isto cobre o PWA aberto do cache ou a identidade que some no meio da sessão.
  if (err instanceof ApiFailure && err.body?.error === "no_identity") {
    const text = NO_IDENTITY_TEXT[err.body.reason] ?? NO_IDENTITY_TEXT.unknown;
    return { kind: "blocked", title: "Não sabemos quem é você", detail: `${text.why} ${text.whatToDo}` };
  }
  if (err instanceof ApiFailure && err.body?.error === "not_a_member") return { kind: "entry" };
  return { kind: "blocked", title: "Algo deu errado", detail: "Recarregue a página para tentar de novo." };
}

type Screen = "account" | "myConnectors" | "profile" | "notifications" | AdminView;
/** `channel` é a conversa aberta (Canal ou DM); as outras são telas (`SCREENS`). */
type View = "channel" | Screen;

/** O que as telas recebem do App. */
interface ScreenContext {
  me: MeDto;
  account: ReturnType<typeof useAccount>;
  push: ReturnType<typeof usePush>;
  installation: ReturnType<typeof useInstallation>;
  setMe(change: (me: MeDto) => MeDto): void;
}

/**
 * Cada tela que não é conversa: o endereço próprio, se tem (é para onde levam os pushes que não
 * são de conversa), se é do Admin (fica marcada no painel dele) e o que mostra.
 */
const SCREENS: Record<Screen, { path?: string; admin?: true; render(ctx: ScreenContext): ReactNode }> = {
  profile: { render: ({ me, setMe }) => <ProfileView key={me.id} me={me} onSaved={(saved) => setMe(() => saved)} /> },
  account: { path: ACCOUNT_PATH, render: ({ account }) => <MyAccount state={account} /> },
  myConnectors: { path: MY_CONNECTORS_PATH, render: () => <MyConnectors /> },
  notifications: { render: ({ push }) => <DevicesView push={push} /> },
  members: { path: MEMBERS_PATH, admin: true, render: ({ me }) => <MembersSettings me={me} /> },
  context: { admin: true, render: () => <WorkspaceContextSettings /> },
  settings: { admin: true, render: () => <ChannelSettings /> },
  agents: { path: AGENTS_PATH, admin: true, render: () => <AgentsSettings /> },
  connectors: { admin: true, render: () => <ConnectorsSettings /> },
  key: { path: WORKSPACE_KEY_PATH, admin: true, render: () => <WorkspaceKeySettings /> },
  github: { path: GITHUB_PATH, admin: true, render: () => <GitHubSettings /> },
  installation: {
    path: INSTALLATION_PATH,
    admin: true,
    render: ({ installation }) => <InstallationSettings state={installation} />,
  },
};

/** O endereço próprio da tela, se ela tem. */
const pathOf = (view: View) => (view === "channel" ? undefined : SCREENS[view].path);

/** A tela que um endereço pede (`/conta`, `/chave`…), ou `undefined` (uma conversa, ou a raiz). */
function viewOfPath(pathname: string): View | undefined {
  return (Object.keys(SCREENS) as Screen[]).find((s) => SCREENS[s].path === pathname);
}

function conversationFromUrl() {
  return conversationOfPath(location.pathname);
}

/** A mensagem que o endereço pede (`/c/<id>?m=<mensagem>`: o push da falha leva a ela). */
function focusOfUrl(href: string) {
  const url = new URL(href, location.origin);
  const conversationId = conversationOfPath(url.pathname);
  const messageId = url.searchParams.get("m");
  return conversationId && messageId ? { conversationId, messageId } : null;
}

const isPageVisible = () => document.visibilityState === "visible" && document.hasFocus();

/** Se a página está à vista: aba visível e em foco, ou o PWA em primeiro plano. */
function usePageVisible() {
  const [visible, setVisible] = useState(isPageVisible);
  useEffect(() => {
    const update = () => setVisible(isPageVisible());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return visible;
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
  const [selectedId, setSelectedId] = useState<string | null>(conversationFromUrl);
  const [view, setView] = useState<View>(() => viewOfPath(location.pathname) ?? "channel");
  const account = useAccount(state.kind === "ready");
  const push = usePush(state.kind === "ready");
  const installation = useInstallation(state.kind === "ready" && state.me.role === "admin");
  /** As não-lidas do Membro. O `total` é o badge do ícone. */
  const [unread, setUnread] = useState<UnreadDto | null>(null);
  /** A mensagem para onde a notificação levou (a da falha, com "Tentar de novo"), na conversa dela. */
  const [focus, setFocus] = useState<{ conversationId: string; messageId: string } | null>(() =>
    focusOfUrl(location.href),
  );

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

  const online = useOnline();
  const lost = useCallback((err: unknown) => setState(explain(err)), []);
  const connection = useConnectionNotice(lost);

  useServerEvents((event) => {
    // A cada (re)conexão, a lista do servidor manda: pode ter mudado enquanto a conexão caiu.
    if (event.type === "ready") {
      api.unread().then(setUnread, () => {});
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
    if (event.type === "unread.updated") setUnread(event.unread);
    // O perfil editado em outra aba: o "Você está como" acompanha.
    if (event.type === "member.updated") {
      setMe((me) => (me.id === event.member.id ? { ...me, ...event.member } : me));
    }
    // Um Admin me removeu: o Workspace some e fica a tela do Pedido de entrada.
    if (event.type === "member.removed" && state.kind === "ready" && event.memberId === state.me.id) void load();
  }, state.kind === "ready");

  useEffect(() => {
    void load();
  }, [load]);

  // O badge do ícone acompanha o total de não-lidas: ao abrir e a cada mudança.
  const badge = unread?.total;
  useEffect(() => {
    if (badge !== undefined) showBadge(badge);
  }, [badge]);

  // Sem conexão ao abrir: tenta de novo sozinho, e na hora em que a internet volta.
  const down = state.kind === "down";
  useEffect(() => {
    if (!down) return;
    const timer = setInterval(load, RELOAD_MS);
    window.addEventListener("online", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", load);
    };
  }, [down, load]);

  // Tocar numa notificação com o Shearim já aberto: o service worker pede a conversa aqui.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== SW_NAVIGATE_MESSAGE) return;
      const navigate = typeof e.data.navigate === "string" ? new URL(e.data.navigate, location.origin) : null;
      // Os pushes do Admin e da Conta levam a uma tela (Instalação, Membros, Chave, Agentes, Minha
      // Conta), não a uma conversa.
      const target = navigate ? viewOfPath(navigate.pathname) : undefined;
      if (target) {
        setView(target);
        return;
      }
      const conversationId = navigate ? conversationOfPath(navigate.pathname) : null;
      if (conversationId) {
        setFocus(focusOfUrl(navigate!.href));
        setSelectedId(conversationId);
        setView("channel");
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // A conversa aberta e visível: a Presença cala o push dela, e as notificações dela neste
  // aparelho se fecham ao abri-la.
  const pageVisible = usePageVisible();
  const ready = state.kind === "ready";
  // A conversa selecionada: a DM, ou o Canal (o primeiro, se nada foi escolhido).
  const dm = ready ? state.dms.find((d) => d.id === selectedId) : undefined;
  const channel = ready && !dm ? (state.channels.find((c) => c.id === selectedId) ?? state.channels[0]) : undefined;
  const shownId = view === "channel" ? (dm?.id ?? channel?.id ?? null) : null;
  const watching = pageVisible ? shownId : null;
  useEffect(() => {
    setPresence(watching);
    if (watching) void closeNotificationsOf(watching);
  }, [watching]);
  useEffect(() => {
    const path = pathOf(view);
    if (path) {
      if (location.pathname !== path) history.replaceState(null, "", path);
      return;
    }
    if (shownId && location.pathname !== conversationPath(shownId)) {
      history.replaceState(null, "", conversationPath(shownId));
    }
  }, [shownId, view]);

  if (state.kind === "loading") return <main className="center">Carregando…</main>;
  if (state.kind === "entry") return <EntryView onApproved={load} />;
  if (state.kind === "down") {
    const { title, detail } = online ? notice(state.reach) : notice("offline");
    return (
      <main className="center">
        <h1>{title}</h1>
        <p>{detail}</p>
      </main>
    );
  }
  if (state.kind === "blocked") {
    return (
      <main className="center">
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
      </main>
    );
  }

  const focusIn = (conversationId: string) => (focus?.conversationId === conversationId ? focus.messageId : undefined);
  const open = (id: string) => {
    setFocus(null);
    setSelectedId(id);
    setView("channel");
  };
  return (
    <div className="shell">
      <ConnectionBanner notice={connection} />
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
            <Avatar name={state.me.displayName} photo={state.me.profilePicUrl} />
            <span>Você está como {state.me.displayName}</span>
            <span className="handle">@{state.me.handle}</span>
          </button>
          <button
            type="button"
            className="link"
            aria-pressed={view === "notifications"}
            onClick={() => setView(view === "notifications" ? "channel" : "notifications")}
          >
            Notificações
          </button>
          <button
            type="button"
            className="link"
            aria-pressed={view === "account"}
            onClick={() => setView(view === "account" ? "channel" : "account")}
          >
            {view === "account" ? "Voltar à conversa" : "Minha Conta"}
            {expiringValidity(account.account) && (
              <span className="selo" role="img" aria-label="A sua Conta do Claude vence em breve" />
            )}
          </button>
          <button
            type="button"
            className="link"
            aria-pressed={view === "myConnectors"}
            onClick={() => setView(view === "myConnectors" ? "channel" : "myConnectors")}
          >
            {view === "myConnectors" ? "Voltar à conversa" : "Meus Conectores"}
          </button>
        </div>
      </header>
      {state.me.role === "admin" && <JoinRequestsPanel />}
      {state.me.role === "admin" && (
        <KeyBanners onOpenKey={() => setView("key")} onOpenAgents={() => setView("agents")} />
      )}
      {view !== "installation" && (
        <InstallationBanner installation={installation.installation} onOpen={() => setView("installation")} />
      )}
      {view !== "account" && <AccountOffer state={account} onOpen={() => setView("account")} />}
      <InstallOnIphone />
      <NotificationsOnboarding push={push} />
      <PushBanners push={push} onOpenDevices={() => setView("notifications")} />
      <div className="workspace">
        <Sidebar
          me={state.me}
          channels={state.channels}
          dms={state.dms}
          unread={unread}
          selectedId={shownId}
          isAdmin={state.me.role === "admin"}
          adminView={view !== "channel" && SCREENS[view].admin ? (view as AdminView) : null}
          onOpen={open}
          onCreated={(created) => {
            setChannels((list) => upsert(list, created));
            open(created.id);
          }}
          onDmOpened={(opened) => {
            setDms((list) => upsert(list, opened));
            open(opened.id);
          }}
          onOpenAdmin={setView}
        />
        {view !== "channel" ? (
          SCREENS[view].render({ me: state.me, account, push, installation, setMe })
        ) : dm ? (
          <DmView key={dm.id} dm={dm} me={state.me} focus={focusIn(dm.id)} />
        ) : channel ? (
          <ChannelView
            key={channel.id}
            channel={channel}
            me={state.me}
            focus={focusIn(channel.id)}
            onChanged={(changed) => setChannels((list) => upsert(list, changed))}
          />
        ) : (
          <main className="center">Nenhum Canal ainda.</main>
        )}
      </div>
    </div>
  );
}

/**
 * A faixa de conexão sobre a conversa. A região `status` fica sempre montada (vazia quando está
 * tudo bem), para o leitor de tela anunciar quando o aviso aparece.
 */
function ConnectionBanner({ notice }: { notice: Notice | null }) {
  return (
    <div className="connection-banner" role="status" data-kind={notice?.kind}>
      {notice && (
        <>
          <strong>{notice.title}</strong> <span>{notice.detail}</span>
        </>
      )}
    </div>
  );
}
