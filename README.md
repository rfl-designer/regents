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
| `SHEARIM_SECRETS_DIR` | `.data/secrets` | Pasta dos segredos. A chave mestra fica em `master_key` (32 bytes em base64, `openssl rand -base64 32`); se faltar, o servidor gera uma. Ela cifra a Chave do Workspace: com outra chave mestra, o Admin grava a Chave de novo. |
| `SHEARIM_ANTHROPIC_BASE_URL` | (a da Anthropic) | Onde fica a Messages API. O e2e aponta para a falsa. |

## Layout

```
apps/server/        Bun + Hono + Drizzle
  src/app.ts        createApp(deps) -> { app, websocket, events }: o seam dos testes
  src/events.ts     WebSocket de eventos: EventHub.publish(audiência, evento)
  src/conversations.ts  rotas de Canais, participantes, mensagens e Instruções do Canal
  src/participation.ts  quem participa, quem vê (canSee) e quem recebe eventos (audienceOf)
  src/agents.ts     rotas de Agentes; src/workspace-key.ts a Chave do Workspace (cifrada por src/secrets.ts)
  src/mentions.ts   extração de `@nome` (seam do #19); src/context.ts montagem de contexto (seam do #21)
  src/executions.ts fila de execuções no Postgres e o trabalhador que a esvazia
  src/model/        porta de modelo (port.ts: eventos normalizados) e o cérebro da Chave (key.ts)
  src/main.ts       entrypoint: serve | migrate
  src/db/           schema.ts (Drizzle), client.ts, connect.ts (Postgres ou PGlite)
  src/identity/     porta de identidade + adaptador de dev
  migrations/       SQL gerado pelo drizzle-kit (commitado)
  test/harness.ts   arnês: testApp(), testDb(), fakeClock(), fakeIdentity, eventually()
  test/fakes/       dublês das pontas: messages-api.ts (a Messages API falsa)
apps/web/           PWA em React + Vite, pt-BR
packages/contracts/ DTOs do HTTP e eventos do WebSocket (ServerEvent), compartilhados
e2e/                e2e.config.ts + serve.ts (app com os dublês) + tests/*.e2e.ts (@e2e-dev/web)
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

### Canais e visibilidade

Um Canal público é visto por todo Membro; um privado só por quem participa. Para quem não participa de um privado (o Admin inclusive), ele não está em `GET /api/channels`, responde 404 em toda rota dele e não manda evento. A regra mora em `participation.ts`: `canSee` (HTTP) e `audienceOf` (WebSocket) são a mesma decisão vista dos dois lados; toda rota que publica evento de uma conversa passa por `audienceOf`. Quem cria um Canal participa dele; escrever num público é entrar nele.

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/channels` | Membro | Canais que ele vê (`ChannelDto`, com Instruções, N e participantes) |
| `POST /api/channels` | Membro | `{ name, kind }`; 409 `name_taken` (sem diferença de maiúsculas) |
| `GET /api/channels/:id` | quem vê | o Canal |
| `POST /api/channels/:id/join` | Membro | entra num público (privado: 404) |
| `POST /api/channels/:id/participants` | quem vê | `{ memberId }`; adiciona uma pessoa |
| `GET /api/members` | Membro | `{ id, displayName }[]`, para escolher quem adicionar |
| `GET /api/channel-settings` | Admin | Instruções e N de todo Canal, sem mensagens nem participantes |
| `PATCH /api/channel-settings/:id` | Admin | `{ instructions?, recentMessages? }` (N inteiro ≥ 0, padrão 30) |

Toda mudança num Canal (criado, alguém entrou, Instruções ou N) sai como `channel.updated` com o `ChannelDto` inteiro, para quem vê o Canal; o cliente insere ou troca pelo `id`.

Para provar que algo **não** chegou, sem `sleep`: publique depois um evento que chega a todos e verifique que o próximo evento daquele tipo na conexão é ele (exemplo em `apps/server/test/realtime.test.ts`).

### Agentes, Chave e execuções

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/workspace-key` | Admin | `{ configured, updatedAt }`. A Chave nunca volta |
| `PUT /api/workspace-key` | Admin | `{ apiKey }`: grava (cifrada com a chave mestra) |
| `GET /api/agents` | Membro | `AgentDto[]`; `instructions` só para o Admin |
| `POST /api/agents` | Admin | `{ name, photo?, description?, instructions?, model }`; 409 `name_taken` |
| `POST /api/channels/:id/agents` | quem vê | `{ agentId }`: o Agente vira participante `kind: "agent"` |
| `GET /api/channels/:id/executions` | quem vê | o Andamento do que ainda não virou resposta |

Uma mensagem de pessoa com `@Nome` de um Agente (qualquer Agente do Workspace, sem diferença de maiúsculas nem acentos) é gravada e anunciada; depois, uma execução por Agente mencionado entra na fila (tabela `executions`). O trabalhador (`executions.start()`, um por processo, uma execução por vez) paga pela Chave, chama a porta de modelo e grava a resposta com `originMessageId` (a resposta ancorada). O Andamento sai como `execution.updated` (`queued` → `running`/`writing` → `done`, `failed` com `reason`, ou `not_acting` sem Chave); a resposta sai antes como `message.created`. Ao subir, o que estava `running` volta para a fila.

Nos testes, `testApp()` já traz a Messages API falsa em `t.anthropic` (o app usa ela pela Chave) e a fila rodando:

```ts
t.anthropic.reply({ chunks: ["O prazo ", "é sexta."] });          // a próxima resposta
t.anthropic.reply({ status: 402, errorType: "billing_error" });   // erro HTTP antes do stream
t.anthropic.reply({ streamError: { type: "overloaded_error", message: "Overloaded" }, text: "..." });
t.anthropic.reply({ hang: true });                                 // fica pendurada até o cliente desistir
const [chamada] = await t.anthropic.waitForRequests(1);            // apiKey, body (model, system, messages)
await t.restart();                                                 // mesmo banco, app novo, fila de novo
await eventually("a resposta sair", async () => /* um GET que devolve algo quando aconteceu */);
```

## e2e

Um punhado de testes de tela com o runner do [e2e](https://e2e.com) (`@e2e-dev/web`, Chromium headless), no workspace `e2e/`. Precisa de Node 24.8 ou mais novo (o runner roda no Node; o app sobe com o Bun). Na primeira vez, o Chromium é baixado sozinho.

```sh
bun run e2e                                   # build do PWA + todos os e2e
(cd e2e && npx e2e run tests/realtime.e2e.ts) # um arquivo, sem refazer o build
(cd e2e && npx e2e run --headed)              # vendo o navegador
```

O runner sobe o servidor de verdade (por `e2e/serve.ts`, que antes sobe a Messages API falsa, respondendo devagar para a bolha "escrevendo" aparecer, e aponta o servidor para ela com uma pasta de segredos temporária) numa porta livre, servindo `apps/web/dist`, com `SHEARIM_IDENTITY=dev` e `SHEARIM_PGLITE_DIR=memory://`: cada execução começa de uma Instalação vazia, e a primeira aba a abrir (a "Pessoa Dev") vira Admin. Os testes da mesma execução dividem esse banco, então use textos únicos (`Date.now()`). Duas abas da mesma pessoa são `browser.newTab()` + `browser.goto("/")` e `tab.activate()`. O cookie `dev_user` vale para o contexto inteiro (todas as abas), então uma segunda pessoa no mesmo teste age pela API, num `fetch` para `${app.baseUrl}/api/...` com `cookie: dev_user=${encodeURIComponent(JSON.stringify({ id, name }))}` (a partir do #16, quando ela puder virar Membro); `/dev/como/<id>?nome=Fulana` troca a pessoa do navegador todo. Resultados e traces ficam em `e2e/.e2e/` (ignorado pelo git). Antes de escrever um teste, leia `npx e2e guide writing-tests`.

