import { type AgentDto, EVENTS_CLOSE_UPDATING, EVENTS_PATH, type ServerEvent } from "@regents/contracts";
import { type Dispatch, type SetStateAction, useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api";

/** Quanto esperar para reabrir o WebSocket depois que ele cai. */
const RETRY_MS = 1_000;

// ---------- Estado da conexão, para os avisos de conexão (connection.ts) ----------

/**
 * Como está o WebSocket de eventos desta aba. `idle`: ninguém assina (antes de ser Membro);
 * `connecting`: a primeira abertura; `open`: chegou o `ready`; `down`: caiu e está reabrindo.
 * `updatingSince`: quando o servidor fechou com 1012 (o dreno de uma atualização), até reabrir.
 */
export interface LiveStatus {
  socket: "idle" | "connecting" | "open" | "down";
  updatingSince: number | null;
}

let status: LiveStatus = { socket: "idle", updatingSince: null };
const statusListeners = new Set<() => void>();

function setStatus(change: Partial<LiveStatus>) {
  status = { ...status, ...change };
  for (const fn of statusListeners) fn();
}

/** O estado do WebSocket de eventos, vivo. */
export function useLiveStatus() {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    () => status,
  );
}

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let stop: (() => void) | undefined;

// ---------- Presença: qual conversa esta aba tem à vista ----------

/** O `connectionId` do `ready` da conexão aberta agora (some quando ela cai). */
let connectionId: string | undefined;
/** O que a tela quer dizer: a conversa aberta e visível, ou nenhuma. */
let watching: string | null = null;
/** Uma Presença de cada vez, na ordem: "abri" e "saí" não podem chegar trocados. */
let presenceChain: Promise<unknown> = Promise.resolve();

function sendPresence() {
  const id = connectionId;
  const conversationId = watching;
  if (!id) return;
  presenceChain = presenceChain.then(() =>
    api.setPresence({ connectionId: id, conversationId }).catch((err) => {
      console.error("regents: a Presença não chegou ao servidor", err);
    }),
  );
}

/**
 * Diz ao servidor qual conversa esta aba tem aberta e visível (ou `null`). Enquanto houver uma,
 * o push dela cala. A cada reconexão, vai de novo (a Presença cai junto com a conexão).
 */
export function setPresence(conversationId: string | null) {
  if (watching === conversationId) return;
  watching = conversationId;
  sendPresence();
}

/**
 * Uma só conexão por aba com o WebSocket de eventos, reaberta sozinha quando cai.
 * Cada reabertura começa com um `ready`: quem ouve recarrega o que pode ter perdido.
 * Sem internet (`navigator.onLine` falso), não tenta: fecha o que estava aberto e reabre assim
 * que a internet volta. O fechamento com 1012 marca a atualização do servidor.
 */
function connect(): () => void {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    clearTimeout(retry);
    if (stopped || !navigator.onLine) return;
    if (ws && ws.readyState !== WebSocket.CLOSED) return;
    const url = new URL(EVENTS_PATH, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    ws = socket;
    socket.onmessage = (m) => {
      const event = JSON.parse(String(m.data)) as ServerEvent;
      if (event.type === "ready") {
        connectionId = event.connectionId;
        setStatus({ socket: "open", updatingSince: null });
        if (watching) sendPresence();
      }
      for (const listener of listeners) listener(event);
    };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      connectionId = undefined;
      if (stopped) return;
      const updating = e.code === EVENTS_CLOSE_UPDATING;
      setStatus({ socket: "down", updatingSince: updating ? Date.now() : status.updatingSince });
      retry = setTimeout(open, RETRY_MS);
    };
  };

  // A conexão de um aparelho que perdeu a rede pode demorar a perceber que morreu.
  const offline = () => ws?.close();
  window.addEventListener("offline", offline);
  window.addEventListener("online", open);
  setStatus({ socket: navigator.onLine ? "connecting" : "down" });
  open();

  return () => {
    stopped = true;
    clearTimeout(retry);
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", open);
    ws?.close();
    connectionId = undefined;
    setStatus({ socket: "idle", updatingSince: null });
  };
}

/**
 * Recebe os eventos do servidor enquanto o componente estiver montado e `enabled` (só Membro abre
 * o WebSocket: antes disso, o upgrade é recusado e a aba ficaria reabrindo à toa).
 */
export function useServerEvents(handler: Listener, enabled = true) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    if (!enabled) return;
    const listener: Listener = (event) => latest.current(event);
    listeners.add(listener);
    stop ??= connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stop?.();
        stop = undefined;
      }
    };
  }, [enabled]);
}

/**
 * Tira da lista de Agentes `setAgents` o Agente que um Admin apaga, sem esperar recarregar: quem
 * o escolhesse depois receberia um erro.
 */
export function useDropDeletedAgents(setAgents: Dispatch<SetStateAction<AgentDto[] | null>>) {
  useServerEvents((event) => {
    if (event.type === "agent.deleted") setAgents((list) => list?.filter((a) => a.id !== event.agentId) ?? null);
  });
}
