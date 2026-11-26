import { useEffect, useState } from "react";
import { ApiFailure, api, Offline } from "./api";
import { type LiveStatus, useLiveStatus } from "./live";

/**
 * Os avisos de conexão. Cada um diz o que está acontecendo e o que fazer, e some sozinho:
 * - `offline`: o aparelho está sem internet (`navigator.onLine`).
 * - `updating`: o servidor fechou o WebSocket com 1012, o dreno de uma atualização.
 * - `identity_unavailable`: o servidor responde, mas não fala com o tailscaled (503).
 * - `unreachable`: o servidor não responde (no aparelho, o Tailscale costuma estar desligado).
 * - `reconnecting`: o servidor responde, só o WebSocket ainda não voltou.
 */
export type NoticeKind = "offline" | "updating" | "identity_unavailable" | "unreachable" | "reconnecting";

export interface Notice {
  kind: NoticeKind;
  title: string;
  detail: string;
}

const NOTICES: Record<NoticeKind, Omit<Notice, "kind">> = {
  offline: {
    title: "Você está sem internet",
    detail: "Confira o Wi-Fi ou os dados móveis deste aparelho. O Regents volta sozinho quando a internet voltar.",
  },
  updating: {
    title: "Atualizando o Regents",
    detail: "A conversa volta em alguns segundos.",
  },
  identity_unavailable: {
    title: "O Regents não consegue falar com o Tailscale",
    detail:
      "O servidor está no ar, mas não consegue confirmar quem é você. Avise quem cuida da Instalação. O Regents tenta de novo sozinho.",
  },
  unreachable: {
    title: "Sem conexão com o Regents",
    detail: "Confira se o Tailscale está ligado neste aparelho. O Regents tenta de novo sozinho.",
  },
  reconnecting: {
    title: "Reconectando…",
    detail: "As mensagens novas aparecem assim que a conexão voltar.",
  },
};

export function notice(kind: NoticeKind): Notice {
  return { kind, ...NOTICES[kind] };
}

/** Quanto tempo o 1012 segura "Atualizando o Regents" antes de virar "Sem conexão" (uma atualização que não volta). */
const UPDATE_GRACE_MS = 2 * 60_000;
/** De quanto em quanto tempo, com o WebSocket caído, pergunta ao servidor se ele responde. */
const PROBE_MS = 2_000;

/** O que se sabe do servidor quando o WebSocket cai: responde, não responde, ou responde sem o tailscaled. */
export type Reach = "unknown" | "ok" | "unreachable" | "identity_unavailable";

/** A falha da API vista como alcance do servidor; `undefined` quando é outra coisa (sem identidade, não Membro). */
export function reachOf(err: unknown): Reach | undefined {
  if (err instanceof Offline) return "unreachable";
  if (err instanceof ApiFailure && err.body?.error === "identity_unavailable") return "identity_unavailable";
  return undefined;
}

/** O aviso da hora, em ordem de prioridade; `null` quando está tudo bem. */
export function noticeFor(input: { online: boolean; live: LiveStatus; reach: Reach; now: number }): Notice | null {
  const { online, live, reach, now } = input;
  if (!online) return notice("offline");
  if (live.socket !== "down") return null;
  if (live.updatingSince !== null && now - live.updatingSince < UPDATE_GRACE_MS) return notice("updating");
  if (reach === "identity_unavailable") return notice("identity_unavailable");
  if (reach === "unreachable") return notice("unreachable");
  return notice("reconnecting");
}

/** `navigator.onLine`, vivo. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/**
 * O aviso de conexão com a conversa aberta. Com o WebSocket caído e internet, pergunta ao servidor
 * (`GET /api/me`) a cada `PROBE_MS` para separar "Reconectando…" de "Sem conexão com o Regents".
 * Um 403 (a identidade sumiu, deixou de ser Membro) vai para `onLost`: a conversa não volta sozinha.
 */
export function useConnectionNotice(onLost: (err: unknown) => void): Notice | null {
  const online = useOnline();
  const live = useLiveStatus();
  const [reach, setReach] = useState<Reach>("unknown");
  const [now, setNow] = useState(() => Date.now());
  const probing = online && live.socket === "down";

  useEffect(() => {
    if (!probing) {
      setReach("unknown");
      return;
    }
    let cancelled = false;
    const probe = () => {
      api.me().then(
        () => !cancelled && setReach("ok"),
        (err) => {
          if (cancelled) return;
          const r = reachOf(err);
          if (r) setReach(r);
          else if (err instanceof ApiFailure && err.status === 403) onLost(err);
          else setReach("ok");
        },
      );
    };
    probe();
    const timer = setInterval(probe, PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [probing, onLost]);

  // "Atualizando o Regents" tem prazo: quando vence, o aviso muda sem esperar outro evento.
  useEffect(() => {
    if (live.updatingSince === null) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), live.updatingSince + UPDATE_GRACE_MS - Date.now());
    return () => clearTimeout(timer);
  }, [live.updatingSince]);

  return noticeFor({ online, live, reach, now });
}
