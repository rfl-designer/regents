/**
 * A rede de mentira de um e2e: o runner não tem `setOffline`, então um init script troca o que o
 * PWA usa para falar com o mundo (`navigator.onLine`, `fetch` e `WebSocket`) e deixa o teste
 * escolher o estado da rede com `network(browser, modo)`:
 *
 * - `"online"`: tudo normal.
 * - `"offline"`: o aparelho sem internet (`navigator.onLine` falso, evento `offline`, nada sai).
 * - `"server-down"`: com internet, mas o Shearim não responde (o Tailscale desligado).
 * - `"socket-down"`: o HTTP responde, só o WebSocket de eventos não abre.
 *
 * Os modos que não são `"online"` derrubam os WebSockets abertos. Chame `emulateNetwork` antes
 * do `app.open`.
 */
import type { Browser } from "@e2e-dev/web";

export type NetworkMode = "online" | "offline" | "server-down" | "socket-down";

/** O init script: roda na página, antes do PWA, sem fechar sobre nada daqui. */
function install(initial: NetworkMode) {
  let mode = initial;
  let opened = 0;
  const sockets = new Set<WebSocket>();
  const realFetch = window.fetch.bind(window);
  const RealWebSocket = window.WebSocket;

  Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => mode !== "offline" });
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    mode === "offline" || mode === "server-down"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : realFetch(input, init)) as typeof fetch;

  // Um WebSocket bloqueado vai para um endereço do próprio servidor que recusa o upgrade:
  // falha como uma conexão que não abre (fecha com 1006).
  class EmulatedWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const blocked = new URL("/api/e2e-sem-websocket", location.href);
      blocked.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      super(mode === "online" ? url : blocked, protocols);
      opened += 1;
      sockets.add(this);
      this.addEventListener("close", () => sockets.delete(this));
    }
  }
  window.WebSocket = EmulatedWebSocket;

  (window as unknown as { __socketsOpened: () => number }).__socketsOpened = () => opened;
  (window as unknown as { __network: (next: NetworkMode) => void }).__network = (next) => {
    const was = mode;
    mode = next;
    if (next !== "online") for (const ws of sockets) ws.close();
    if (next === "offline" && was !== "offline") window.dispatchEvent(new Event("offline"));
    if (was === "offline" && next !== "offline") window.dispatchEvent(new Event("online"));
  };
}

/** Põe a rede de mentira nesta execução; a página abre no modo `initial`. */
export function emulateNetwork(browser: Browser, initial: NetworkMode = "online") {
  return browser.addInitScript(install, initial);
}

/** Troca o estado da rede da página aberta. */
export async function network(browser: Browser, mode: NetworkMode) {
  await browser.evaluate((m) => {
    (window as unknown as { __network: (next: string) => void }).__network(m);
    return null;
  }, mode);
}

/** Quantos WebSockets a página tentou abrir desde que carregou. */
export function socketsOpened(browser: Browser) {
  return browser.evaluate(() => (window as unknown as { __socketsOpened: () => number }).__socketsOpened());
}
