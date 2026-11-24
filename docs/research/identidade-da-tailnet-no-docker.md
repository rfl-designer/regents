# Identidade da tailnet no Docker

Pesquisa do ticket #3 (parte do mapa #1). Pergunta: com o Shearim num container atrás de um sidecar `tailscale/tailscale` (o app em `network_mode: service:tailscale`, publicado com Tailscale Serve em HTTPS), dá para confiar nos headers de identidade que o Serve entrega? Em que condições eles faltam, e o que o app precisa fazer para que ninguém consiga forjá-los?

Data: 2026-11-23. Código lido: `tailscale/tailscale` na tag **v1.106.0** (commit `9ff10465`, último estável na data). O `tailscale` local na máquina é 1.104.7 (só rodei `tailscale version`). Todos os links de código apontam para a tag v1.106.0.

Legenda: **documentado** (doc oficial ou linha de código, com link), **medido** (rodei e vi) ou **não verificado** (inferência ou fonte fraca). Nada aqui foi **medido**: não subi tailnet nem container.

---

## 1. O Serve entrega os headers a cada requisição?

Entrega, desde que a requisição venha de um nó da tailnet que pertence a um usuário. A cada requisição proxied, o Serve primeiro apaga os headers e depois os preenche de novo a partir do endereço de origem da conexão.

- **documentado**: o reverse proxy do Serve chama `addProxyForwardedHeaders` e `addTailscaleIdentityHeaders` no `Rewrite` de toda requisição ([serve.go#L1010-L1011](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1010-L1011)).
- **documentado**: `addTailscaleIdentityHeaders` ([serve.go#L1159-L1190](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1159-L1190)) faz, na ordem:
  1. apaga `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-Funnel-Request` e `Tailscale-Headers-Info` vindos do cliente;
  2. se a conexão é de Funnel, seta só `Tailscale-Funnel-Request: ?1` e para;
  3. chama `WhoIs("tcp", SrcAddr)`; se não achar o nó, para sem headers;
  4. se o nó tem tag, para sem headers;
  5. seta `Tailscale-User-Login` (LoginName), `Tailscale-User-Name` (DisplayName), `Tailscale-User-Profile-Pic` (URL) e `Tailscale-Headers-Info: https://tailscale.com/s/serve-headers`.
- **documentado**: `Login` e `Name` vão com codificação RFC 2047 "Q" quando têm caractere não ASCII (ex.: `=?utf-8?q?Ferris_B=C3=BCller?=`). Se o valor não é UTF-8 válido, vai vazio. ([serve.go#L1219-L1224](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1219-L1224), [KB Serve › Identity headers](https://tailscale.com/kb/1312/serve)). `Profile-Pic` vai sem codificação e só existe se o provedor de identidade fornecer uma foto.
- **documentado**: o Serve também seta `X-Forwarded-Host`, `X-Forwarded-Proto: https` (em TLS) e `X-Forwarded-For` com o IP tailnet de origem ([serve.go#L1149-L1157](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1149-L1157)). O `httputil.ReverseProxy` do Go apaga `Forwarded`/`X-Forwarded-*` do cliente antes do `Rewrite` ([reverseproxy.go go1.25.0, L429-L437](https://github.com/golang/go/blob/go1.25.0/src/net/http/httputil/reverseproxy.go#L429-L437)), então o `X-Forwarded-For` que chega pelo Serve também é o do Serve.
- **documentado**: `Tailscale-App-Capabilities` (v1.92+) só aparece quando o handler do serve config tem `AcceptAppCaps` e o peer recebeu alguma dessas capabilities por grant. Diferente dos headers de usuário, **vem também para nós com tag** e nunca vem em Funnel ([serve.go#L1226-L1256](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1226-L1256), [KB Serve › App capabilities header](https://tailscale.com/kb/1312/serve)). O bulletin [TS-2026-017](https://tailscale.com/security-bulletins) corrigiu na 1.104.4 um vazamento desse header entre mounts em HTTP/2.

O que o header **não** traz:

- **documentado**: o ID estável do usuário. O `UserProfile.LoginName` é comentado no código como "for display purposes only (provider is not listed)" ([tailcfg.go#L322-L334](https://github.com/tailscale/tailscale/blob/v1.106.0/tailcfg/tailcfg.go#L322-L334)). O `UserProfile.ID`, que é estável, só sai pelo `whois` (seção 7).
- **não verificado**: se o login muda quando a pessoa troca de e-mail no provedor, ou se dois provedores podem produzir o mesmo login. O comentário do código sugere que o login não deve ser tratado como chave.

## 2. Quando os headers faltam

| Origem da requisição | Headers de usuário | Fonte |
|---|---|---|
| Nó de um usuário da própria tailnet | presentes | **documentado**, [serve.go#L1186-L1189](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1186-L1189) |
| Funnel (internet pública) | ausentes; vem `Tailscale-Funnel-Request: ?1` | **documentado**, [serve.go#L1173-L1176](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1173-L1176), [KB Serve](https://tailscale.com/kb/1312/serve) |
| Nó com tag (servidor, CI, outro container com auth key de tag) | ausentes | **documentado**, [serve.go#L1181-L1185](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1181-L1185), [KB Serve](https://tailscale.com/kb/1312/serve) |
| Usuário de outra tailnet que aceitou um share do nó do Shearim | **presentes**, com a identidade desse usuário externo | **documentado**, [KB Serve](https://tailscale.com/kb/1312/serve): "this includes traffic from external users who have accepted a share of your device" |
| Origem que não está no netmap (tráfego local que não veio da tailnet) | ausentes | **documentado**, comentário "traffic from outside of Tailnet (funneled or local machine)" em [serve.go#L1177-L1180](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1177-L1180) |
| O próprio nó do sidecar (algo dentro do namespace chamando o IP tailnet dele mesmo) | presentes se o nó for de um usuário (identidade do dono); ausentes se o nó tiver tag | **documentado**: o `SelfNode` entra no índice `nodeByAddr` ([node_backend.go#L749-L771](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/node_backend.go#L749-L771)) e o resultado cai na regra de tag |

Sobre "apps em conexões de outros usuários": a identidade é a do **dono do nó de origem**, não a de quem está usando o aparelho naquele momento. `WhoIs` resolve IP → nó → `n.User()` ([local.go#L1797-L1857](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/local.go#L1797-L1857)). Consequências:

- **documentado** (pelo mesmo código): um computador da família logado na conta de uma pessoa aparece como essa pessoa para todo mundo que o usar.
- **não verificado**: tráfego que chega via subnet router com SNAT (o padrão) carrega o IP tailnet do router, então a identidade seria a do dono do router, ou nenhuma se o router tiver tag.
- **documentado**: agentes de IA ou automações rodando em nós com tag chegam **sem** headers de usuário. Só `Tailscale-App-Capabilities` (se houver grant) ou o `whois` (que devolve as tags do nó) os identificam.

## 3. Como impedir que alguém forje os headers

### 3.1 O que o Serve já faz

- **documentado**: o Serve apaga os cinco headers de identidade vindos do cliente antes de setar os dele, inclusive as variantes com `_` no lugar de `-` e com caixa diferente, para que um backend no estilo CGI não leia `Tailscale_User_Login` como `HTTP_TAILSCALE_USER_LOGIN` ([serve.go#L1192-L1213](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1192-L1213)). `Tailscale-App-Capabilities` é apagado do mesmo jeito em [serve.go#L1228](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1228).
- **documentado**: a recomendação oficial é que o backend escute só em localhost, porque "any user that can call your service directly (rather than with the Serve URL) could trivially provide their own values for these HTTP headers" ([KB Serve](https://tailscale.com/kb/1312/serve)).

O resto do trabalho é garantir que o **único** caminho até o app passe pelo Serve.

### 3.2 Onde o app escuta: depende do modo do sidecar

Isto pesa mais que o resto do documento. **Em modo userspace (o padrão da imagem), escutar em 127.0.0.1 não basta.**

- **documentado**: `TS_USERSPACE` é `true` por padrão no containerboot ([settings.go#L111](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/settings.go#L111), [KB Docker params](https://tailscale.com/docs/features/containers/docker/docker-params)), e aí o tailscaled roda com `--tun=userspace-networking` ([tailscaled.go#L84-L85](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/tailscaled.go#L84-L85)).
- **documentado**: em userspace, o netstack fica com `ProcessLocalIPs = true` ([cmd/tailscaled/netstack.go#L42](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/tailscaled/netstack.go#L42)) e processa todo pacote TCP destinado ao IP tailnet do nó ([netstack.go#L1369-L1371](https://github.com/tailscale/tailscale/blob/v1.106.0/wgengine/netstack/netstack.go#L1369-L1371)). Para porta que o Serve não intercepta, ele **reescreve o destino para `127.0.0.1:<porta>` e encaminha a conexão** (`case isTailscaleIP: dialIP = ipv4Loopback`, [netstack.go#L1816-L1817](https://github.com/tailscale/tailscale/blob/v1.106.0/wgengine/netstack/netstack.go#L1816-L1817)).
- **Consequência** (inferência direta do código acima, **não medido**): no modo userspace, um peer que a ACL deixe chegar em `100.x.y.z:3000` cai direto no app que escuta em `127.0.0.1:3000`, sem passar pelo Serve, e pode mandar `Tailscale-User-Login` com o valor que quiser. O mesmo vale para `TS_LOCAL_ADDR_PORT` (padrão `[::]:9002`) se health/metrics estiverem ligados.
- **documentado**: em modo kernel (`TS_USERSPACE=false`, com `/dev/net/tun` e `cap_add: net_admin`), só as portas do Serve, a peerAPI e afins são interceptadas pelo netstack ([netstack.go#L1303-L1323](https://github.com/tailscale/tailscale/blob/v1.106.0/wgengine/netstack/netstack.go#L1303-L1323)). O resto vai para a interface `tailscale0` do kernel.
- **não verificado** (é o comportamento padrão do Linux): um socket ligado em `127.0.0.1` não aceita pacote destinado a `100.x.y.z` nem ao IP da `eth0` do container. Em modo kernel, então, escutar em 127.0.0.1 fecha o caminho direto. Escutar em `0.0.0.0` deixa o app aberto pela `tailscale0` e pela rede Docker.
- **documentado**: o padrão do `Bun.serve` é `hostname: "0.0.0.0"` ([docs do Bun, HTTP server](https://bun.com/docs/runtime/http/server)). O app precisa passar `hostname: "127.0.0.1"` explicitamente.

Três formas de fechar o desvio, sem decidir aqui qual usar:

1. **Modo kernel + app em 127.0.0.1.** Caminho direto fechado pelo kernel. Custa `/dev/net/tun` e `cap_add: [net_admin]` (a doc usa também `net_raw`, [KB connect-docker-container](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container)).
2. **Userspace + app num Unix socket.** O Serve aceita `Proxy: "unix:/caminho.sock"` ([ipn/serve.go#L147-L148](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/serve.go#L147-L148), [serve.go#L896-L917](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L896-L917)), e o Bun escuta em Unix socket com a opção `unix` (**documentado**, docs do Bun). Sem porta TCP, o netstack não tem para onde encaminhar. Custa um volume compartilhado entre os dois containers. **Ressalvas**: o Bun não documenta se `server.upgrade()` (WebSocket) funciona em Unix socket (**não verificado**); `server.requestIP()` devolve `null` em Unix socket (**documentado**); e desde a 1.98.9 alvos Unix do Serve são restritos a root ([TS-2026-005](https://tailscale.com/security-bulletins)), o que no container não deve atrapalhar porque o tailscaled roda como root (**não verificado**).
3. **Userspace + app em 127.0.0.1 + ACL/grant limitando o nó a `tcp:443`.** O desvio continua existindo, e quem o fecha é a política da tailnet. Basta um grant `*` ou uma mudança na ACL para reabrir. Sintaxe de exemplo (**não verificado**): `{"src": ["autogroup:member"], "dst": ["tag:shearim"], "ip": ["tcp:443"]}`.

### 3.3 Portas no compose

- **não verificado**: o serviço do app, em `network_mode: service:tailscale`, não pode ter `ports:` (o Docker recusa publicar portas num container que usa a rede de outro). Qualquer `ports:` iria no serviço `tailscale`.
- Recomendação derivada (**não verificado**): não publicar nenhuma porta no serviço `tailscale` nem no Postgres. O acesso de pessoas é só pela URL `https://<nome>.<tailnet>.ts.net`. Uma publicação `"3000:3000"` com o app em `0.0.0.0` expõe o app sem Serve na LAN do host.
- **documentado**: `TS_LOCAL_ADDR_PORT` escuta em `[::]:9002` por padrão, mas só quando `TS_ENABLE_HEALTH_CHECK` ou `TS_ENABLE_METRICS` estão ligados ([main.go#L71-L78](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/main.go#L71-L78)). Se ligar, prefira `127.0.0.1:9002`.
- **documentado**: o `/healthz` não tem autenticação ([KB Docker params](https://tailscale.com/docs/features/containers/docker/docker-params)).

### 3.4 Nó com tag e auto-identidade

- **documentado**: se o nó do sidecar for de um usuário, uma requisição feita de dentro do namespace para o próprio Serve chega com a identidade do dono (seção 2). Com uma auth key de tag (ex.: `tag:shearim`), o nó tem tag e essa auto-requisição chega sem headers. Para auth keys OAuth, a tag é obrigatória ([KB Docker params](https://tailscale.com/docs/features/containers/docker/docker-params)).

## 4. WebSocket pelo Serve

- **documentado**: o Serve usa `httputil.ReverseProxy`. Antes do `Rewrite`, o Go recoloca `Connection: Upgrade` e `Upgrade: <tipo>` quando o cliente pediu upgrade ([reverseproxy.go go1.25.0, L407-L428](https://github.com/golang/go/blob/go1.25.0/src/net/http/httputil/reverseproxy.go#L407-L428)) e trata a resposta `101` ([L504](https://github.com/golang/go/blob/go1.25.0/src/net/http/httputil/reverseproxy.go#L504)). O `Rewrite` do Serve, que seta os headers de identidade, roda na mesma requisição de upgrade. O handshake do WebSocket chega, portanto, com os mesmos headers, já limpos e reescritos.
- Os headers existem **só no handshake** (**não verificado**, mas é como HTTP Upgrade funciona): depois do `101` o túnel é TCP opaco, então o app precisa amarrar a identidade à conexão no momento do upgrade.
- **documentado**: o Serve anuncia `h2` e `http/1.1` no ALPN ([cert.go#L161-L167](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/cert.go#L161-L167)). A issue aberta [#20882](https://github.com/tailscale/tailscale/issues/20882) relata WebSocket falhando quando o cliente negocia HTTP/2. Um mantenedor respondeu que é artefato do teste com curl: o servidor HTTP/2 do Go não anuncia `SETTINGS_ENABLE_CONNECT_PROTOCOL` (RFC 8441), então os navegadores abrem uma conexão HTTP/1.1 separada para o WebSocket. Status: aberta, sem fix.
- **documentado** (issue): a [#18827](https://github.com/tailscale/tailscale/issues/18827), aberta, relata WebSocket caindo a cada 10–40 s com código 1001 através do Serve. O próprio autor depois atribuiu a causa ao ambiente (WSL2) e não confirmou regressão. Vale ter reconexão no cliente de qualquer forma.
- **documentado**: `Bun.serve` só faz `server.upgrade()` em HTTP/1.1 (docs do Bun), compatível com o que o Serve entrega ao backend.

## 5. Serve declarativo no sidecar

- **documentado** ([main.go#L14-L67](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/main.go#L14-L67), [settings.go#L96-L133](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/settings.go#L96-L133)):
  - `TS_AUTHKEY` (ou `TS_AUTH_KEY`): aceita `file:/caminho` para ler a chave de um arquivo/secret. É mutuamente exclusivo com `TS_CLIENT_ID`/`TS_CLIENT_SECRET`/`TS_ID_TOKEN`. Um secret OAuth gera nó efêmero por padrão; `?ephemeral=false` muda isso ([KB Docker params](https://tailscale.com/docs/features/containers/docker/docker-params)).
  - `TS_STATE_DIR`: precisa persistir, senão cada restart vira um nó novo. Sem ele, o estado fica em memória (`--state=mem:`, [tailscaled.go#L70-L82](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/tailscaled.go#L70-L82)).
  - `TS_AUTH_ONCE`: padrão `false`, que força login a cada start. Com `true`, só faz login se ainda não estiver autenticado.
  - `TS_SERVE_CONFIG`: caminho de um JSON `ipn.ServeConfig`. É aplicado quando o tailscaled sobe e **reaplicado quando o arquivo muda** (fsnotify no diretório, ou polling de 5 s se o fsnotify falhar, [containerboot/serve.go#L36-L58](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/serve.go#L36-L58)). `${TS_CERT_DOMAIN}` é substituído pelo FQDN do nó ([serve.go#L181-L206](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/serve.go#L181-L206)). Monte o **diretório**, não o arquivo, para que as mudanças sejam detectadas (KB Docker params).
  - Se o HTTPS da tailnet não estiver habilitado, o containerboot loga um aviso e **não aplica** um serve config com HTTPS ([serve.go#L150-L167](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/serve.go#L150-L167)). Habilitar MagicDNS + HTTPS no admin é pré-requisito.
  - `TS_SOCKET`: o código do containerboot usa `/tmp/tailscaled.sock` como padrão ([settings.go#L125](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/settings.go#L125)), mas a KB diz `/var/run/tailscale/tailscaled.sock`. Defina explicitamente se o app for usar o socket.
  - `TS_USERSPACE`: padrão `true`. Com `false` exige `/dev/net/tun` (o containerboot falha se não existir, [tailscaled.go#L86-L87](https://github.com/tailscale/tailscale/blob/v1.106.0/cmd/containerboot/tailscaled.go#L86-L87)) e capabilities.
- **documentado**: formato do JSON = struct `ipn.ServeConfig`: `TCP` (porta → `{HTTPS: true}`), `Web` (`"host:porta"` → `Handlers` por mount point → `Proxy`/`Path`/`Text`/`Redirect`/`AcceptAppCaps`) e `AllowFunnel` ([ipn/serve.go#L53-L186](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/serve.go#L53-L186)). Sem `AllowFunnel`, nada vai para a internet pública.

### A identidade funciona em modo userspace?

- **documentado**: funciona. Nos dois modos, as conexões para as portas do Serve são interceptadas pelo netstack (`ShouldInterceptTCPPort`, [netstack.go#L1320-L1322](https://github.com/tailscale/tailscale/blob/v1.106.0/wgengine/netstack/netstack.go#L1320-L1322)) e entregues ao handler do Serve com o `SrcAddr` real do peer tailnet. É esse endereço que vai para `WhoIs`. O `localListener` em kernel só existe para conexões da própria máquina, e o código diz explicitamente "This is not used in userspace-networking mode" ([serve.go#L117-L126](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L117-L126)).
- O risco do userspace não está na identidade, e sim no desvio da seção 3.2.

## 6. Referência mínima

Não é decisão: é o mínimo para testar. A versão abaixo usa modo kernel + app em 127.0.0.1 (opção 1 da seção 3.2).

`compose.yaml`:

```yaml
services:
  tailscale:
    image: tailscale/tailscale:v1.106.0      # fixar versão
    hostname: shearim                        # vira shearim.<tailnet>.ts.net
    environment:
      TS_AUTHKEY: file:/run/secrets/ts_authkey   # auth key com tag:shearim
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
      TS_USERSPACE: "false"
      TS_AUTH_ONCE: "true"
      TS_SOCKET: /var/run/tailscale/tailscaled.sock
    volumes:
      - ts-state:/var/lib/tailscale
      - ./tailscale:/config:ro               # diretório, não o arquivo
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add: [net_admin, net_raw]
    secrets: [ts_authkey]
    # sem "ports:"
    networks: [interna]
    restart: unless-stopped

  app:
    build: .
    network_mode: service:tailscale          # mesmo namespace de rede do sidecar
    environment:
      HOST: 127.0.0.1                        # Bun.serve({ hostname: "127.0.0.1" })
      PORT: "3000"
      DATABASE_URL: postgres://shearim@postgres:5432/shearim
    depends_on: [tailscale, postgres]
    restart: unless-stopped

  postgres:
    image: postgres:17
    volumes: [pg-data:/var/lib/postgresql/data]
    networks: [interna]
    # sem "ports:"

networks:
  interna: {}
volumes:
  ts-state: {}
  pg-data: {}
secrets:
  ts_authkey:
    file: ./secrets/ts_authkey
```

`tailscale/serve.json`:

```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } }
    }
  }
}
```

Variante userspace + Unix socket (opção 2): tirar `TS_USERSPACE`, `devices` e `cap_add`; montar um volume `sock:/sock` nos dois serviços; o app escuta com `Bun.serve({ unix: "/sock/shearim.sock" })`; o handler vira `{ "Proxy": "unix:/sock/shearim.sock" }`. Falta verificar se WebSocket funciona nesse caminho.

**Não verificado**: o compose e o JSON acima não foram executados. Os campos batem com o código lido.

## 7. Alternativa: LocalAPI `whois`

O app chama o tailscaled pelo socket (`GET /localapi/v0/whois?addr=<ip:porta>`, [client/local/local.go#L353-L362](https://github.com/tailscale/tailscale/blob/v1.106.0/client/local/local.go#L353-L362)) e recebe `Node`, `UserProfile` (com `ID`, `LoginName`, `DisplayName`, `ProfilePicURL`, `Groups`) e `CapMap` ([apitype.go#L35-L42](https://github.com/tailscale/tailscale/blob/v1.106.0/client/tailscale/apitype/apitype.go#L35-L42)).

Requisitos e riscos:

- **documentado**: o socket é um arquivo. Compartilhar o namespace de rede não basta: o socket precisa ficar num volume comum aos dois containers, com `TS_SOCKET` apontando para lá.
- **documentado**: `whois` exige só `PermitRead`. Em Unix socket, todo cliente recebe leitura, e escrita vai para root (uid 0), para o mesmo uid do daemon, para o operator ou para admin local ([ipnserver/server.go#L336-L355](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnserver/server.go#L336-L355), [ipnauth.go#L166-L206](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnauth/ipnauth.go#L166-L206)). **Se o app rodar como root, ele ganha escrita total na LocalAPI** e pode trocar o serve config, deslogar o nó, etc. Rodar o app com uid não root limita o acesso a leitura.
- **documentado**: o Serve recusa usar o próprio socket do tailscaled como backend ([serve.go#L1037-L1059](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L1037-L1059), [TS-2026-016](https://tailscale.com/security-bulletins)).

O ponto central: **atrás do Serve, o `whois` não dá mais segurança que os headers.** O app vê a conexão vinda de `127.0.0.1` (é o Serve que disca), então só consegue consultar o `whois` com o IP do `X-Forwarded-For`. Esse header tem a mesma fronteira de confiança dos headers de identidade: limpo pelo Serve, forjável se houver desvio. O que o `whois` acrescenta:

- `UserProfile.ID` estável, em vez de um login "for display purposes only" (**documentado**, seção 1);
- tags e nome do nó (`Node`), o que permite identificar agentes e automações em nós com tag, que chegam sem headers;
- `CapMap` completo, sem precisar listar `AcceptAppCaps` no serve config;
- `Groups` do usuário, quando o control server envia (**documentado**, comentário em `tailcfg.UserProfile`).

O `whois` passa a ser a fonte primária quando o app **recebe a conexão tailnet direto**, sem Serve como proxy HTTP. Exemplos: o app embute o tailnet via `tsnet` (fora de Bun), ou usa `TCPForward` com `ProxyProtocol` para receber o IP de origem. Há ainda um detalhe de código: em userspace, conexões encaminhadas pelo netstack para `127.0.0.1` são registradas no `ProxyMapper` ([netstack.go#L1871-L1879](https://github.com/tailscale/tailscale/blob/v1.106.0/wgengine/netstack/netstack.go#L1871-L1879)), e o `whois` do `ip:porta` local resolve para o peer ([local.go#L1818-L1840](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/local.go#L1818-L1840)). As conexões do Serve **não** são registradas (TODO em [serve.go#L734-L735](https://github.com/tailscale/tailscale/blob/v1.106.0/ipn/ipnlocal/serve.go#L734-L735)).

Custos: uma chamada ao socket por requisição ou por conexão WebSocket (dá para cachear por IP, com o risco de o IP mudar de dono); acoplamento à LocalAPI; volume extra.

## 8. Implicações para o desenho

Pontos que o desenho precisa endereçar. Nenhum está decidido aqui.

- **Modo do sidecar e endereço de escuta andam juntos.** Em userspace (padrão), `127.0.0.1` não fecha o desvio do Serve. As saídas são modo kernel, Unix socket ou ACL restrita a 443. A escolha também define se `ports:`/health no sidecar são perigosos.
- **`Bun.serve` escuta em `0.0.0.0` por padrão.** O endereço precisa ser configurado explicitamente e, de preferência, verificado na subida do app.
- **Chave do Membro.** Os headers dão só o login (para exibição). Para amarrar um Membro a uma pessoa de forma estável, o `whois` dá o `UserProfile.ID`. A escolha afeta o schema (coluna de identidade externa).
- **Requisições sem identidade.** Nós com tag (agentes, automações) e Funnel chegam sem headers. É preciso decidir o que acontece com elas: recusar, tratar como serviço via tag/`whois`, ou exigir grant com `AcceptAppCaps`. Uma recusa precisa ser visível, não silenciosa.
- **Shares entre tailnets** trazem usuários externos com headers válidos. Se o Workspace for "quem está na tailnet", isso abre a porta para quem recebeu um share. Pode ser desejado (família) ou não.
- **Aparelho compartilhado = identidade do dono do aparelho.** Isso pesa no uso familiar.
- **WebSocket:** a identidade vale no handshake e precisa ser fixada na conexão. Há relatos abertos de quedas, então reconexão e Andamento visível no cliente fazem sentido.
- **Nó do sidecar com tag** evita que requisições internas herdem a identidade do dono.
- **App não root** se ele montar o socket do tailscaled.
- **Fixar a versão da imagem** ≥ 1.104.4 (bulletins TS-2026-016/017).
