# Web Push no PWA servido pela tailnet

Pesquisa para a issue #4 (parte do mapa #1). Data: 2026-11-23.

**Pergunta.** Um PWA servido em `https://<host>.<tailnet>.ts.net`, com certificado Let's Encrypt emitido pelo Tailscale e acessível só de dentro da tailnet, recebe Web Push no iPhone (PWA na tela inicial), no Android (Chrome) e no desktop (Chrome, Safari, Firefox)? Quais são os requisitos e os limites, e o que precisa estar conectado à tailnet?

**Como ler as marcas.**
- **documentado**: afirmado por fonte primária (link ao lado).
- **medido**: reproduzido nesta pesquisa, em máquina local (macOS arm64, Bun 1.3.11, `web-push@4.0.0`). O script está descrito na seção 9.
- **não verificado**: inferência ou conhecimento corrente sem fonte primária lida aqui. Precisa de teste em aparelho real antes de virar premissa.

---

## 1. O certificado do Tailscale serve para Web Push?

- Web Push e service worker exigem contexto seguro (HTTPS). **documentado** ([MDN, `Notification.requestPermission`](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static): "available only in secure contexts (HTTPS)").
- O certificado de `<host>.<tailnet>.ts.net` é um certificado Let's Encrypt comum, validado por DNS-01 (o Tailscale cria o registro TXT em `*.ts.net`). A chave privada é gerada no próprio nó. **documentado** ([Tailscale, Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)).
- Como o certificado é público e confiável, o navegador trata a origem como um site HTTPS qualquer. Nada nos documentos da Apple, do Chrome ou da Mozilla condiciona o Web Push à origem ser alcançável pela internet: o requisito é contexto seguro, service worker e permissão. **documentado** quanto aos requisitos ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)). A ausência de checagem de alcançabilidade pública é **não verificado** (inferida da falta de requisito, não testada em aparelho).
- Efeito colateral: todo certificado vai para o log público de Certificate Transparency, com o FQDN da máquina. "Do not enable the HTTPS feature if any of your machine names contain sensitive information." **documentado** ([Tailscale, Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)).
- Validade de 90 dias. Com `tailscale cert` gravando arquivos, a renovação é sua; integrações como Caddy renovam sozinhas. **documentado** ([Tailscale, Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). O `tailscale serve` provisiona o certificado automaticamente ("to automatically provision TLS certificates"). **documentado** ([Tailscale Serve](https://tailscale.com/kb/1312/serve)). Que o `serve` também renove automaticamente é **não verificado** (a página não diz).
- Os nomes `*.ts.net` são resolvidos pelo MagicDNS para quem está na tailnet ("any device signed in to your network can access other devices by using their machine name"). **documentado** ([MagicDNS](https://tailscale.com/kb/1081/magicdns)). Se o DNS público responde registro A para esses nomes, nenhuma página lida diz. **não verificado**. Mesmo que respondesse, o endereço seria `100.x.y.z` (CGNAT da tailnet), inalcançável de fora. **não verificado**.

## 2. Requisitos por plataforma

### iPhone e iPad

- iOS e iPadOS **16.4 ou posterior**. **documentado** ([WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/); [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers): "Home Screen web apps in iOS 16.4 or later").
- Só o web app **adicionado à tela de início** pode pedir permissão de push. Aba do Safari não pode. **documentado** ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- O manifest precisa de `display` igual a `standalone` ou `fullscreen`. **documentado** ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). O membro `id` do manifest é usado, junto com o nome, para identificar o app e sincronizar Focus entre aparelhos. **documentado** (mesma fonte).
- A permissão tem de ser pedida em resposta a interação direta (tocar num botão), e o `subscribe` tem de ser chamado "immediately from the gesture's event handler". **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers); [WebKit, Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)).
- Não precisa de conta no Apple Developer Program. **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- O push usa o APNs, o mesmo serviço do push nativo. As notificações aparecem na tela bloqueada, na Central de Notificações e no Apple Watch, e respeitam Focus. **documentado** ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- Desde iOS/iPadOS 18.4 existe o **Declarative Web Push**: o push traz um JSON com `"web_push": 8030`, `notification.title`, `notification.navigate` (URL aberta no clique) e opcionalmente `app_badge`. O navegador mostra a notificação sem precisar rodar o service worker; se houver service worker, ele pode alterar a notificação, e se o JS falhar a mensagem declarativa aparece como fallback. **documentado** ([WebKit, Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)).
- Regras do DMA na União Europeia sobre web apps de tela de início: fora do escopo. **não verificado**.

### Safari no macOS

- Safari 16 no macOS 13 Ventura ou posterior, para páginas (não exige instalar). **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- Mesmas regras de gesto, de VAPID e de push visível que no iOS. **documentado** (mesma fonte).

### Chrome (Android e desktop)

- `userVisibleOnly: true` é obrigatório no `subscribe`. Sem ele, o Chrome devolve erro ("Chrome currently only supports the Push API for subscriptions that will result in user-visible messages"). **documentado** ([web.dev, Subscribing a user](https://web.dev/articles/push-notifications-subscribing-a-user)).
- `applicationServerKey` (chave pública VAPID): "the simplest implementation on Chrome requires it". **documentado** (mesma fonte).
- Pedir permissão depois de um gesto é a prática recomendada. **documentado** ([web.dev, Push notifications overview](https://web.dev/articles/push-notifications-overview)). Bloqueio pelo usuário é definitivo até ele desbloquear nas configurações. **documentado** ([web.dev, Subscribing a user](https://web.dev/articles/push-notifications-subscribing-a-user)).
- No Android, o push funciona no Chrome sem instalar o PWA. **não verificado** (prática corrente; nenhuma página lida aqui afirma explicitamente).
- No desktop, o Chrome precisa estar em execução (mesmo sem janela) para receber. **não verificado**.
- O endpoint das inscrições do Chrome fica em `fcm.googleapis.com`. **documentado** só como exemplo de inscrição ([web.dev, Push notifications overview](https://web.dev/articles/push-notifications-overview)); que seja sempre esse host é **não verificado**. O servidor não escolhe o push service: "Each browser can use any push service they want". **documentado** ([web.dev, How push works](https://web.dev/articles/push-notifications-how-push-works)).

### Firefox (desktop)

- Desde o Firefox 72, `Notification.requestPermission()` e `PushManager.subscribe()` só funcionam em resposta a gesto do usuário. Sem gesto, aparece só um ícone na barra de endereço. **documentado** ([Mozilla Hacks, Firefox 72](https://hacks.mozilla.org/2019/11/upcoming-notification-permission-changes-in-firefox-72/); [MDN, notas do Firefox 72](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/72)).
- O Firefox impõe cota de pushes para quem não mostra notificação; pushes que geram notificação ficam fora da cota, e a cota renova a cada visita ao site. **documentado** ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- Push service da Mozilla: `https://updates.push.services.mozilla.com/`. **documentado** ([autopush-rs](https://mozilla-services.github.io/autopush-rs/)).

### Comum a todos

- Service worker ativo; a inscrição é feita com `registration.pushManager.subscribe()`, que devolve `endpoint` e as chaves `p256dh` e `auth`. **documentado** ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API); [web.dev](https://web.dev/articles/push-notifications-subscribing-a-user)).
- O endpoint é uma URL de capacidade: quem a tem pode mandar push. Deve ficar em segredo, e o fluxo de inscrição precisa de proteção contra CSRF. **documentado** ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- VAPID (RFC 8292): JWT ES256 sobre P-256, `aud` igual à origem do push service, `exp` no máximo 24 h no futuro, `sub` com `mailto:` ou `https:`; enviado em `Authorization: vapid t=<jwt>, k=<chave pública>`. Uma inscrição feita com `applicationServerKey` fica presa a essa chave: o push service rejeita mensagens assinadas com outra. **documentado** ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292.html)). Na Apple, chave divergente gera `VapidPkHashMismatch`. **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). Consequência: trocar o par VAPID invalida todas as inscrições.
- Criptografia do payload (RFC 8291): só `aes128gcm`, um único registro. **documentado** ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html)). O push service não lê o conteúdo; vê só tamanho, horário e cabeçalhos. A parte do conteúdo é **documentado** (é o objetivo da RFC 8291); a lista de metadados visíveis é **não verificado** em detalhe.

## 3. Push silencioso proibido e revogação

- Apple: "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site." **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). "Violations of the `userVisibleOnly` promise will result in a push subscription being revoked." **documentado** ([WebKit, Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)).
- O limite no WebKit é **3 pushes silenciosos por origem** (`maxSilentPushCount = 3`). Conta como silencioso o push cujo handler "failed to fulfill all promises or show a notification". Ao atingir a cota, a inscrição é cancelada, sem disparar `pushsubscriptionchange`. **documentado** ([WebKit bug 236863, "Enforce silent push quota"](https://bugs.webkit.org/show_bug.cgi?id=236863), 2022). Se o valor continua 3 hoje é **não verificado** (não li o código atual).
- Pushes declarativos (iOS 18.4+) ficam fora das "silent push penalties", porque sempre mostram notificação. **documentado** ([WebKit, Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)).
- Atualizar só o badge não conta como notificação visível: "a badge update by itself does not fulfill the 'user visible' requirement". **documentado** ([WebKit, Badging for Home Screen Web Apps](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)).
- Chrome: se o push não mostrar notificação antes de a promessa de `event.waitUntil()` terminar, o Chrome mostra a notificação genérica "This site has been updated in the background." **documentado** ([web.dev, Handling messages](https://web.dev/articles/push-notifications-handling-messages)). A exceção é o site estar aberto e focado. **documentado** ([web.dev, Common notification patterns](https://web.dev/articles/push-notifications-common-notification-patterns)). Que o WebKit aplique a mesma exceção é **não verificado**. Há relato de desenvolvedores (Discourse) de perda de permissão no iOS quando o usuário está com o app ativo ([meta.discourse.org](https://meta.discourse.org/t/ios-notifications-can-lose-permission-to-push-if-the-user-is-currently-active/290225)), fonte secundária.
- Consequência prática: no iOS, todo push precisa virar notificação, inclusive quando o usuário está com a conversa aberta. Push "só para sincronizar" não existe.

## 4. Expiração, rotação e `pushsubscriptionchange`

- `pushsubscriptionchange` dispara quando a inscrição foi ou vai ser invalidada. **documentado** ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)). O Chrome tem Intent to Ship para emitir o evento na reinscrição ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/_ckNx_SZIjc)); o estado atual é **não verificado**.
- WebKit: "We don't currently emit the pushsubscriptionchange event for any type of Web Push in WebKit", e "the subscriptions we create don't have an expiration date on them". **documentado** ([WebKit bug 294421](https://bugs.webkit.org/show_bug.cgi?id=294421), comentário de junho de 2025, bug ainda NEW). Se mudou depois disso é **não verificado**.
- `expirationTime` costuma vir `null`, mas "browsers commonly let subscriptions expire". Mitigação sugerida: reinscrever ao receber push; não mandar push só para evitar expiração. **documentado** ([web.dev, Subscribing a user](https://web.dev/articles/push-notifications-subscribing-a-user)).
- Há relatos de inscrições no iOS que deixam de funcionar sem aviso ([WebKit bug 273063](https://bugs.webkit.org/show_bug.cgi?id=273063); [Apple Developer Forums](https://developer.apple.com/forums/thread/786360)). Relatos, não regra: **não verificado**.
- Sinal confiável do lado do servidor: a resposta do push service. `404` ou `410` significa inscrição morta; apague-a e espere o cliente se reinscrever. **documentado** ([web.dev, Web push protocol](https://web.dev/articles/push-notifications-web-push-protocol); [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html)). A Apple documenta `410` "The device token has expired". **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- Como o iOS não avisa, o cliente precisa conferir a inscrição a cada abertura do app (`pushManager.getSubscription()`) e reenviá-la ao servidor se mudou ou sumiu. **não verificado** como prática suficiente; decorre dos dois itens anteriores.

## 5. Payload, TTL, urgência, tópico

- **Tamanho.** RFC 8291: o push service não precisa aceitar mais que 4096 octetos de corpo, o que dá no máximo **3993 octetos de texto puro**. **documentado** ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html)). RFC 8030: o push service não pode devolver 413 para corpo de até 4096 bytes. **documentado** ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html)). Apple: `PayloadTooLarge`, "over the limit of 4 KB", HTTP 413. **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **medido**: com `web-push@4.0.0` no Bun, 3938 bytes de texto viraram 4041 bytes de corpo (overhead de 103 bytes, igual à conta da RFC). Um texto de 4000 bytes gerou 4103 bytes de corpo **sem erro local**: a biblioteca não valida o limite, e quem rejeita é o push service.
- **TTL** (obrigatório na Apple; `BadTtl` se ausente ou não positivo). Com TTL 0, a mensagem só é entregue se o aparelho estiver disponível na hora. O push service pode guardar por menos tempo que o pedido e informa o TTL real na resposta. **documentado** ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html); [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). A Apple guarda por até 30 dias e limita quantas notificações ficam guardadas por aparelho offline. **documentado** (Apple). O máximo do FCM e da Mozilla é **não verificado**.
- **Urgency**: `very-low`, `low`, `normal` (padrão) ou `high`. Para tentar entrega imediata, `high`. **documentado** ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html); [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **Topic**: até 32 caracteres base64url. Uma mensagem com o mesmo tópico substitui a pendente ainda não entregue. **documentado** ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html)). Serve para "N mensagens novas no canal X" colapsar quando o aparelho está offline.
- **No aparelho**, `tag` na notificação substitui a notificação anterior de mesma tag, e `registration.getNotifications()` permite juntar mensagens. **documentado** ([web.dev, Common notification patterns](https://web.dev/articles/push-notifications-common-notification-patterns)).
- **Envio à Apple**: TLS com SNI; HTTP/1.1 ou HTTP/2; até 100 requisições sem resposta por conexão HTTP/1.1; respeitar `SETTINGS_MAX_CONCURRENT_STREAMS` no HTTP/2; "Don't refresh your JWT more frequently than once per hour"; o `sub` do JWT tem de ser URL ou `mailto:`. **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).

## 6. Badging API no iOS

- Disponível a partir do iOS/iPadOS 16.4, só para web apps na tela de início. **documentado** ([WebKit, Badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)).
- `navigator.setAppBadge(n)` e `navigator.clearAppBadge()` (ou `setAppBadge(0)`); funciona no service worker durante o `push`. **documentado** (mesma fonte; [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- O badge só aparece se o usuário concedeu permissão de notificação. O usuário pode esconder badges nas Configurações sem que o app saiba. **documentado** ([WebKit, Badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)).
- No push declarativo, o campo `app_badge` define o badge sem JS. **documentado** ([WebKit, Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)).

## 7. O celular precisa estar na tailnet?

O caminho de um push tem dois trechos, e nenhum passa pela tailnet:

```
Servidor Regents ──HTTPS (internet)──► push service ──canal próprio do SO/navegador──► aparelho
(container)                            web.push.apple.com / fcm.googleapis.com /
                                       updates.push.services.mozilla.com
```

- **Para o push chegar: não.** O servidor faz POST no `endpoint` da inscrição, que é um host público do push service; o push service entrega ao aparelho pelo canal que ele mantém. Se o aparelho está offline, a mensagem fica na fila até voltar, dentro do TTL. **documentado** quanto ao modelo ([web.dev, How push works](https://web.dev/articles/push-notifications-how-push-works): "If the browser is offline, the message is queued until the browser comes online"; [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html)). Que a entrega funcione com o Tailscale desligado no celular é **não verificado** em aparelho, mas decorre do modelo: nem o APNs nem o FCM falam com a origem do site.
- **Para mostrar a notificação: não, se o payload trouxer tudo.** Título, corpo, ícone e URL de destino precisam vir no payload criptografado (até ~3993 bytes). Se o service worker tentar buscar o conteúdo no servidor durante o `push` e o aparelho estiver fora da tailnet, o `fetch` falha. No iOS, se essa falha impedir a notificação, conta como push silencioso (seção 3). **não verificado** em aparelho; decorre de MagicDNS só resolver na tailnet e da regra de revogação.
- **Para o clique abrir a conversa: sim, para carregar dados novos.** No `notificationclick`, o service worker chama `clients.openWindow(url)` ou foca uma janela já aberta, e isso só vale para páginas da própria origem. **documentado** ([web.dev, Common notification patterns](https://web.dev/articles/push-notifications-common-notification-patterns)). No push declarativo, a URL de `navigate` é aberta pelo sistema. **documentado** ([WebKit](https://webkit.org/blog/16535/meet-declarative-web-push/)). O app abre com o que o service worker tiver em cache; o histórico e o WebSocket da conversa precisam alcançar `<host>.<tailnet>.ts.net`, o que só acontece com o Tailscale conectado. **não verificado** em aparelho.
- **O Tailscale no iPhone costuma ficar conectado.** Com o Tailscale ligado, o cliente define uma política ampla de VPN On Demand para religar a VPN depois de reinício, atualização ou crash (desde o Tailscale 1.48 no iOS). **documentado** ([Tailscale, VPN On Demand](https://tailscale.com/kb/1291/ios-vpn-on-demand)). Regras personalizadas substituem essa política, e uma regra "Never" numa interface derruba a VPN. **documentado** (mesma fonte). Que ao tocar na notificação o iOS suba a VPN a tempo de a primeira requisição dar certo é **não verificado**.
- **Durante a inscrição: sim.** O usuário instala o PWA, toca no botão e o app manda a inscrição ao servidor. Isso exige estar na tailnet. **não verificado** como passo isolado, mas é óbvio: o servidor só é alcançável por ela.

## 8. Saída do container para a internet

- O servidor precisa de HTTPS de saída para os hosts dos push services. A Apple pede liberar `https://*.push.apple.com`. **documentado** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers); [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- Mozilla: `updates.push.services.mozilla.com`. **documentado** ([autopush-rs](https://mozilla-services.github.io/autopush-rs/)). Google: `fcm.googleapis.com`, **documentado** só como exemplo (seção 2). O Edge usa o WNS (`*.notify.windows.com`): **não verificado**.
- Como o host do endpoint é escolhido pelo navegador, uma lista fixa de destinos pode quebrar quando um navegador mudar de push service. Liberar 443 de saída em geral é o caminho mais simples; a lista fixa é a alternativa mais fechada. **não verificado** (inferência).
- Se a saída tiver de passar por proxy HTTP, o `web-push` aceita a opção `proxy` (via `https-proxy-agent`) ou um `agent` próprio. **documentado** ([README do web-push](https://github.com/web-push-libs/web-push#readme)).
- A saída para os push services não passa pela tailnet. Se o container usar um exit node do Tailscale, ela passa pelo exit node. **não verificado**.

## 9. Biblioteca de envio no Bun

### `web-push` (npm)

- Projeto ativo: v4.0.0 publicada em 2026-11-10, repositório não arquivado. A v4 migrou para ESM e passou a ter **só exports nomeados** (`import * as webpush from 'web-push'` ou `import { sendNotification } from 'web-push'`); `import webpush from 'web-push'` deixa `webpush` sem os métodos. **documentado** ([release v4.0.0](https://github.com/web-push-libs/web-push/releases/tag/v4.0.0)). O sintoma dos exports foi **medido** (`webpush.generateVAPIDKeys` indefinido com import default).
- Dependências: `asn1.js`, `http_ece`, `https-proxy-agent`, `jws`. Usa `node:https` e `node:crypto` (`createECDH`). **documentado** (`package.json` e código da v4.0.0).
- **medido** no Bun 1.3.11 (macOS arm64), contra um servidor HTTPS local feito com `Bun.serve`, com chaves de cliente simuladas por `crypto.createECDH('prime256v1')`:
  - `generateVAPIDKeys()` e `sendNotification()` rodam; resposta 201.
  - Cabeçalhos enviados: `Content-Encoding: aes128gcm`, `TTL`, `Urgency`, `Topic`, `Authorization: vapid t=…, k=…`.
  - O corpo decifra com `http_ece` usando a chave do "cliente" e devolve o texto original.
  - O JWT tem `aud` igual à origem do endpoint, `sub` e `exp` a 12 h; a assinatura confere com `crypto.subtle.verify` (ECDSA P-256).
  - Não validei contra APNs, FCM ou Mozilla reais (sem inscrição de aparelho). Isso fica **não verificado**.
- A biblioteca assina um JWT novo a cada envio (`getVapidHeaders` não guarda cache). A Apple pede para não renovar o JWT mais de uma vez por hora. **documentado** (código da v4.0.0 e [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). O efeito prático disso é **não verificado**: o `web-push` é muito usado com a Apple e a doc não fala em penalidade.
- `sub` do VAPID: a Apple rejeita sujeitos com `localhost` (`mailto:user@localhost`, `https://localhost`) com `403 BadJwtToken`; o README pede um contato real e válido externamente. **documentado** ([README](https://github.com/web-push-libs/web-push#readme); [PR #988](https://github.com/web-push-libs/web-push/pull/988)). Se a Apple aceita `https://<host>.<tailnet>.ts.net` como `sub` é **não verificado**; um `mailto:` com domínio real evita a dúvida.
- Issues do Bun: a busca por "web-push" no repositório do Bun achou só a [#46358](https://github.com/oven-sh/bun/issues/46358), fechada, que era o erro de import (tipos e import default), sem bug de runtime. No repositório do `web-push`, nenhuma issue menciona Bun. **documentado** (buscas no GitHub em 2026-11-23).

### Alternativas com Web Crypto

- **medido**: o Web Crypto do Bun 1.3.11 faz tudo o que a RFC 8291/8292 pede: ECDH P-256 (`deriveBits`, chave pública raw de 65 bytes), HKDF-SHA-256, AES-128-GCM e ECDSA P-256 com assinatura raw de 64 bytes (o formato que o JWT ES256 usa).
- Pacotes que dizem rodar no Bun com Web Crypto (descrição no npm, sem teste meu): `@block65/webcrypto-web-push` 2.0.0 (atualizado em 2026-09), `@pushforge/builder` 2.0.5 (2026-04), `web-push-browser` 1.4.2 (2025-08), `webpush-webcrypto` 1.0.5 (2025-04). **documentado** só como autodescrição no npm; funcionamento **não verificado**.
- Implementar à mão é viável (cerca de 150 linhas: ECDH, HKDF, cabeçalho `aes128gcm` de 86 bytes, JWT ES256) e dá controle sobre o cache do JWT. **não verificado** como estimativa.

---

## Tabela: plataforma × requisitos e limites

| | iPhone/iPad (PWA na tela de início) | Safari macOS | Chrome Android | Chrome desktop | Firefox desktop |
|---|---|---|---|---|---|
| Versão mínima | iOS/iPadOS 16.4 (doc.) | Safari 16, macOS 13 (doc.) | não verificado | não verificado | não verificado (gesto obrigatório desde o 72) |
| Precisa instalar | Sim, tela de início (doc.) | Não (doc.) | Não (não verif.) | Não (não verif.) | Não (não verif.) |
| Manifest | `display: standalone` ou `fullscreen`; `id` recomendado (doc.) | Não exigido (não verif.) | Não exigido para push (não verif.) | Não exigido (não verif.) | Não exigido (não verif.) |
| Gesto para permissão | Obrigatório; `subscribe` direto no handler (doc.) | Obrigatório (doc.) | Recomendado (doc.) | Recomendado (doc.) | Obrigatório desde o 72 (doc.) |
| `userVisibleOnly: true` | Obrigatório (doc.) | Obrigatório (doc.) | Obrigatório (doc.) | Obrigatório (doc.) | Opcional; com cota para pushes sem notificação (doc.) |
| Push sem notificação | Revoga após 3 por origem (doc., bug de 2022) | Revoga (doc.) | Notificação genérica do Chrome (doc.) | Idem (doc.) | Consome cota (doc.) |
| Push service | APNs, `*.push.apple.com` (doc.) | APNs (doc.) | FCM, `fcm.googleapis.com` (exemplo doc.) | FCM (exemplo doc.) | `updates.push.services.mozilla.com` (doc.) |
| Payload máximo | 4 KB de corpo; ~3993 B de texto (doc.) | Idem (doc.) | 4096 B mínimo garantido (doc.) | Idem | Idem |
| TTL | Obrigatório; até 30 dias (doc.) | Idem (doc.) | Máximo não verificado | Idem | Idem |
| `pushsubscriptionchange` | Não emitido; inscrições sem expiração (doc., 2025) | Idem (doc.) | Sim, estado atual não verificado | Idem | Não verificado |
| Badge | `setAppBadge`, exige permissão de notificação (doc.) | não verificado | não verificado | não verificado | não verificado |
| Push sem JS | Declarative Web Push, iOS 18.4+ (doc.) | macOS 15.5+ (doc., beta à época) | Não | Não | Não |
| Tailnet para receber | Não (modelo doc.; aparelho não verif.) | Não (idem) | Não (idem) | Não (idem) | Não (idem) |
| Tailnet para abrir a conversa | Sim, para dados novos (não verif.) | Sim (não verif.) | Sim (não verif.) | Sim (não verif.) | Sim (não verif.) |

## Implicações para o desenho

Pontos que o desenho precisa considerar. Nada aqui está decidido.

- **A notificação tem de se bastar.** Fora da tailnet, o service worker não alcança o servidor, e no iOS um push que não vira notificação queima uma das 3 chances. Ficam em aberto: o que vai no payload (nome do Canal, autor, trecho da mensagem) e quanto texto de conversa aceitamos que passe, cifrado, pela Apple, pelo Google e pela Mozilla.
- **Todo push vira notificação.** Não há canal para sincronização silenciosa. Fica em aberto como tratar "não notificar quem está com a conversa aberta": suprimir no servidor (sabendo da presença) ou mostrar e fechar no cliente.
- **Push declarativo ou service worker.** O declarativo (iOS 18.4+) acaba com o risco de revogação e dá `navigate` e `app_badge` sem JS, mas é só da Apple. Fica em aberto se vale manter dois formatos de payload.
- **A inscrição morre em silêncio no iOS.** Sem `pushsubscriptionchange` nem `expirationTime`, os sinais são `404`/`410` no envio e a conferência a cada abertura do app. Encaixa no ADR 0003 (nada no limbo): o desenho precisa decidir como o Membro vê que o push dele parou.
- **O par VAPID é estado de longo prazo da instalação.** Perder ou trocar a chave invalida todas as inscrições. Fica em aberto onde ele vive e como entra no backup.
- **O container precisa de saída para a internet.** Liberar 443 em geral ou manter lista de hosts (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, talvez WNS). Fica em aberto como isso conversa com a postura "só dentro da tailnet".
- **Instalar no iPhone é um passo de onboarding.** Sem "Adicionar à Tela de Início" não há push no iOS, e o pedido de permissão precisa de um botão. A inscrição também exige estar na tailnet.
- **O clique depende do Tailscale.** O PWA precisa abrir de forma útil (cache do shell, estado "sem conexão com o Workspace" visível) quando a VPN ainda não subiu.
- **O nome da máquina fica público.** O certificado põe `<host>.<tailnet>.ts.net` no log de Certificate Transparency.
- **Biblioteca.** `web-push` v4 roda no Bun (medido localmente, sem push service real). Pontos a considerar: só exports nomeados, JWT novo a cada envio e nenhuma checagem do limite de 4 KB. Alternativas com Web Crypto existem mas não foram testadas.

## A medir antes de virar premissa

1. Um iPhone real (iOS atual) recebendo push com o Tailscale desligado, e o clique abrindo o app com o Tailscale religando.
2. Envio real a APNs, FCM e Mozilla a partir de Bun dentro do container, com `web-push` v4.
3. A Apple aceitando `sub` `https://<host>.<tailnet>.ts.net` ou só `mailto:` com domínio real.
4. O comportamento do iOS com o app aberto e focado: o push precisa mesmo mostrar notificação?
5. Se o DNS público resolve `<host>.<tailnet>.ts.net` (testar de uma rede fora da tailnet).
