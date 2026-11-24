/**
 * Service worker do Shearim. O push chega no JSON do Declarative Web Push (Spec, módulo 12):
 * `{ web_push: 8030, notification: { title, body, navigate, tag, lang, icon? }, app_badge }`. O Safari
 * que entende o formato mostra a notificação sozinho; nos outros navegadores, este service worker
 * lê o mesmo JSON e monta a notificação. A mesma `tag` substitui a anterior da conversa. O
 * `app_badge` (o total de não-lidas) vai para o badge do ícone.
 */

/** A conversa para onde a notificação leva (`/c/<id>`, com ou sem `?m=<mensagem>`), ou nada. */
function conversationOf(navigate) {
  try {
    return /^\/c\/([0-9a-f-]{36})$/i.exec(new URL(navigate).pathname)?.[1];
  } catch {
    return undefined;
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let message = {};
      try {
        message = event.data ? event.data.json() : {};
      } catch {
        // Corpo que não é JSON: ainda assim mostra algo (sem notificação, o navegador reclama).
      }
      const n = message.notification || {};
      if (typeof message.app_badge === "number" && "setAppBadge" in self.navigator) {
        const badge =
          message.app_badge > 0 ? self.navigator.setAppBadge(message.app_badge) : self.navigator.clearAppBadge();
        await badge.catch(() => {});
      }
      await self.registration.showNotification(n.title || "Shearim", {
        body: n.body,
        tag: n.tag,
        lang: n.lang || "pt-BR",
        // A foto de quem pede para entrar (o push do Pedido de entrada); senão, o ícone do app.
        icon: n.icon || "/icon-192.png",
        // A conversa vem do `navigate`: a notificação de falha tem `tag` própria.
        data: { navigate: n.navigate || "/", conversationId: conversationOf(n.navigate) },
      });
    })(),
  );
});

/** Tocar na notificação abre a conversa (ou a tela do push do Admin e da Conta): numa janela do Shearim que já esteja aberta, ou numa nova. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { navigate, conversationId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open-conversation", conversationId, navigate });
        return;
      }
      await self.clients.openWindow(navigate || "/");
    })(),
  );
});
