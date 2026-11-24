# Shearim

Chat de time em que pessoas e Agentes de IA conversam nos mesmos lugares. O vocabulário está em [`GLOSSARY.md`](GLOSSARY.md) e as decisões em [`docs/adr/`](docs/adr/).

## Como rodar

Precisa só do [Bun](https://bun.sh) **1.3.11**.

```sh
bun install            # dependências de todos os workspaces
bun run dev            # servidor em 127.0.0.1:3000 + Vite em http://localhost:5173
bun test               # testes do servidor (PGlite em memória, sem Docker)
bun run typecheck      # tsc em todos os workspaces
bun run lint           # Biome (formatação + lint); `bunx biome check --write .` corrige
bun run build          # build do PWA em apps/web/dist
bun run e2e            # build + e2e no navegador (ver "e2e" abaixo)
bun run start          # servidor servindo o build (precisa de SHEARIM_IDENTITY, ver abaixo)
deploy/setup.sh        # Instalação: segredos, .env e conferência da tailnet (ver "Instalação")
(cd apps/server && bunx drizzle-kit generate --name <nome>)   # nova migração a partir do schema.ts
```

### Desenvolvimento

- `bun run dev` usa um PGlite em disco em `.data/pglite` (apague a pasta para começar de uma Instalação vazia) e a **identidade de desenvolvimento**: sem cookie, você é a "Pessoa Dev"; abra `http://localhost:5173/dev/como/<id>?nome=Fulana` para ser outra pessoa naquela aba. Essa rota só existe com `SHEARIM_IDENTITY=dev`.
- Com `DATABASE_URL` definida, o servidor fala com o Postgres em vez do PGlite.
- O servidor sempre aplica as migrações ao subir (`serve`); `bun apps/server/src/main.ts migrate` aplica e sai.

### Variáveis do servidor

| Variável | Padrão | Para quê |
|---|---|---|
| `SHEARIM_IDENTITY` | (obrigatória) | `tailnet` (o `whois` da LocalAPI; é o da imagem) ou `dev` (cookie). |
| `TS_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Socket do tailscaled, com `SHEARIM_IDENTITY=tailnet`. |
| `DATABASE_URL` | (vazia) | Postgres. Vazia: PGlite em `SHEARIM_PGLITE_DIR`. |
| `DATABASE_PASSWORD_FILE` | (vazia) | Arquivo com a senha do Postgres, à parte da URL (o segredo do compose). |
| `SHEARIM_PGLITE_DIR` | `.data/pglite` | Pasta do PGlite de desenvolvimento. `memory://`: em memória, some ao parar (o e2e usa). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Onde escutar (`bun run dev` usa `127.0.0.1`). |
| `SHEARIM_WEB_DIST` | `apps/web/dist` | Build do PWA servido em `/`. |

## Layout

```
apps/server/        Bun + Hono + Drizzle
  src/app.ts        createApp(deps) -> { app, websocket, events }: o seam dos testes
  src/events.ts     WebSocket de eventos: EventHub.publish(audiência, evento)
  src/main.ts       entrypoint: serve | migrate
  src/db/           schema.ts (Drizzle), client.ts, connect.ts (Postgres ou PGlite)
  src/identity/     porta de identidade: whois.ts (tailnet) e dev.ts
  migrations/       SQL gerado pelo drizzle-kit (commitado)
  test/harness.ts   arnês: testApp(), testDb(), fakeClock(), fakeIdentity
  test/fake-localapi.ts  LocalAPI falsa do tailscaled num Unix socket (contrato do whois)
apps/web/           PWA em React + Vite, pt-BR
packages/contracts/ DTOs do HTTP e eventos do WebSocket (ServerEvent), compartilhados
e2e/                e2e.config.ts + tests/*.e2e.ts (@e2e-dev/web)
compose.yaml        a Instalação: sidecar do Tailscale, app, Postgres (backup no #38)
Dockerfile          imagem do app (oven/bun:1.3.11, sem root)
deploy/             setup.sh e tailscale/serve.json
```

## Testes

Os testes falam com o app pela borda HTTP, como um cliente faria, com a identidade falsa, o PGlite com as migrações reais e o relógio injetável (`apps/server/test/harness.ts`):

```ts
const t = await testApp();                                  // banco novo e migrado, relógio em 2026-11-24T12:00Z
const juliana = t.as({ id: "1001", name: "Juliana" });     // id = UserProfile.ID da tailnet
await juliana.post(`/api/channels/${id}/messages`, { body: "oi" });
t.clock.advance(90_000);
await t.anonymous("funnel").get("/api/me");                  // sem identidade
```

O que cada teste abre é fechado sozinho no fim dele (`onCleanup` no arnês, executado pelo `afterEach` de `test/preload.ts`).

### WebSocket de eventos

O PWA abre um WebSocket em `/api/events` (`EVENTS_PATH`). O upgrade passa pelo mesmo middleware de `/api/*`: sem identidade ou sem ser Membro, 403 e a conexão não sobe. Toda conexão começa com `{ type: "ready", me }`; depois, só chegam eventos (`ServerEvent` em `packages/contracts`). Comandos continuam no HTTP.

Para publicar, o módulo recebe o `EventHub` e chama `events.publish(audiência, evento)`, sempre **depois** de gravar. A audiência é `"everyone"` ou `{ members: [ids] }` (todas as conexões desses Membros). Quem sabe quem vê a conversa resolve os participantes; o que é só do autor (estado da Conta) vai para `{ members: [autor] }`. Evento novo é mais um membro da união `ServerEvent`, com `type` no formato `assunto.fato`.

Nos testes, `t.socket(pessoa)` abre a conexão como uma aba (num `Bun.serve` real que sobe sob demanda) e espera o `ready`:

```ts
const aba = await t.socket(juliana, "aba da Juliana");      // o rótulo aparece nas falhas
await juliana.post(`/api/channels/${id}/messages`, { body: "oi" });
const { message } = await aba.next("message.created");      // espera até 1 s; falha dizendo o que chegou
aba.received();                                             // tudo o que chegou, em ordem
(await t.upgrade({ none: "funnel" })).status;                // 403: upgrade recusado
t.events.publish({ members: [id] }, evento);                 // publicar direto no hub
```

Para provar que algo **não** chegou, sem `sleep`: publique depois um evento que chega a todos e verifique que o próximo evento daquele tipo na conexão é ele (exemplo em `apps/server/test/realtime.test.ts`).

## e2e

Um punhado de testes de tela com o runner do [e2e](https://e2e.com) (`@e2e-dev/web`, Chromium headless), no workspace `e2e/`. Precisa de Node 24.8 ou mais novo (o runner roda no Node; o app sobe com o Bun). Na primeira vez, o Chromium é baixado sozinho.

```sh
bun run e2e                                   # build do PWA + todos os e2e
(cd e2e && npx e2e run tests/realtime.e2e.ts) # um arquivo, sem refazer o build
(cd e2e && npx e2e run --headed)              # vendo o navegador
```

O runner sobe o servidor de verdade (`bun apps/server/src/main.ts serve`) numa porta livre, servindo `apps/web/dist`, com `SHEARIM_IDENTITY=dev` e `SHEARIM_PGLITE_DIR=memory://`: cada execução começa de uma Instalação vazia, e a primeira aba a abrir (a "Pessoa Dev") vira Admin. Os testes da mesma execução dividem esse banco, então use textos únicos (`Date.now()`). Duas abas da mesma pessoa são `browser.newTab()` + `browser.goto("/")` e `tab.activate()`. O cookie `dev_user` vale para o contexto inteiro (todas as abas), então uma segunda pessoa no mesmo teste age pela API, num `fetch` para `${app.baseUrl}/api/...` com `cookie: dev_user=${encodeURIComponent(JSON.stringify({ id, name }))}` (a partir do #16, quando ela puder virar Membro); `/dev/como/<id>?nome=Fulana` troca a pessoa do navegador todo. Resultados e traces ficam em `e2e/.e2e/` (ignorado pelo git). Antes de escrever um teste, leia `npx e2e guide writing-tests`.

## Instalação

O Shearim sobe com `docker compose` atrás do sidecar do Tailscale em userspace (ADRs 0007 e 0008). Quem abre `https://<TS_HOSTNAME>.<tailnet>.ts.net` passa pelo Tailscale Serve, que faz proxy para `http://app:3000`. O app pega o IP do peer no `X-Forwarded-For` e pergunta ao tailscaled de quem ele é, pelo `whois` da LocalAPI no socket comum (`ts-socket`). O Membro é o `UserProfile.ID`.

```sh
deploy/setup.sh          # pede a auth key (com tag:shearim) e o e-mail de contato, gera ./secrets, confere a tailnet
docker compose up -d     # sobe tudo; a URL aparece no fim do setup
deploy/setup.sh --check  # só as conferências (MagicDNS, HTTPS, tag do nó)
```

- **Segredos** em `./secrets` (pasta 700, fora do git): `ts_authkey`, `postgres_password` e `master_key`. O setup nunca troca um que já existe. O backup completo é o dump do banco mais essa pasta.
- **Configuração** só no `.env` (`SHEARIM_VAPID_CONTACT`, e opcionalmente `TS_HOSTNAME`, `SHEARIM_IMAGE` e `SHEARIM_VERSION`). Sem interação, para o instalador: `TS_AUTHKEY=... SHEARIM_CONTACT_EMAIL=... deploy/setup.sh`.
- **Regras do compose que não se negociam:** nenhum serviço tem `ports:`. A rede `interna` tem só o sidecar, o app, o Postgres e o backup, e nenhum `docker-compose.override.yml` pode ligar outro serviço a ela (quem está nela fala com `app:3000` e forja o `X-Forwarded-For`). O sidecar fica em userspace, com `cap_drop: ALL` e sem `/dev/net/tun`. O app roda como `bun` (sem root), então a LocalAPI só lhe dá leitura.
- **Identidade:** uma pergunta ao `whois` por sessão (a resposta vale 60 s por IP de peer). O WebSocket pergunta no upgrade e fica com aquele Membro. Nó com tag, Funnel e IP desconhecido não têm identidade (403 `no_identity`). Com o tailscaled fora do ar, a API responde 503 `identity_unavailable` e o motivo vai para o log do app.
- **Saúde:** `/api/health` é o healthcheck do app; o `stop_grace_period` é de 30 s.
- **Testes:** o adaptador `whois` tem um teste de contrato contra uma LocalAPI falsa num Unix socket (`fakeLocalApi()` em `apps/server/test/fake-localapi.ts`), com respostas gravadas em `apps/server/test/fixtures/localapi/`. O sidecar de verdade fica no smoke manual.
