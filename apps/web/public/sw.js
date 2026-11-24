/**
 * Service worker do Shearim. O push chega no JSON do Declarative Web Push (Spec, módulo 12):
 * `{ web_push: 8030, notification: { title, body, navigate, tag, lang }, app_badge }`. O Safari
 * que entende o formato mostra a notificação sozinho; nos outros navegadores, este service worker
 * lê o mesmo JSON e monta a notificação. A mesma `tag` substitui a anterior da conversa.
 * (O `setAppBadge` é do #32.)
 */

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
      await self.registration.showNotification(n.title || "Shearim", {
        body: n.body,
        tag: n.tag,
        lang: n.lang || "pt-BR",
        icon: "/icon-192.png",
        data: { navigate: n.navigate || "/", conversationId: n.tag },
      });
    })(),
  );
});

/** Tocar na notificação abre a conversa: numa janela do Shearim que já esteja aberta, ou numa nova. */
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
