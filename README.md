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

- `bun run dev` usa um PGlite em disco em `.data/pglite` (apague a pasta para começar de uma Instalação vazia) e a **identidade de desenvolvimento**: sem cookie, você é a "Pessoa Dev"; abra `http://localhost:5173/dev/como/<id>?nome=Fulana` para ser outra pessoa naquela aba (ela cai no Pedido de entrada, e a Pessoa Dev aprova no painel "Pedidos de entrada"). `/dev/sem-identidade/<tagged|funnel|unknown>` faz o navegador chegar sem identidade, para ver a página estática com o motivo. Essas rotas só existem com `SHEARIM_IDENTITY=dev`.
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
| `SHEARIM_CLAUDE_BIN` | `claude` do `PATH` | O binário do Claude Code das Contas (ADR 0005). Sem ele, "Ligar minha Conta" mostra o erro na tela. |
| `SHEARIM_ACCOUNTS_DIR` | `.data/accounts` | Pasta-raiz das Contas: uma pasta de `CLAUDE_CONFIG_DIR` por login, fora do backup (no compose, o volume `contas`). O Shearim nunca lê o que há dentro. |
| `SHEARIM_MASTER_KEY_FILE` | `.data/secrets/master_key` | A chave mestra (32 bytes em hex, como o `deploy/setup.sh` grava, ou em base64), que cifra a Chave do Workspace. No compose, `/run/secrets/master_key`. Sem a variável, o arquivo padrão é gerado se faltar (só desenvolvimento); com ela, o arquivo tem que existir. Com outra chave mestra, o Admin grava a Chave de novo. |
| `SHEARIM_ANTHROPIC_BASE_URL` | (a da Anthropic) | Onde fica a Messages API. O e2e aponta para a falsa. |

## Layout

```
apps/server/        Bun + Hono + Drizzle
  src/app.ts        createApp(deps) -> { app, websocket, events, close }: o seam dos testes
  src/events.ts     WebSocket de eventos: EventHub.publish(audiência, evento)
  src/accounts/     Contas: rotas /api/account e o adaptador do binário `claude` (claude-cli.ts)
  src/conversations.ts  rotas de Canais, participantes, mensagens de toda conversa e Instruções do Canal
  src/dms.ts        rotas de DMs (abrir, listar)
  src/participation.ts  quem participa, quem vê (canSee) e quem recebe eventos (audienceOf)
  src/agents.ts     rotas de Agentes; src/workspace-key.ts a Chave do Workspace (cifrada por src/secrets.ts)
  src/mentions.ts   extração de `@nome` (seam do #19)
  src/context.ts    montagem de contexto: as 6 camadas que cada execução recebe (buildContext)
  src/workspace-context.ts  o Contexto do Workspace (só Admin)
  src/executions.ts fila de execuções no Postgres e o trabalhador que a esvazia
  src/model/        porta de modelo (port.ts: eventos normalizados) e o cérebro da Chave (key.ts)
  src/main.ts       entrypoint: serve | migrate
  src/db/           schema.ts (Drizzle), client.ts, connect.ts (Postgres ou PGlite)
  src/identity/     porta de identidade: whois.ts (tailnet) e dev.ts
  src/join-requests.ts  Pedido de entrada (pedir, aprovar, recusar)
  src/no-identity-page.ts  página estática de quem chega sem identidade
  migrations/       SQL gerado pelo drizzle-kit (commitado)
  test/harness.ts   arnês: testApp(), testDb(), fakeClock(), fakeIdentity, t.addMember(), throwawayAccounts(), eventually()
  test/fake-claude/ o dublê do binário `claude` (processo de verdade, roteirizável)
  test/fakes/       messages-api.ts: a Messages API falsa (o dublê da Chave)
  test/fake-localapi.ts  LocalAPI falsa do tailscaled num Unix socket (contrato do whois)
apps/web/           PWA em React + Vite, pt-BR
packages/contracts/ DTOs do HTTP e eventos do WebSocket (ServerEvent), compartilhados
e2e/                e2e.config.ts + serve.ts (app com os dublês) + tests/*.e2e.ts (@e2e-dev/web) + support/ (pessoas pela API)
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

Prazos esperam pelo relógio injetável: o código chama `clock.after(ms, fn)` (nunca `setTimeout` direto), e `t.clock.advance(ms)` dispara, em ordem, o que venceu no caminho. Os 10 minutos da espera pelo código rodam num `advance`.

O que cada teste abre é fechado sozinho no fim dele (`onCleanup` no arnês, executado pelo `afterEach` de `test/preload.ts`).

`Person` aceita também `sharee: true` (outra tailnet), `device` e `profilePicUrl`, como o `whois` diria.

### Pessoa aprovada como Membro

Quem não é o primeiro só vira Membro pelo Pedido de entrada. Para pôr alguém no Workspace num teste, use o fluxo de verdade, sem gravar no banco:

```ts
const t = await testApp();
await t.addMember(bruno, { by: juliana });   // Juliana abre a Instalação (vira Admin), Bruno pede, ela aprova
await t.addMember(carla);                    // sem `by`: aprova o DEFAULT_ADMIN (abre a Instalação se vazia)
```

Se o teste já abriu o Workspace com outra pessoa, passe-a em `by`. Devolve o `MeDto` de quem entrou; falha com o status e o corpo se algum passo for recusado.

### Pedido de entrada (#16)

- `GET /api/join-request` e `POST /api/join-request`: o pedido de quem chama. São as únicas rotas que quem tem identidade mas não é Membro alcança; o resto de `/api` dá `403 not_a_member`.
- `GET /api/join-requests`, `POST /api/join-requests/:id/approve` e `/refuse`: só Admin (`403 not_admin`). Decidir de novo dá `409 already_decided`.
- Eventos só para Admins: `join_request.created` e `join_request.decided`.
- `createApp({ hooks: { joinRequestCreated } })` roda a cada pedido novo, depois de gravar: é onde o push aos Admins (#34) se pendura. Nos testes, `testApp({ hooks })`.
- Sem identidade, toda rota fora de `/api` e `/dev` responde a página estática em pt-BR com o motivo (403); os textos ficam em `NO_IDENTITY_TEXT` (`packages/contracts`), e o PWA usa os mesmos.

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

### DMs e conversas

Uma DM é uma conversa fechada sem nome, fora dos Canais: `dm` (duas pessoas; com o #23, pessoa e Agente) ou `group` (três ou mais). Ela mora na mesma tabela dos Canais (`channels.kind`), sem nome, com Instruções vazias e N fixo em 30; por isso o mesmo id serve para mensagens, participantes, eventos (`canSee`/`audienceOf` valem igual) e, daqui para frente, Threads, não-lido e push. As rotas de Canal e as Instruções dos Canais não conhecem DMs (404).

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/dms` | Membro | as DMs de que ele participa (`DmDto`: `id`, `kind`, participantes) |
| `POST /api/dms` | Membro | `{ memberIds }` (as outras pessoas). Com exatamente as mesmas pessoas e o mesmo tipo, devolve a que existe (200); senão, abre uma (201) |
| `GET /api/conversations/:id/messages` | quem vê | mensagens de qualquer conversa (Canal ou DM) |
| `POST /api/conversations/:id/messages` | quem vê | `{ body }`; `/api/channels/:id/messages` continua, só para Canais |

Uma DM nova sai como `dm.updated` (com o `DmDto`) para os participantes. `MessageDto.channelId` é o id da conversa, Canal ou DM.

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

### Agentes, Chave e execuções

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/workspace-key` | Admin | `{ configured, updatedAt }`. A Chave nunca volta |
| `PUT /api/workspace-key` | Admin | `{ apiKey }`: grava (cifrada com a chave mestra) |
| `GET /api/agents` | Membro | `AgentDto[]`; `instructions` só para o Admin |
| `POST /api/agents` | Admin | `{ name, photo?, description?, instructions?, model }`; 409 `name_taken` |
| `POST /api/channels/:id/agents` | quem vê | `{ agentId }`: o Agente vira participante `kind: "agent"` |
| `GET /api/conversations/:id/executions` | quem vê | o Andamento do que ainda não virou resposta (também em `/api/channels/:id/executions`) |
| `GET`/`PUT /api/workspace-context` | Admin | `{ context }`: o Contexto do Workspace (até 4000 caracteres, `WORKSPACE_CONTEXT_MAX`) |
| `PUT /api/me/about` | Membro | `{ aboutMe }`: o "sobre mim" de quem chama (até 500 caracteres; mínimo do #21, o perfil do #19 o absorve) |

Uma mensagem de pessoa num Canal com `@Nome` de um Agente (qualquer Agente do Workspace, sem diferença de maiúsculas nem acentos; em DM é do #23) é gravada e anunciada; depois, uma execução por Agente mencionado entra na fila (tabela `executions`). O trabalhador (`executions.start()`, um por processo, uma execução por vez) paga pela Chave, chama a porta de modelo e grava a resposta com `originMessageId` (a resposta ancorada). O Andamento sai como `execution.updated` (`queued` → `running`/`writing` → `done`, `failed` com `reason`, ou `not_acting` sem Chave); a resposta sai antes como `message.created`. Ao subir, o que estava `running` volta para a fila.

### Montagem de contexto

`buildContext` (`src/context.ts`) lê tudo na hora em que a execução começa (a que sai de novo depois de um reinício relê). O `system` leva, nesta ordem e sem as seções vazias: o preâmbulo (chat de time, pt-BR, sem ferramentas, não promete ações, quem chamou e onde), `## Contexto do Workspace`, `## Suas instruções`, `## Instruções do Canal` e `## Quem é quem` (as pessoas que participam da conversa com o "sobre mim"; os Agentes do Canal, o próprio, marcado "(você)", e os que falaram nas mensagens que entram, com a descrição). As mensagens vão numa única mensagem `user`: as N anteriores à de origem e ela por último, uma por parágrafo, como `Nome (pessoa): texto` ou `Nome (Agente): texto`. O N é `channels.recent_messages` (DM: 30 fixo). Seams: `Call` para quem chamou (delegado do #22, com a frase do que cobrir) e `recentMessages` para a Thread (#29: a raiz entra sempre). Teste o contexto pelo que chegou ao dublê (`t.anthropic.requests[n].body.system`/`messages`), nunca chamando `buildContext`.

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

O runner sobe o servidor de verdade (por `e2e/serve.ts`, que antes sobe a Messages API falsa, respondendo devagar para a bolha "escrevendo" aparecer, e aponta o servidor para ela com uma chave mestra temporária) numa porta livre, servindo `apps/web/dist`, com `SHEARIM_IDENTITY=dev` e `SHEARIM_PGLITE_DIR=memory://`: cada execução começa de uma Instalação vazia, e a primeira aba a abrir (a "Pessoa Dev") vira Admin. Os testes da mesma execução dividem esse banco, então use textos únicos (`Date.now()`). Duas abas da mesma pessoa são `browser.newTab()` + `browser.goto("/")` e `tab.activate()`. O cookie `dev_user` vale para o contexto inteiro (todas as abas), então uma segunda pessoa no mesmo teste age pela API, com os helpers de `e2e/support/people.ts`: `newPerson("Bruno")` (id único na execução), `addMember(app.baseUrl, bruno)` (ela pede e a Pessoa Dev aprova), `requestToJoin`/`approve` separados, e `as(app.baseUrl, bruno)("/api/...", init)` para chamar a API como ela (sem pessoa, é a Pessoa Dev). `/dev/como/<id>?nome=Fulana` troca a pessoa do navegador todo; ela chega como não-Membro, no Pedido de entrada. Resultados e traces ficam em `e2e/.e2e/` (ignorado pelo git). Antes de escrever um teste, leia `npx e2e guide writing-tests`.

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
