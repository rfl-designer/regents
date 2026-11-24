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
(cd apps/server && bunx drizzle-kit generate --name <nome>)   # nova migração a partir do schema.ts
```

### Desenvolvimento

- `bun run dev` usa um PGlite em disco em `.data/pglite` (apague a pasta para começar de uma Instalação vazia) e a **identidade de desenvolvimento**: sem cookie, você é a "Pessoa Dev"; abra `http://localhost:5173/dev/como/<id>?nome=Fulana` para ser outra pessoa naquela aba. Essa rota só existe com `SHEARIM_IDENTITY=dev`.
- Com `DATABASE_URL` definida, o servidor fala com o Postgres em vez do PGlite.
- O servidor sempre aplica as migrações ao subir (`serve`); `bun apps/server/src/main.ts migrate` aplica e sai.

### Variáveis do servidor

| Variável | Padrão | Para quê |
|---|---|---|
| `SHEARIM_IDENTITY` | (obrigatória) | `dev`. O `whois` da tailnet chega com a Instalação (#37). |
| `DATABASE_URL` | (vazia) | Postgres. Vazia: PGlite em `SHEARIM_PGLITE_DIR`. |
| `SHEARIM_PGLITE_DIR` | `.data/pglite` | Pasta do PGlite de desenvolvimento. `memory://`: em memória, some ao parar (o e2e usa). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Onde escutar (`bun run dev` usa `127.0.0.1`). |
| `SHEARIM_WEB_DIST` | `apps/web/dist` | Build do PWA servido em `/`. |
| `SHEARIM_CLAUDE_BIN` | `claude` do `PATH` | O binário do Claude Code das Contas (ADR 0005). Sem ele, "Ligar minha Conta" mostra o erro na tela. |
| `SHEARIM_ACCOUNTS_DIR` | `.data/accounts` | Pasta-raiz das Contas: uma pasta de `CLAUDE_CONFIG_DIR` por login, fora do backup. O Shearim nunca lê o que há dentro. |

## Layout

```
apps/server/        Bun + Hono + Drizzle
  src/app.ts        createApp(deps) -> { app, websocket, events }: o seam dos testes
  src/events.ts     WebSocket de eventos: EventHub.publish(audiência, evento)
  src/accounts/     Contas: rotas /api/account e o adaptador do binário `claude` (claude-cli.ts)
  src/main.ts       entrypoint: serve | migrate
  src/db/           schema.ts (Drizzle), client.ts, connect.ts (Postgres ou PGlite)
  src/identity/     porta de identidade + adaptador de dev
  migrations/       SQL gerado pelo drizzle-kit (commitado)
  test/harness.ts   arnês: testApp(), testDb(), fakeClock(), fakeIdentity, throwawayAccounts()
  test/fake-claude/ o dublê do binário `claude` (processo de verdade, roteirizável)
apps/web/           PWA em React + Vite, pt-BR
packages/contracts/ DTOs do HTTP e eventos do WebSocket (ServerEvent), compartilhados
e2e/                e2e.config.ts + tests/*.e2e.ts (@e2e-dev/web)
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

Prazos esperam pelo relógio injetável: o código chama `clock.after(ms, fn)` (nunca `setTimeout` direto), e `t.clock.advance(ms)` dispara, em ordem, o que venceu no caminho. Os 10 minutos da espera pelo código rodam num `advance`.

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

### fake-claude

`apps/server/test/fake-claude/` é o dublê do binário `claude` (Spec, "Testing Decisions"): um processo de verdade, sem mock de `spawn`. `testApp()` já cria um e passa o caminho em `deps.accounts.claudeBin`, junto com uma pasta-raiz de Contas descartável (`t.accountsRoot`). Quem monta o `createApp` à mão usa `throwawayAccounts()`.

```ts
t.claude.script({ login: { mode: "silent" } });               // o roteiro vale a partir do próximo start
t.claude.script({ run: { kind: "error", error: "billing_error", apiErrorStatus: 403 } });
t.claude.callsOf("auth login")[0]!.env.CLAUDE_CONFIG_DIR;     // o que cada start recebeu: argv, cwd, env
```

- `auth login`: imprime a URL num hyperlink OSC 8 e o prompt, como o 2.1.30x, e lê o código no stdin. O código certo é `FAKE_LOGIN_CODE`. Com ele, grava o "login" na pasta de `CLAUDE_CONFIG_DIR` (o token falso `FAKE_ACCESS_TOKEN` e a conta) e sai 0. Com outro código, sai 1. `mode: "silent"` não imprime nada e não sai; `mode: "die"` sai 1 sem URL. `account` troca quem entra (o padrão é `DEFAULT_FAKE_ACCOUNT`, `fulana@exemplo.com`, Max).
- `auth status --json`: os campos do real (`loggedIn`, `email`, `orgId`, `subscriptionType`, `planTier`, `loginExpiresAt`...). Sem login, sai 1 com `loggedIn: false`.
- `auth logout`: apaga o login da pasta.
- `claude -p` em `stream-json`: `run` diz o que acontece (`reply` em deltas com `result` de sucesso e, se pedido, `credential_expires_at`; `error` com a categoria em `assistant.error` e `result.is_error`, `die`, `hang`). Sem login na pasta, responde `authentication_failed`. O #26 estende `FakeRun` com passos (pensamento, silêncio, `api_retry`, `rate_limit_event`, morte no meio, `SIGINT`).

## e2e

Um punhado de testes de tela com o runner do [e2e](https://e2e.com) (`@e2e-dev/web`, Chromium headless), no workspace `e2e/`. Precisa de Node 24.8 ou mais novo (o runner roda no Node; o app sobe com o Bun). Na primeira vez, o Chromium é baixado sozinho.

```sh
bun run e2e                                   # build do PWA + todos os e2e
(cd e2e && npx e2e run tests/realtime.e2e.ts) # um arquivo, sem refazer o build
(cd e2e && npx e2e run --headed)              # vendo o navegador
```

O runner sobe o servidor de verdade (`bun apps/server/src/main.ts serve`) numa porta livre, servindo `apps/web/dist`, com `SHEARIM_IDENTITY=dev` e `SHEARIM_PGLITE_DIR=memory://`: cada execução começa de uma Instalação vazia, e a primeira aba a abrir (a "Pessoa Dev") vira Admin. Os testes da mesma execução dividem esse banco, então use textos únicos (`Date.now()`). Duas abas da mesma pessoa são `browser.newTab()` + `browser.goto("/")` e `tab.activate()`. O cookie `dev_user` vale para o contexto inteiro (todas as abas), então uma segunda pessoa no mesmo teste age pela API, num `fetch` para `${app.baseUrl}/api/...` com `cookie: dev_user=${encodeURIComponent(JSON.stringify({ id, name }))}` (a partir do #16, quando ela puder virar Membro); `/dev/como/<id>?nome=Fulana` troca a pessoa do navegador todo. Resultados e traces ficam em `e2e/.e2e/` (ignorado pelo git). Antes de escrever um teste, leia `npx e2e guide writing-tests`.

