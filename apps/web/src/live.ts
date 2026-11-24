import { EVENTS_PATH, type ServerEvent } from "@shearim/contracts";
import { useEffect, useRef } from "react";

/** Quanto esperar para reabrir o WebSocket depois que ele cai. */
const RETRY_MS = 1_000;

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let stop: (() => void) | undefined;

/**
 * Uma só conexão por aba com o WebSocket de eventos, reaberta sozinha quando cai.
 * Cada reabertura começa com um `ready`: quem ouve recarrega o que pode ter perdido.
 * (O aviso "Reconectando…" é do #40.)
 */
function connect(): () => void {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    const url = new URL(EVENTS_PATH, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(url);
    ws.onmessage = (m) => {
      const event = JSON.parse(String(m.data)) as ServerEvent;
      for (const listener of listeners) listener(event);
    };
    ws.onclose = () => {
      if (!stopped) retry = setTimeout(open, RETRY_MS);
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
  };
}

/** Recebe os eventos do servidor enquanto o componente estiver montado. */
export function useServerEvents(handler: Listener) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
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
  }, []);
}
