# Shearim

Chat de time em que pessoas e Agentes de IA conversam nos mesmos lugares. O vocabulário está em [`GLOSSARY.md`](GLOSSARY.md) e as decisões em [`docs/adr/`](docs/adr/).

## Como rodar

Precisa só do [Bun](https://bun.sh) **1.3.11**.

```sh
bun install            # dependências de todos os workspaces
bun run dev            # servidor em 127.0.0.1:3000 + Vite em http://localhost:5173
bun run test           # testes do servidor (PGlite em memória, sem Docker); use `bun run test`, não `bun test` puro: só o script passa `--timeout 30000`
bun run typecheck      # tsc em todos os workspaces
bun run lint           # Biome (formatação + lint); `bunx biome check --write .` corrige
bun run build          # build do PWA em apps/web/dist
bun run e2e            # build + e2e no navegador (ver "e2e" abaixo)
bun run start          # servidor servindo o build (precisa de SHEARIM_IDENTITY, ver abaixo)
deploy/setup.sh        # Instalação: segredos, .env e conferência da tailnet (ver "Instalação")
deploy/release.sh 1.2.3 dist   # empacota a release (o workflow de release roda; ver "Instalador e atualização")
(cd apps/server && bunx drizzle-kit generate --name <nome>)   # nova migração a partir do schema.ts
```

### Desenvolvimento

- `bun run dev` usa um PGlite em disco em `.data/pglite` (apague a pasta para começar de uma Instalação vazia) e a **identidade de desenvolvimento**: sem cookie, você é a "Pessoa Dev"; abra `http://localhost:5173/dev/como/<id>?nome=Fulana` para ser outra pessoa naquela aba (ela cai no Pedido de entrada, e a Pessoa Dev aprova no painel "Pedidos de entrada"). `/dev/sem-identidade/<tagged|funnel|unknown>` faz o navegador chegar sem identidade, para ver a página estática com o motivo. Essas rotas só existem com `SHEARIM_IDENTITY=dev`.
- Com `DATABASE_URL` definida, o servidor fala com o Postgres em vez do PGlite.
- O servidor sempre aplica as migrações ao subir (`serve`); `bun apps/server/src/main.ts migrate` aplica e sai. Os dois fazem um dump em `.data/backups` antes de migrar um banco que já tem dados e se recusam a rodar num banco migrado por uma versão mais nova (ver "Backup, restauração e migrações").

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
| `SHEARIM_CLAUDE_BIN` | `claude` do `PATH` | O binário do Claude Code das Contas (ADR 0005) e das execuções pela Conta (ADR 0006). Sem ele, "Ligar minha Conta" mostra o erro na tela. Na imagem, `/usr/local/bin/claude`, fixado em `CLAUDE_CODE_VERSION` no `Dockerfile`, com `DISABLE_AUTOUPDATER=1`. |
| `SHEARIM_ACCOUNTS_DIR` | `.data/accounts` | Pasta-raiz das Contas: uma pasta de `CLAUDE_CONFIG_DIR` por login, fora do backup (no compose, o volume `contas`). O Shearim nunca lê o que há dentro. |
| `SHEARIM_MASTER_KEY_FILE` | `.data/secrets/master_key` | A chave mestra (32 bytes em hex, como o `deploy/setup.sh` grava, ou em base64), que cifra a Chave do Workspace. No compose, `/run/secrets/master_key`. Sem a variável, o arquivo padrão é gerado se faltar (só desenvolvimento); com ela, o arquivo tem que existir. Com outra chave mestra, o Admin grava a Chave de novo. |
| `SHEARIM_ANTHROPIC_BASE_URL` | (a da Anthropic) | Onde fica a Messages API. O e2e aponta para a falsa. |
| `SHEARIM_BACKUPS_DIR` | `.data/backups` | `./backups`: dumps de antes de migrar e de restaurar, e os backups noturnos. No compose, `/backups`. |
| `SHEARIM_BACKUP_AT` | `03:00` | Hora do backup noturno (comando `backup`), na hora local do container (`TZ`). |
| `SHEARIM_PG_BIN_DIR` | (o `PATH`) | Pasta do `pg_dump`/`pg_restore`. |
| `SHEARIM_VERSION` | `dev` | A versão na seção Instalação (a imagem traz a tag). |
| `SHEARIM_VAPID_CONTACT` | `mailto:shearim@example.com` (só dev) | O `sub` do VAPID do push: `mailto:` com domínio real (a Apple recusa `localhost`). O `deploy/setup.sh` grava no `.env`. |
| `SHEARIM_MAX_PER_ACCOUNT` | `2` | Respostas ao mesmo tempo pela Conta de um Membro (o roteamento fica fora). No compose, vem do `.env`. |
| `SHEARIM_MAX_ON_KEY` | `4` | Execuções ao mesmo tempo pela Chave do Workspace (roteamento incluso). |
| `SHEARIM_MAX_PROCESSES` | `8` | Processos `claude -p` ao mesmo tempo no host: todas as execuções pela Conta, roteamento incluso. Valor que não é inteiro maior que zero impede a subida. |

## Layout

```
apps/server/        Bun + Hono + Drizzle
  src/app.ts        createApp(deps) -> { app, websocket, events, executions, start, drain, halt, close }: o seam dos testes
  src/events.ts     WebSocket de eventos: EventHub.publish(audiência, evento)
  src/accounts/     Contas: rotas /api/account, a limpeza da subida e o adaptador do binário `claude` (claude-cli.ts)
  src/model/        porta de modelo (port.ts): o cérebro da Chave (key.ts, Messages API) e o da Conta (account.ts, `claude -p`)
  src/conversations.ts  rotas de Canais, participantes, mensagens de toda conversa e Instruções do Canal
  src/dms.ts        rotas de DMs (abrir, listar)
  src/participation.ts  quem participa, quem vê (canSee) e quem recebe eventos (audienceOf)
  src/agents.ts     rotas de Agentes; src/workspace-key.ts a Chave do Workspace (cifrada por src/secrets.ts)
  src/key-budget.ts Chave e orçamentos: o gasto na Chave por Agente e mês, o orçamento e os incidentes da Chave
  src/articuladora.ts  a Articuladora: descrição, instruções e modelo do roteamento (do código)
  src/routing.ts    o contrato de roteamento (pedido, `ROUTING_SCHEMA`, conferência) e o mapa do Workspace visto pelo autor
  src/outcomes.ts   os Desfechos gravados (`outcomes`) e o `OutcomeDto`
  src/context.ts    montagem de contexto: as 6 camadas que cada execução recebe (buildContext)
  src/workspace-context.ts  o Contexto do Workspace (só Admin)
  src/threads.ts    Threads seguidas: quem segue (`recordFollows`, `followersOf`) e `GET /api/threads/followed`
  src/reading.ts    leitura e não-lido: quais mensagens cada Membro viu, contagens e `unread.updated`
  src/presence.ts   Presença: qual conversa cada conexão tem à vista (faz o push calar)
  src/push.ts       push: par VAPID, inscrições por aparelho, gatilhos de Menção, DM, resposta de Agente, Thread seguida e falha; push-sender.ts é o adaptador do `web-push`
  src/executions.ts fila de execuções no Postgres e o trabalhador que a esvazia
  src/model/        porta de modelo (port.ts: eventos normalizados) e o cérebro da Chave (key.ts)
  src/main.ts       entrypoint: serve | migrate | restore <arquivo> | backup
  src/installation/ migrações seguras (migrations.ts), dumps (dumper.ts, postgres-dumper.ts), comandos
                    (commands.ts), backup noturno (backups.ts), chave do nó (node-key.ts) e a seção
                    Instalação com os avisos ao Admin (status.ts)
  src/db/           schema.ts (Drizzle), client.ts, connect.ts (Postgres ou PGlite)
  src/identity/     porta de identidade: whois.ts (tailnet) e dev.ts
  src/join-requests.ts  Pedido de entrada (pedir, aprovar, recusar)
  src/members.ts    Membro (com o identificador), primeira entrada, lista de Membros
  src/member-admin.ts  o Admin gerencia Membros: papel (`PATCH /api/members/:id`) e remoção (`DELETE`)
  src/profile.ts    perfil do próprio Membro (`/api/me`)
  src/mention-handles.ts  espaço de nomes dos identificadores de Menção (Membros e Agentes)
  src/mentions.ts   `@nome` no texto: extração, quem foi mencionado, registro
  src/no-identity-page.ts  página estática de quem chega sem identidade
  migrations/       SQL gerado pelo drizzle-kit (commitado)
  test/harness.ts   arnês: testApp(), testDb(), fakeClock(), fakeIdentity, t.addMember(), throwawayAccounts(), eventually()
  test/fake-claude/ o dublê do binário `claude` (processo de verdade, roteirizável)
  test/fakes/       messages-api.ts: a Messages API falsa (o dublê da Chave); scripted-brain.ts: o cérebro roteirizado; push-collector.ts: o coletor de push; push-cert.ts: o certificado dos push services falsos
  test/fake-localapi.ts  LocalAPI falsa do tailscaled num Unix socket (contrato do whois)
apps/web/           PWA em React + Vite, pt-BR
packages/contracts/ DTOs do HTTP e eventos do WebSocket (ServerEvent), compartilhados
e2e/                e2e.config.ts + serve.ts (app com os dublês) + tests/*.e2e.ts (@e2e-dev/web) + support/ (pessoas pela API)
compose.yaml        a Instalação: sidecar do Tailscale, app, Postgres e backup
Dockerfile          imagem do app (oven/bun:1.3.11, sem root)
deploy/             install.sh (instalador de uma linha), update.sh, setup.sh, release.sh e tailscale/serve.json
.github/workflows/  release.yml: imagem no GHCR com tag fixa e a release com o que o instalador baixa
```

## Testes

Os testes falam com o app pela borda HTTP, como um cliente faria, com a identidade falsa, o PGlite com as migrações reais e o relógio injetável (`apps/server/test/harness.ts`):

```ts
const t = await testApp();                                  // banco novo e migrado, relógio em 2026-11-24T12:00Z
const juliana = t.as({ id: "1001", name: "Juliana" });     // id = UserProfile.ID da tailnet
await juliana.post(`/api/channels/${id}/messages`, { body: "oi" });
await juliana.patch("/api/me", { displayName: "Ju" });       // get, post, put, patch, delete e request
t.clock.advance(90_000);
await t.anonymous("funnel").get("/api/me");                  // sem identidade
```

Prazos esperam pelo relógio injetável: o código chama `clock.after(ms, fn)` (nunca `setTimeout` direto), e `t.clock.advance(ms)` dispara, em ordem, o que venceu no caminho. A exceção é o encerramento do `claude -p` (`SIGINT`, 10 s, `SIGTERM`, 5 s, `SIGKILL`; `exitsWithin` em `model/account.ts`): é o prazo de um processo de verdade, no tempo real, e os testes o encurtam com `stopGrace`. Os 10 minutos da espera pelo código rodam num `advance`.

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
- `createApp({ hooks: { joinRequestCreated } })` roda a cada pedido novo, depois de gravar, logo depois do push aos Admins (#34). Nos testes, `testApp({ hooks })`.
- Sem identidade, toda rota fora de `/api` e `/dev` responde a página estática em pt-BR com o motivo (403); os textos ficam em `NO_IDENTITY_TEXT` (`packages/contracts`), e o PWA usa os mesmos.

### WebSocket de eventos

O PWA abre um WebSocket em `/api/events` (`EVENTS_PATH`). O upgrade passa pelo mesmo middleware de `/api/*`: sem identidade ou sem ser Membro, 403 e a conexão não sobe. Toda conexão começa com `{ type: "ready", me, connectionId }` (o `connectionId` é o da Presença); depois, só chegam eventos (`ServerEvent` em `packages/contracts`). Comandos continuam no HTTP.

No dreno de uma atualização (`SIGTERM`, e também no `SIGINT`), o servidor fecha toda conexão com **1012** (`EVENTS_CLOSE_UPDATING`, "service restart") logo de início e responde `503 { error: "updating" }` a upgrades novos. Para o PWA, 1012 é "Atualizando o Shearim"; qualquer outro fechamento é queda ("Reconectando…"). No Bun 1.3.11, o `server.stop()` não resolve depois que o servidor fecha um WebSocket: o `main.ts` espera no máximo 1 s, e o arnês também não espera (`stopServer`).

No PWA, `apps/web/src/live.ts` abre o WebSocket só para Membro (`useServerEvents(handler, enabled)`; no Pedido de entrada o upgrade seria recusado), não tenta sem internet e expõe o estado (`useLiveStatus`). `apps/web/src/connection.ts` decide o aviso, nesta ordem: sem internet (`navigator.onLine`) é "Você está sem internet"; WebSocket fechado com 1012 é a faixa "Atualizando o Shearim" (até reconectar, ou 2 min); com o WebSocket caído, um `GET /api/me` a cada 2 s separa "Sem conexão com o Shearim" (o `fetch` falha: confira o Tailscale), "O Shearim não consegue falar com o Tailscale" (503 `identity_unavailable`) e "Reconectando…" (o servidor responde). Com a conversa aberta, o aviso é uma faixa sobre ela; sem nada carregado, é a tela inteira, que tenta carregar de novo a cada 2 s e quando a internet volta.

Para publicar, o módulo recebe o `EventHub` e chama `events.publish(audiência, evento)`, sempre **depois** de gravar. A audiência é `"everyone"`, `{ members: [ids] }` (todas as conexões desses Membros) ou `{ everyoneBut: [ids] }`; `without(audiência, id)` tira alguém (o autor que recebe a sua cópia à parte). Quem sabe quem vê a conversa resolve os participantes; o que é só do autor (estado da Conta) vai para `{ members: [autor] }`. Evento novo é mais um membro da união `ServerEvent`, com `type` no formato `assunto.fato`.

Nos testes, `t.socket(pessoa)` abre a conexão como uma aba (num `Bun.serve` real que sobe sob demanda) e espera o `ready`:

```ts
const aba = await t.socket(juliana, "aba da Juliana");      // o rótulo aparece nas falhas
await juliana.post(`/api/channels/${id}/messages`, { body: "oi" });
const { message } = await aba.next("message.created");      // espera até 5 s; falha dizendo o que chegou
const { code } = await aba.closed;                           // como a conexão caiu (1012 no dreno)
aba.received();                                             // tudo o que chegou, em ordem
(await t.upgrade({ none: "funnel" })).status;                // 403: upgrade recusado
t.events.publish({ members: [id] }, evento);                 // publicar direto no hub
```

`events.disconnect(memberId, código, motivo)` fecha todas as conexões de um Membro: a remoção usa `MEMBER_REMOVED_CLOSE_CODE` (4403), que o `aba.closed` mostra. O mesmo cuidado com o `server.stop()` do Bun 1.3.11 vale aqui.

### Admin gerencia Membros (#36)

| Rota | Quem | O quê |
|---|---|---|
| `PATCH /api/members/:id` | Admin | `{ role: "admin" \| "member" }`: torna Admin ou rebaixa (inclusive a si mesmo). Devolve o `MemberSummaryDto` (que agora traz `role`) e publica `member.updated` para todos. Rebaixar o último Admin: `409 last_admin` |
| `DELETE /api/members/:id` | Admin | remove o Membro (204). A si mesmo: `409 cannot_remove_self` (ninguém sai sozinho); o último Admin: `409 last_admin`; quem já saiu: 404 |

As decisões de papel passam por uma trava (`pg_advisory_xact_lock`) que reconfere, dentro dela, que quem decide ainda é Admin e quantos Admins há: dois Admins rebaixando ou removendo um ao outro ao mesmo tempo não zeram os Admins.

**Remoção** (o Membro "saiu do Workspace"): a linha fica, com `members.left_at` e o papel de volta a Membro comum.
- O acesso acaba: o HTTP responde `403 not_a_member` (o `memberFor` não o reconhece), o upgrade do WebSocket dá 403 e as conexões abertas recebem `member.removed` (que vai a todos) e fecham com 4403. O push dele para (`push.forget`: inscrições, aparelhos e contagens apagados).
- Sai dos Canais privados e das DMs em grupo (`channel.updated`/`dm.updated` para quem fica), e deixa de seguir as Threads deles. Continua nos Canais públicos e nas DMs a dois, que são o histórico dele (e nas Threads seguidas ali).
- As execuções abertas das mensagens dele são canceladas pelo Shearim (`executions.cancelAuthoredBy`), à vista: `cancelled` com `reason: "quem escreveu saiu do Workspace"`. O `cancelled` sem motivo continua sendo o "cancelada por quem escreveu".
- A Conta é desligada (`accounts.unlink`: `claude auth logout` e a pasta apagada) e uma ligação pela metade, encerrada (`accounts.cancel`).
- As mensagens dele saem com `author.leftWorkspace: true` (a marca "saiu do Workspace"). Quem saiu não está em `GET /api/members`, não entra no "quem é quem" do contexto e não pode ser posto numa conversa (400).

**Volta:** quem foi removido vê `removedAt` em `GET /api/join-request` (o pedido aprovado de antes não conta: `joinRequest: null`) e pede de novo. Aprovado, é o mesmo Membro (mesmo `UserProfile.ID`, mesmo id, nome e identificador), como Membro comum, com as mensagens e as DMs a dois de antes, e fora dos Canais privados e das DMs em grupo.

### Perfil e identificador de Menção (#19)

- O nome e a foto vêm da tailnet na **primeira entrada** (o primeiro Admin pelo `whois`, quem foi aprovado pelo que o Pedido de entrada guardou). Depois, nada do `whois` é regravado: o nome é do Membro e a tailnet não o sobrescreve.
- `GET /api/me` e `PATCH /api/me` (`UpdateProfileInput`: `displayName?`, `handle?`, `about?`; campo ausente fica). Nome de 1 a 80; "sobre mim" até 500, vazio apaga; identificador inválido: `400 invalid_input`; já de outro participante: `409 handle_taken`. Toda edição sai como `member.updated` (o `MemberSummaryDto`) para todo Membro, inclusive as outras abas de quem editou.
- `MeDto` e `MemberSummaryDto` trazem `handle` (sem `@`), `profilePicUrl` e `about`.
- **Identificador de Menção:** um espaço de nomes só para Membros e Agentes, na tabela `mention_handles` (chave = identificador; cada linha tem um dono, `member_id` ou `agent_id`). A unicidade vem do banco. Gerado da primeira palavra do nome (sem acento, minúsculo, `[a-z0-9_]`, senão o login), com sufixo quando colide (`rafael`, `rafael2`…). Quem mexe nele é só `mention-handles.ts`: `claimHandle(tx, dono, handleBase(nome))` ao criar o participante, `changeHandle` ao editar, `resolveHandles` para achar o dono.
- **Menção:** `mentionPattern()` e `normalizeHandle()` ficam em `packages/contracts` (o servidor extrai, o PWA destaca com a mesma regra). `mentionedIn(db, body)` devolve os donos citados pelo identificador, Membro ou Agente, na ordem do texto. Ao gravar uma mensagem, `recordMentions` registra em `message_mentions` (uma linha por dono: `member_id` ou `agent_id`) as Menções a Membros que veem a conversa (num privado, citar quem está de fora não conta) e a todo Agente citado. `MessageDto.mentions` (`MentionDto[]`: `{ kind: "member" | "agent", id }`, na ordem do texto) chega na resposta, na lista e no `message.created`; a Menção é do participante, então sobrevive à troca de identificador. O PWA destaca a mensagem ("menciona você") para quem foi mencionado.
- **Agentes:** `POST /api/agents` cria o Agente e, na mesma transação, o identificador dele com `claimHandle(tx, { kind: "agent", id }, agentHandleBase(nome))`: o nome inteiro sem espaço nem acento (`Sophya Jurídico` → `sophyajuridico`), com sufixo se já for de alguém (`faro2`). `AgentDto.handle` traz o identificador. Os Agentes de antes da migração `0006` ganham o do nome pelo mesmo critério, em SQL. A Menção a Agente (o que o faz responder) é a `kind: "agent"` de `MessageDto.mentions`.

### Canais e visibilidade

Um Canal público é visto por todo Membro; um privado só por quem participa. Para quem não participa de um privado (o Admin inclusive), ele não está em `GET /api/channels`, responde 404 em toda rota dele e não manda evento. A regra mora em `participation.ts`: `canSee` (HTTP) e `audienceOf` (WebSocket) são a mesma decisão vista dos dois lados; toda rota que publica evento de uma conversa passa por `audienceOf`. Quem cria um Canal participa dele; escrever num público é entrar nele.

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/channels` | Membro | Canais que ele vê (`ChannelDto`, com Instruções, N e participantes) |
| `POST /api/channels` | Membro | `{ name, kind }`; 409 `name_taken` (sem diferença de maiúsculas) |
| `GET /api/channels/:id` | quem vê | o Canal |
| `POST /api/channels/:id/join` | Membro | entra num público (privado: 404) |
| `POST /api/channels/:id/participants` | quem vê | `{ memberId }`; adiciona uma pessoa |
| `GET /api/members` | Membro | `MemberSummaryDto[]` (`id`, `displayName`, `handle`, `profilePicUrl`, `about`, `role`), sem quem saiu do Workspace, para escolher quem adicionar |
| `GET /api/channel-settings` | Admin | Instruções e N de todo Canal, sem mensagens nem participantes |
| `PATCH /api/channel-settings/:id` | Admin | `{ instructions?, recentMessages? }` (N inteiro ≥ 0, padrão 30) |

Toda mudança num Canal (criado, alguém entrou, Instruções ou N) sai como `channel.updated` com o `ChannelDto` inteiro, para quem vê o Canal; o cliente insere ou troca pelo `id`.

### DMs e conversas

Uma DM é uma conversa fechada sem nome, fora dos Canais: `dm` (duas pessoas, ou uma pessoa e um Agente) ou `group` (três ou mais). Ela mora na mesma tabela dos Canais (`channels.kind`), sem nome, com Instruções vazias e N fixo em 30; por isso o mesmo id serve para mensagens, participantes, eventos (`canSee`/`audienceOf` valem igual) e, daqui para frente, Threads, não-lido e push. As rotas de Canal e as Instruções dos Canais não conhecem DMs (404).

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/dms` | Membro | as DMs de que ele participa (`DmDto`: `id`, `kind`, participantes) |
| `POST /api/dms` | Membro | `{ memberIds }` (as outras pessoas) ou `{ agentId }` (a DM de quem abre com esse Agente). Com exatamente os mesmos participantes (pessoas e Agente) e o mesmo tipo, devolve a que existe (200); senão, abre uma (201) |
| `GET /api/conversations/:id/messages` | quem vê | mensagens de qualquer conversa (Canal ou DM) |
| `POST /api/conversations/:id/messages` | quem vê | `{ body }`; `/api/channels/:id/messages` continua, só para Canais |

Uma DM nova sai como `dm.updated` (com o `DmDto`) para os participantes. `MessageDto.channelId` é o id da conversa, Canal ou DM.

Para provar que algo **não** chegou, sem `sleep`: publique depois um evento que chega a todos e verifique que o próximo evento daquele tipo na conexão é ele (exemplo em `apps/server/test/realtime.test.ts`).

### Threads e Thread seguida (#29)

Uma Thread é a sequência de mensagens com o mesmo `messages.thread_root_id`, pendurada numa mensagem do fluxo principal da mesma conversa (Canal ou DM). Não há linha de "Thread" à parte: a primeira resposta a abre. Não há Thread dentro de Thread.

| Rota | Quem | O quê |
|---|---|---|
| `POST /api/conversations/:id/messages` | quem vê | `{ body, threadRootId }` responde na Thread daquela raiz; raiz de outra conversa, inexistente ou que já está numa Thread: `400 invalid_input` |
| `GET /api/conversations/:id/messages` | quem vê | todas as mensagens, as de Thread inclusive (`MessageDto.threadRootId`); o cliente separa o fluxo principal das Threads |
| `GET /api/threads/followed` | Membro | `FollowedThreadDto[]` (`conversationId`, `rootMessageId`, `since`): as Threads que ele segue |

- **Quem age:** a mensagem de pessoa numa Thread passa pelo mesmo `whoActs`: Menção chama o mencionado; num Canal com outros Agentes, cada uma recebe o Desfecho da Articuladora. A resposta ancorada a uma mensagem de Thread fica na Thread (`threadRootId` da origem).
- **Contexto e roteamento:** `recentMessages` (em `context.ts`) trata o fluxo principal e cada Thread como conversas separadas: no fluxo principal, as N anteriores sem as mensagens de Thread; numa Thread, a raiz sempre (fora do N) e as N anteriores da Thread. O preâmbulo diz "numa Thread do Canal #x". O roteamento recebe a raiz e até 5 da Thread, a seção `## Já falaram nesta Thread` (os Agentes do Canal que já escreveram na raiz ou na Thread) e a instrução de preferi-los.
- **Thread seguida:** seguem, sozinhos e uma vez só, o autor da raiz, quem respondeu e quem foi mencionado na Thread ou na raiz (as Menções que o #19 registra, de quem vê a conversa), gravados na mesma transação da mensagem (`thread_follows`, com `since`). Quem passa a seguir recebe `thread.followed` (só nas conexões dele). Agentes não seguem. Seguir e deixar de seguir à mão ficam fora da v1. O push de Thread seguida (#32) avisa `followersOf(db, raiz)`, com `Urgency: normal`.
- **Não-lido:** a mensagem de Thread conta como não-lida só para quem segue a Thread, e só a partir de `since`: quem não segue vê no Canal só o resumo ("3 respostas") e não fica com um badge que só sumiria abrindo Threads de que não participa. Na ordem de exibição, a Thread vem logo depois do grupo da raiz (a raiz e as respostas ancoradas a ela), na ordem dela, com as respostas ancoradas sob cada mensagem. O `unread.updated` continua indo a todo participante a cada mensagem nova.
- **Ordem (#42):** a "conversa para a ordem" é `(executions.channel_id, executions.thread_root_id)` (`onTurn` em `executions.ts`): o fluxo principal e cada Thread contam como conversas separadas para a série por Agente.
- **PWA:** sob cada mensagem do fluxo principal, "Responder na Thread" (ou "n respostas") abre o painel da Thread ao lado (no celular, por cima), com a raiz, as mensagens da Thread com a resposta ancorada, o Desfecho e o Andamento, e o campo "Responder na Thread". O painel tem a própria leitura (`useReading`), e mostra "Você segue esta Thread".

### Leitura e não-lido

O servidor guarda **quais mensagens** cada Membro viu (`message_reads`), não um cursor. Conta como não-lida, para cada participante da conversa, toda mensagem que chegou depois de ele entrar nela, não é dele e ainda não apareceu na tela dele, inclusive a resposta ancorada. Quem vê um Canal público sem participar não tem não-lidas ali. A **ordem de exibição** é a da tela: cada mensagem de pessoa na ordem de gravação, seguida das respostas ancoradas sob ela.

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/unread` | Membro | `UnreadDto`: por conversa (`count`, `mentions`, `firstUnreadId`), mais `total` (o badge), `mentions` e `dms` |
| `GET /api/conversations/:id/unread` | quem vê | `{ messageIds }` não-lidas, na ordem de exibição (a primeira é onde a conversa abre) |
| `POST /api/conversations/:id/reads` | quem vê | `{ messageIds }` que apareceram na tela; ignora as de outra conversa e as do próprio Membro. Devolve o `UnreadDto` |

`unread.updated` (com o `UnreadDto` inteiro) vai só às conexões do próprio Membro: a cada mensagem nova numa conversa dele (`reading.messageCreated(dto)`, chamado depois de gravar e anunciar, por quem cria mensagem: o envio e a resposta do Agente) e a cada marcação que leu algo. `mentions` conta as não-lidas com Menção ao Membro, pelas Menções que o #19 registra ao gravar (`message_mentions`). O badge do ícone e o push (#32) leem o `total`.

No PWA, `apps/web/src/reading.ts` (`useReading`) faz a leitura da conversa aberta: marca o que aparece na tela com a aba visível, abre na primeira não-lida com a linha "Novas", mantém a tela parada fora do fim e dá os avisos flutuantes ("↑ Faro respondeu Juliana", "↑ n respostas acima", "↓ n novas abaixo"), que levam à mensagem e a fazem piscar (`data-flash`).

### Presença e push (#31)

| Rota | Quem | O quê |
|---|---|---|
| `PUT /api/presence` | Membro | `{ connectionId, conversationId \| null }`: a conversa que essa conexão (o `connectionId` do `ready`) tem aberta e visível. 404 para conexão de outra pessoa, que já caiu, ou conversa que ele não vê |
| `GET /api/push/key` | Membro | `{ publicKey }`: a chave pública VAPID (o `applicationServerKey`) |
| `PUT /api/push/subscriptions/:aparelho` | Membro | `PushSubscription.toJSON()` deste aparelho (o id é um UUID que o PWA gera e guarda). Troca a anterior do aparelho; o mesmo endpoint inscrito por outra pessoa muda de dono. 204 |
| `GET /api/devices` | Membro | `DeviceDto[]`: os aparelhos com push, na ordem em que foram ligados, com `pushing`, `pushStoppedAt` ("parou em") e `lastPushAt` |
| `DELETE /api/devices/:aparelho` | Membro | Remove o aparelho e a inscrição dele (só os do próprio Membro; 404 para os outros). 204 |

- **Presença** (`presence.ts`): na memória do processo, por conexão de WebSocket. Enquanto alguma conexão do Membro tem a conversa à vista, o push dela não sai para nenhum aparelho; a conexão que cai leva a Presença junto. O PWA manda a conversa aberta com a aba visível e em foco (`setPresence` em `apps/web/src/live.ts`) e repete a cada `ready`.
- **Par VAPID**: gerado na primeira subida (`push.ensureKeys()` no `main.ts`) e guardado em `vapid_keys`; nunca muda (trocar mata todas as inscrições).
- **Gatilhos** (`push.messageCreated(dto, conversa)`, chamado depois de anunciar e do `reading.messageCreated`, pelo mesmo caminho, no envio (`conversations.ts`) e na resposta de Agente (`executions.ts`), que recebem o `push` por injeção): Menção a Membro e toda mensagem de DM (`high`, inclusive a resposta do Agente numa DM com ele); a resposta de Agente à mensagem de uma pessoa num Canal, a quem escreveu (`normal`); mensagem numa Thread, a quem a segue (`normal`). Quem tem mais de um motivo recebe um push só, com a urgência maior; nunca quem escreveu, quem saiu do Workspace ou quem não vê a conversa. Mensagem comum de Canal, "⏸ na fila" e "Agentes não agem" não geram push.
- **Falha (#32)**: `push.executionFailed(dto)`, ligado em `hooks.executionFailed` (só a falha de vez; a passageira, que a nova tentativa conserta, não avisa). Vai só ao autor da mensagem, `high`, título `#canal · Faro não respondeu` (`Faro não respondeu` numa DM), corpo com o motivo, `tag` `falha-<execução>` e `Topic` = a execução sem hífens (não é engolida pelo "3 novas" da conversa), e leva a `/c/<conversa>?m=<mensagem>` (`messagePath`). A Presença também a cala.
- **Formato**: o JSON do Declarative Web Push, `{ web_push: 8030, notification: { title, body, navigate, tag, lang }, app_badge }`. Título `#canal · Autor`, `Autor` (DM) ou `Autor em DM com X, Y` (grupo); corpo com cerca de 140 caracteres; `navigate` absoluto para `/c/<conversa>` na origem de onde o aparelho se inscreveu; `app_badge` é o `total` de `unreadOf`. Pushes seguidos da mesma conversa viram "3 novas em #vendas" (ou "3 novas de Juliana", "3 novas em DM com X, Y") com `Autor: trecho` da última; abrir a conversa (Presença) zera a contagem (`push_streaks`).
- **Envio**: um de cada vez, em segundo plano (quem escreve não espera), com `tag` e `Topic` da conversa (o UUID sem hífens, 32 caracteres), a `Urgency` do gatilho e TTL de 24 h. `404`/`410` apagam a inscrição e anotam `devices.push_stopped_at`.
- **Aparelhos (#33)**: `devices.updated` (com a lista inteira, como no `GET`) vai às conexões do próprio Membro quando um aparelho para (404/410), liga o push de novo (o `PUT` tira o "parou em"), passa a ser de outra pessoa (o mesmo navegador inscrito por ela) ou é removido. O último push entregue não gera evento.
- **Pushes do Admin e da Conta (#34)**: `push.notify(membro, { title, body, path, tag, urgency, icon? })`, um push que não é de conversa (`Topic` = a `tag` em base64url, até 32). Os ganchos de domínio do próprio app rodam antes dos de `deps.hooks` (os dos testes). `admin-pushes.ts`, a todo Admin ativo: Pedido de entrada (`hooks.joinRequestCreated`; nome no título, `login · aparelho · de outra tailnet` no corpo, a foto em `icon`, `tag` `pedido-<id>`, `high`, leva a `/membros`), incidente da Chave (`hooks.keyIncidentOpened`; `tag` `chave-incidente`, `high`, leva a `/chave`) e estouro de orçamento (`hooks.budgetExceeded`; `tag` `orcamento-<agente>`, `normal`, leva a `/agentes`). `account-pushes.ts`, só ao dono da Conta (nunca a um Admin): queda (`hooks.accountDropped`, chamado pelo `markLimited` só na passagem para "No limite" e pelo `markNeedsRelink`; o texto muda conforme a "Chave utilizável": `keyCoverage` em `key-budget.ts` diz `all` (há Chave e todo Agente tem orçamento no mês: "seguem pela Chave do Workspace"), `some` (algum Agente estourou: "seguem pela Chave do Workspace; as para Agente sem orçamento no mês esperam na fila") ou `none` (sem Chave, ou todo Agente estourou: "esperam na fila"); a Chave sem ressalva só é prometida quando cobre todo Agente; `tag` `conta`) e assinatura repetida (`hooks.subscriptionShared(donos, membro)`, depois de ligar uma assinatura que outros já tinham: "Fulana também ligou a sua Conta do Claude", `tag` `conta-assinatura`). Os dois vão a `/conta`, com `normal`. O aviso de vencimento da Conta (#35, `hooks.accountExpiring(membro, { until, state })`) usa o mesmo `notify` com `tag` `conta`: "Ligue sua Conta do Claude de novo até DD/MM", com o que acontece depois (pela Chave, ou a fila até ligar de novo, pelo mesmo `keyCoverage`). A hora do "volta às HH:MM" é a local do servidor (`TZ`). Backup e chave do nó: ver "Instalação" (#38).
- **PWA**: `public/sw.js` monta a notificação nos navegadores sem Declarative Web Push e, ao tocar, abre a conversa (foca a janela aberta e lhe manda `{ type: "navigate", navigate }`, `SW_NAVIGATE_MESSAGE`, ou abre `navigate`); como não passa por bundler, repete o `CONVERSATION_PATH_PATTERN` do contrato, e `test/sw-contrato.test.ts` confere que as cópias batem; `/c/<id>` abre a conversa, e `/instalacao`, `/membros`, `/chave`, `/agentes` e `/conta` abrem a tela (`SCREENS` em `App.tsx`), também ao tocar num push com a janela aberta. Abrir uma conversa fecha as notificações dela no aparelho (`closeNotificationsOf`, inclusive as de falha, pela conversa que o service worker guarda em `data`). `/c/<id>?m=<mensagem>` abre a conversa na mensagem, que vem para o meio e pisca (numa Thread, a Thread abre). O onboarding "Ligar notificações" (com "Pular") aparece enquanto a permissão não foi dada, ninguém pulou neste aparelho e o servidor não o conhece; pede a permissão no toque. Badge (#32): `showBadge(total)` chama `setAppBadge`/`clearAppBadge` com o `total` de não-lidas ao abrir e a cada `unread.updated`; o service worker aplica o `app_badge` de cada push.
- **Aparelhos e push parado no PWA (#33)** (`usePush` em `apps/web/src/notifications.ts`): a cada abertura, com a permissão dada, o PWA confere a inscrição e a entrega de novo; se o servidor diz que este aparelho parou, desfaz a inscrição guardada e pede outra (o iOS guarda a morta sem avisar). Faixas (`PushBanners.tsx`): "Notificações desligadas neste aparelho · Ligar" quando este aparelho já teve push e está sem (com a permissão negada, a faixa diz como reativar), e "O push parou no iPhone em 20/11" para cada outro aparelho parado, em qualquer aparelho, até ele voltar ou ser removido. A tela Notificações (botão no topo, `DevicesView.tsx`) lista os aparelhos com o estado e o último push entregue, remove um ("Remover"; se for este, desfaz a inscrição aqui e não a renova mais) e liga o push neste aparelho. No iPhone fora da tela de início, o passo ilustrado "Compartilhar → Adicionar à Tela de Início" (`InstallOnIphone`) aparece até ser pulado.

Nos testes, `testApp()` traz o coletor de push em `t.push` (HTTPS com certificado autoassinado gerado pelo `openssl` e guardado no tmp; o app manda por um agente que o aceita):

```ts
const celular = await t.pushDevice(bruno);           // inscrição nova no coletor, entregue pelo PUT
const push = await celular.next();                   // payload decifrado, tag, topic, urgency, ttl, status
celular.respond(410);                                // daqui em diante o push service diz "inscrição morta"
t.push.deliveries;                                   // tudo o que chegou, de todos os aparelhos
await t.as(bruno).put("/api/presence", { connectionId: aba.connectionId, conversationId });
```

O coletor registra a entrega antes de o servidor ler a resposta: o que o servidor anota depois (`lastPushAt`, "parou em") se espera com `eventually`. Para provar que um push **não** saiu, mande depois um que sai e verifique que o próximo a chegar é ele.

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
- `claude -p` em `stream-json`: lê o stdin até o fim (o prompt; fica em `call.stdin`) e `run` diz o que acontece (`reply` em deltas com `result` de sucesso e, se pedido, `credential_expires_at`; `error` com a categoria em `assistant.error` e `result.is_error`, `die`, `hang`). Sem login na pasta, responde `authentication_failed`. `runs: [...]` é uma fila, um roteiro por start (vazia, vale `run`).
- `{ kind: "steps", steps, end }` roteiriza uma execução: `{ text }` (deltas), `{ thinking: true }`, `{ sleepMs }`, `{ hang: true }`, `{ apiRetry: { attempt, max } }`, `{ rateLimit: { status, resetsAt (s), isUsingOverage } }`, `{ die: código }`; `end` é `{ result: "success", credentialExpiresAt?, structuredOutput?, costUsd?, usage? }` (padrão) ou `{ result: "error", error?, apiErrorStatus?, terminalReason? }` (exit 1, `subtype: "success"`, como o real).
- Sinais: todo `-p` registra os que leva (`t.claude.signals(pid)`, com `at`). No `SIGINT`, o padrão é o do real (`result` com `aborted_streaming`, exit 0); `onSigint: "ignore"` fica de pé. No `SIGTERM`, sai 143; `onSigterm: "ignore"` fica até o `SIGKILL`.
- `fakeLogin(pasta)` deixa uma pasta "logada" sem o fluxo de ligar; `t.linkAccount(pessoa)` liga a Conta pelo fluxo de verdade e devolve a pasta (o `CLAUDE_CONFIG_DIR`). O arnês injeta prazos curtos no encerramento (`accounts.stopGrace`, 300 ms + 300 ms).

### Agentes, Chave e execuções

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/workspace-key` | Admin | `{ configured, updatedAt, incident }` (o incidente da Chave aberto, ou `null`). A Chave nunca volta |
| `PUT /api/workspace-key` | Admin | `{ apiKey }`: grava (cifrada com a chave mestra) |
| `GET /api/agents` | Membro | `AgentDto[]` (com `handle`); `instructions`, `monthlyBudgetUsd`, `keySpendUsd` e `overBudget` só para o Admin |
| `POST /api/agents` | Admin | `{ name, photo?, description?, instructions?, model, monthlyBudgetUsd? }`; 409 `name_taken` |
| `PATCH /api/agents/:id` | Admin | `UpdateAgentInput` (campo ausente fica); trocar o nome troca o `handle`. Na Articuladora, `description`/`instructions` dão `403 builtin_locked`; 409 `name_taken` |
| `GET /api/conversations/:id/outcomes` | quem vê | os Desfechos da Articuladora (`OutcomeDto[]`), na ordem das mensagens; numa DM, vazio |
| `POST /api/channels/:id/agents` | quem vê | `{ agentId }`: o Agente vira participante `kind: "agent"` |
| `GET /api/conversations/:id/executions` | quem vê | o Andamento do que ainda não virou resposta (também em `/api/channels/:id/executions`) |
| `POST /api/conversations/:id/executions/:executionId/retry` | autor da mensagem | "Tentar de novo" de uma falha: volta para a fila (`attempt: 0`), refazendo só essa execução. `403 not_author`, `409 not_failed` |
| `POST /api/conversations/:id/messages/:messageId/cancel` | autor da mensagem | cancela, em qualquer passo, o que a mensagem ainda tem aberto (`queued`, `running`, `retrying`) e devolve as canceladas. `403 not_author`, `409 nothing_to_cancel` |
| `GET`/`PUT /api/workspace-context` | Admin | `{ context }`: o Contexto do Workspace (até 4000 caracteres, `WORKSPACE_CONTEXT_MAX`) |

Uma mensagem de pessoa com `@identificador` de um Agente (qualquer Agente do Workspace, sem diferença de maiúsculas nem acentos), num Canal ou numa DM, é gravada junto com uma execução por Agente mencionado na fila (tabela `executions`, `kind: "mention"`), na mesma transação (`executions.enqueue(tx, …)`; ADR 0003: nenhuma mensagem fica sem Andamento, nem se o que vem depois de gravar falhar); depois de anunciada a mensagem, `executions.queued(ids)` anuncia o Andamento e acorda o trabalhador. Numa DM com Agente, ele responde a cada mensagem, mencionado ou não (`kind: "dm"`, uma vez só mesmo se mencionado); numa DM entre pessoas ou em grupo, Agente só entra por Menção e não vira participante. DMs não têm Desfecho. Quem decide quem age é `whoActs` em `conversations.ts`; a resposta de um Agente não passa por lá, então uma Menção de Agente a Agente não dispara nada. Já a Menção a pessoa escrita por Agente vale como a de pessoa: a resposta grava as Menções (`recordMentions`) e, numa Thread, quem ela cita passa a seguir (`recordFollows` com `authorMemberId` nulo), na mesma transação; daí saem o push de Menção, a contagem de Menções e o destaque "menciona você". O trabalhador (`executions.start()`, um por processo, várias execuções ao mesmo tempo: ver "Concorrência e ordem", abaixo) decide quem paga (a tabela de "Quem paga e fila", abaixo; `choosePayer` e `byPayer` em `executions.ts`), chama a porta de modelo e grava a resposta com `originMessageId` (a resposta ancorada). O Andamento sai como `execution.updated` (`queued` → `running`/`writing` → `done`, `failed` com `reason`, `not_acting` sem Chave, ou `cancelled`); a resposta sai antes como `message.created`.

Nenhuma execução fica no limbo (ADR 0003, #24):

- **Vigia:** um passo em andamento que fica 2 min (`STALL_MS`) sem progresso vira falha ("ficou 2 minutos sem escrever nada"). Progresso é texto, pensamento ou `api_retry` da porta de modelo; `ping` não conta. O `api_retry` aparece em `apiRetry: { attempt, max }` ("tentando de novo (n/m)") e some quando o texto volta.
- **Nova tentativa:** a falha que vale nova tentativa (todas, menos credencial recusada, sem crédito e `failed` com `retryable: false`) vira `retrying`, com `reason` e `retryAt` (10 s depois, `RETRY_DELAY_MS`). Na hora, volta para a fila mantendo a hora de chegada, como `attempt: 2`, decidindo de novo quem paga e relendo o contexto. A segunda falha é `failed` de vez (com ", nas duas tentativas" quando o motivo se repete), e só então roda `hooks.executionFailed(dto)`: é onde o push ao autor (#32) se pendura. "Tentar de novo" começa um ciclo novo, com a sua nova tentativa automática, e marca a execução (`retriedByAuthor`) para o #27 pagar pela Conta do autor.
- **Cancelamento:** a execução que está rodando é interrompida pelo `AbortSignal` da porta de modelo, com o motivo em `signal.reason` (`"stalled" | "cancelled" | "shutdown"`). É por ele que o cérebro da Conta (#26) faz o `SIGINT`, 10 s, `SIGTERM`, 5 s, `SIGKILL`. A resposta e o fim são gravados juntos: um cancelamento no último instante ganha.
- **Subida:** o que estava `running` ficou sem processo vivo e vira "o servidor reiniciou", seguindo a nova tentativa (ou falha de vez, se já era a segunda). Antes, `start()` limpa `SHEARIM_ACCOUNTS_DIR`: apaga as pastas de login (`<raiz>/<membro>/<uuid>`) que não são a pasta de uma Conta, e em cada pasta de Conta o `.oauth_refresh.lock` órfão (só pasta vazia com mais de 60 s, pelo relógio do sistema).

Pela Conta (#26, ADR 0006): cada execução é um `claude -p` novo (`src/model/account.ts`), sem sessão, em `stream-json`, sem tools, settings nem MCP, com o contexto fixo em `--system-prompt` e as mensagens no stdin, na pasta da Conta (`accountEnv`: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_MAX_RETRIES=3`, `API_TIMEOUT_MS=90000`, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS=90000`). A falha se lê por `is_error`, `assistant.error` e `terminal_reason`. Processo que morre sem `result` é falha na hora; a vigia, o cancelamento e a parada encerram por `SIGINT`, 10 s, `SIGTERM`, 5 s, `SIGKILL`. **Troca no meio:** `rate_limit_event` rejeitado, `assistant.error: "rate_limit"` ou `authentication_failed` descartam o parcial e refazem a resposta pela Chave na mesma tentativa (`payer` vira `key`); o aviso de 85% e o uso extra seguem na Conta; o `server_error` do lock de renovação é falha comum. O `credential_expires_at` do fim vai para `accounts.credential_expires_at` (a validade mostrada é do #35). No Andamento, `payer` é `key` pela Chave e nulo pela Conta (o estado da Conta é só do autor). O `output: { schema }` do pedido (o roteamento da Articuladora) vira `--json-schema`, e o `structured_output` do `result` volta como o texto da resposta, como pela Chave (ADR 0009); o roteamento também é pago pela Conta do autor, com a mesma troca no meio.
- **Dreno:** no `SIGTERM`, o `drain()` do app fecha os WebSockets com 1012 e `executions.drain()` para de pegar trabalho e espera até 20 s (`DRAIN_MS`) o que está rodando; o resto fica para a subida seguinte. `SIGINT` (Ctrl-C) é o `halt()`: fecha os WebSockets igual e para na hora.

### Concorrência e ordem (#42)

O trabalhador olha a fila a cada mudança (mensagem nova, execução que terminou, cancelamento, nova tentativa vencida, Conta ou Chave que mudou) e põe para rodar, ao mesmo tempo, cada execução pronta que está na vez e cabe nos tetos de quem paga. Cada uma roda com o seu `AbortController` (a vigia, o cancelamento e a parada valem para ela sozinha); o dreno espera todas, e o `halt()`/`stop()` interrompe todas.

- **Ordem** (`onTurn` em `executions.ts`): as respostas de um mesmo Agente numa conversa saem em série, na ordem de chegada. A conversa é `(channel_id, thread_root_id)`: o fluxo principal e cada Thread contam à parte. Uma resposta espera a do mesmo Agente que está rodando ou que chegou antes (inclusive a que espera a nova tentativa) e o roteamento ainda aberto de uma mensagem anterior da conversa, porque ele pode pôr na fila uma resposta que vem antes dela. Agentes diferentes respondem em paralelo; o roteamento não espera ninguém. Quem espera a própria Conta (`held`) sai da série e, quando volta, entra na vez pela hora de chegada (espera a que estiver rodando).
- **Ordem de chegada:** `arrived_at`, depois a ordem das mensagens de origem e a da fila (`arrivalOrder`). Os delegados de um roteamento chegam com a hora dele.
- **Tetos** (`ExecutionLimits`, `DEFAULT_LIMITS`, `limitsFromEnv`): até 2 respostas por Conta (o roteamento fica fora), até 4 execuções na Chave e até 8 processos `claude -p` no host (as execuções pela Conta, roteamento incluso). "Agentes não agem" e a fila por quem pague não ocupam lugar. O pagador é decidido antes de pegar a execução, para saber em que teto ela entra.
- **Prioridade:** o roteamento passa na frente das respostas; entre as respostas, a ordem de chegada. A troca no meio (a Conta bateu no limite ou caiu) devolve a execução à fila com a hora de chegada, na mesma tentativa, e ela sai pela Chave quando houver lugar no teto da Chave.
- **"esperando a vez":** `ExecutionDto.waitingTurn` (todos veem) marca a execução pronta (`queued`, ou `retrying` vencida) que o trabalhador olhou e não pôde pôr para rodar, pela série ou por um teto. O PWA mostra "Faro · esperando a vez".
- **Pegar é atômico no Postgres** (`claim`): o `UPDATE` só pega a linha ainda pronta e na vez, e um `pg_advisory_xact_lock` por conversa faz duas pegas da mesma conversa se enxergarem; dois trabalhadores no mesmo banco nunca pegam a mesma execução nem andam a série em dobro. O fim do roteamento, o Desfecho e os delegados na fila são gravados juntos.
- **Anúncios em ordem:** os `execution.updated` de uma mesma execução saem um depois do outro (cada um lê o estado na sua vez), então um mais velho nunca chega depois de um mais novo.

Nos testes (`apps/server/test/concorrencia.test.ts`), `testApp({ limits: { key: 1 } })` troca os tetos; o paralelismo e a série se provam sem `sleep`, com o cérebro roteirizado (as chamadas ficam abertas até o teste soltar) ou o `fake-claude` com `hang`, e com o `waitingTurn` como sinal de que o trabalhador já decidiu que uma não sai agora.

### Quem paga e fila (#27)

A tabela da Spec (módulo 6) vale para cada execução, inclusive o roteamento da Articuladora e o "Tentar de novo" (que a mesma tabela põe na Conta do autor). "Chave utilizável" é `keyUsableFor(agent)` em `executions.ts`: existe Chave e o Agente tem orçamento no mês (#28, abaixo).

| Conta do autor | Chave utilizável | Sem Chave utilizável |
|---|---|---|
| Ligada | Conta do autor | Conta do autor |
| No limite até HH:MM | Chave | `⏸ na fila` até HH:MM (`held`, `heldUntil`) |
| Precisa ligar de novo | Chave | `⏸ na fila` sem hora, até ligar a Conta de novo |
| Não ligada | Chave | `not_acting` ("Agentes não agem", com o motivo), sem nova tentativa nem push |

- **A Conta muda pelo que a execução viu:** o `limit` da porta (com `resetsAt`) deixa a Conta "No limite até HH:MM" (`accounts.limited_until`; sem a hora, ou com uma hora que já passou, 1 h: `LIMIT_FALLBACK_MS`) e o `auth_failed` a deixa "Precisa ligar de novo" (`account_state = needs_relink`), por `markLimited`/`markNeedsRelink` em `src/accounts`. As próximas execuções nem tentam por ela. "Minha Conta" mostra os dois estados (`AccountStatusDto` `limited` com `until`, `needs_relink`) e muda sozinha quando o limite vence (`account.updated`). Ligar de novo é o mesmo fluxo de ligar (ver "Validade da Conta e religação").
- **A fila:** quem espera continua `queued`, com `held: true`, fora da vez: não segura as outras mensagens. Não gasta tentativa e mantém a hora de chegada, então passa na frente de quem chegou depois quando volta. Volta sozinha em `heldUntil` (o despertador das novas tentativas), quando a Conta do autor é ligada de novo ou desligada (`accounts` → `executions.reconsider(memberId)`) quando o Admin grava a Chave ou muda o orçamento de um Agente (`reconsider()`) e na virada do mês, quando o orçamento recomeça (o trabalhador olha o relógio injetável ao menos uma vez por dia). Sobrevive ao reinício. O autor cancela como qualquer execução aberta.
- **Quem vê o quê:** todos veem `payer: "key"` ("⚠ pela Chave do Workspace"), `held` ("⏸ na fila") e "Agentes não agem". Só a cópia do autor traz `yourAccount` (`limited` com `until`, `needs_relink`, `not_linked`): "⏸ na fila até qui., 15:45", "⏸ na fila até você ligar sua Conta de novo", "· sua Conta no limite até 18:00", "Agentes não agem: você não ligou uma Conta e …". A falha que é estado da Conta (assinatura sem Claude Code, conta suspensa) leva `authorReason` só para o autor; os outros veem "a Anthropic recusou o pedido". Também a falha cujo motivo fala do Claude Code (e revelaria que a execução corria pela Conta) leva o específico só em `authorReason` (`accountFailure` em `model/account.ts`); os outros veem o neutro: "a resposta parou no meio", "deu erro ao gerar a resposta", "o contexto fixo do Agente é grande demais", "o Shearim não conseguiu rodar a execução". Para isso, `publish` manda duas cópias (`without(audiência, autor)`, a audiência `{ everyoneBut }` do `EventHub`) e `GET .../executions` responde a cópia de quem pergunta.
- **A resposta pela Chave:** `MessageDto.payer` é `"key"` na resposta de Agente paga pela Chave (ausente pela Conta), para o "⚠ pela Chave do Workspace" ficar depois que o Andamento some. O porquê ligado à Conta do autor fica também: quando a Chave passa a pagar, `executions.payer_account` guarda o `yourAccount` daquele instante, e a resposta o leva em `MessageDto.yourAccount` só na cópia do autor da origem (`GET .../messages` responde a cópia de quem pergunta; o `message.created` da resposta sai em duas cópias, como o Andamento).

Nos testes (`apps/server/test/quem-paga.test.ts`), o limite é um roteiro do `fake-claude` com `{ rateLimit: { status: "rejected", resetsAt } }` (em segundos) e a volta é `t.clock.set(hora)`. A validação do "Ligar minha Conta" também consome a fila `runs` do `fake-claude`: roteirize depois de `t.linkAccount`. Duas Contas no mesmo teste precisam de assinaturas diferentes (`t.claude.script({ login: { account: { email } } })`), senão a segunda cai em "Ligar mesmo assim".

### Validade da Conta e religação (#35)

- **Validade:** `AccountStatusDto.validity` (em `linked` e `limited`) é `{ until, state, afterwards }`. `until` é a data mais cedo em que o login pode cair: o menor entre `loginExpiresAt` (do `claude auth status --json`) e o `credential_expires_at` da última execução, menos 3 dias (`validityOf` em `src/accounts`). `state` é `ok`, `soon` (faltam 3 dias ou menos: selo no menu pessoal e "Minha Conta" em destaque) ou `any_time` ("pode vencer a qualquer momento"). `afterwards` é `key` ou `queue` (`queue` quando não há Chave utilizável para nenhum Agente: sem Chave, ou todos estouraram o orçamento do mês; `keyCoverage`).
- **Leituras:** o `auth status` roda ao ligar e uma vez por dia para cada Conta Ligada (`accounts.watch()`, chamado no `start()`: uma releitura na subida e outra a cada 24 h do relógio, `STATUS_CHECK_MS`); cada releitura atualiza `loginExpiresAt` e o plano e publica `account.updated`. O fim com sucesso de uma execução pela Conta passa `credentialExpiresAt` e `extraUsage` a `accounts.runEnded`.
- **Aviso:** 3 dias antes de `until`, um único push por login (`accounts.expiry_warned_at`, zerado ao ligar de novo), pelo `hooks.accountExpiring`. Os prazos no relógio só são marcados quando caem antes da próxima releitura (um `setTimeout` não passa de ~24 dias); um login que já liga dentro dos 3 dias avisa na hora.
- **Ligar de novo:** `POST /api/account/linking` vale com a Conta em qualquer estado. A pasta nova só vira a pasta da Conta depois da validação; até lá, as execuções seguem na antiga. "Cancelar", o código que vence e a validação que falha não mexem na Conta. Ao trocar, a pasta antiga sai de uso (`lease` devolve `null` e `byPayer` decide de novo) e é apagada quando o último `claude -p` nela solta o `lease`, sem `claude auth logout`. Ligar de novo a mesma assinatura não repete o aviso de assinatura repetida nem o push ao primeiro dono.
- **Uso extra:** `linked.extraUsage` ("usando uso extra") é o `isUsingOverage` do último `rate_limit_event` de uma execução pela Conta (`done.extraUsage` na porta de modelo).

Nos testes (`apps/server/test/validade-e-religacao.test.ts`), `fakeLogin(pasta, { loginExpiresAt })` muda o que o `auth status` da pasta diz e `t.clock.set`/`advance` passa os dias. O `auth status` tem prazo de 30 s no relógio injetável: espere a releitura terminar (o `account.updated` dela) antes de andar o relógio de novo, senão o prazo mata o processo.

### Chave e orçamentos (#28)

`src/key-budget.ts` (o `ledger` das execuções), Spec módulo 9:

- **Gasto:** cada chamada que a Chave pagou grava uma linha em `execution_usage` (execução, Agente, pagador `key`, modelo, tokens, `cost_usd` pelos preços de `model/key.ts`, `month` `YYYY-MM` em UTC pelo relógio injetado) com o uso que a API informou, tenha ela terminado bem ou não (cancelada, parada pela vigia, falha no meio): o cérebro da Chave emite `{ type: "usage" }` a cada `message_start`/`message_delta`. O custo é pelo modelo do Agente (sem fallback do lado do servidor, é ele quem responde). A Conta não grava nada aqui. O gasto do mês de um Agente é a soma do mês (`keySpend`). A Articuladora paga do orçamento dela o roteamento (no Haiku) e as respostas.
- **Orçamento:** `agents.monthly_budget_usd` (dólares, `>= 0`; nulo é sem teto), em `POST`/`PATCH /api/agents` (`monthlyBudgetUsd`; inválido dá 400). Para o Admin, `AgentDto` traz `monthlyBudgetUsd`, `keySpendUsd` (o mês corrente) e `overBudget` (gasto `>=` teto); os outros não veem nenhum dos três. É conferido em `keyUsableFor` antes de cada execução pela Chave (inclusive na troca no meio); a que já roda termina. Estourado, a Chave não é utilizável: quem não tem Conta vê "Agentes não agem: … Faro estourou o orçamento do mês na Chave", e quem tem Conta no limite espera na fila.
- **Faixas do Admin:** `agent_budget.updated` (`AgentBudgetDto`) a cada uso da Chave e a cada mudança de teto; `key_incident.updated` (`KeyIncidentDto` ou `null`). Só para Admins. `GET /api/workspace-key` traz `incident`.
- **Incidente da Chave:** `auth_failed`/`billing_failed` pela Chave abre um em `key_incidents` (um aberto por vez, índice parcial); a próxima chamada bem-sucedida pela Chave, começada depois da recusa, o encerra (uma que já rodava em paralelo quando a Chave foi recusada não prova nada, #42).
- **Ganchos do push aos Admins (#34, ligados em `admin-pushes.ts`):** `hooks.keyIncidentOpened(incident)` (um por incidente) e `hooks.budgetExceeded(budget)` (no máximo um por Agente por mês, pela tabela `budget_overruns`, mesmo que o teto suba e estoure de novo). Nos testes, `testApp({ hooks })`. No e2e, `[chave recusada]` no texto faz a Messages API falsa recusar a Chave (401).

### Montagem de contexto

`buildContext` (`src/context.ts`) lê tudo na hora em que a execução começa (a que sai de novo depois de um reinício relê). O `system` leva, nesta ordem e sem as seções vazias: o preâmbulo (chat de time, pt-BR, sem ferramentas, não promete ações, quem chamou e onde; numa DM com Agente, `Call` `dm` diz que ele responde a cada mensagem, sem falar em Menção), `## Contexto do Workspace`, `## Suas instruções`, `## Instruções do Canal` e `## Quem é quem` (as pessoas que participam da conversa com o "sobre mim" do perfil, `members.about`, editado por `PATCH /api/me`; os Agentes do Canal, o próprio, marcado "(você)", e os que falaram nas mensagens que entram, com a descrição). As mensagens vão numa única mensagem `user`: as N anteriores à de origem e ela por último, uma por parágrafo, como `Nome (pessoa): texto` ou `Nome (Agente): texto`. O N é `channels.recent_messages` (DM: 30 fixo). `Call` diz quem chamou: `mention`, `dm`, `reply` (a Articuladora, com o motivo) e `delegated` (com a frase do que cobrir). A Articuladora recebe também `## Outros Agentes do Workspace` e `## Canais que quem escreveu pode ver`. Seam: `recentMessages` para a Thread (#29: a raiz entra sempre; o roteamento usa a mesma função). Teste o contexto pelo que chegou ao dublê (`t.anthropic.requests[n].body.system`/`messages`), nunca chamando `buildContext`.

Nos testes, `testApp()` já traz a Messages API falsa em `t.anthropic` (o app usa ela pela Chave) e a fila rodando:

```ts
t.anthropic.reply({ chunks: ["O prazo ", "é sexta."] });          // a próxima resposta
t.anthropic.reply({ status: 402, errorType: "billing_error" });   // erro HTTP antes do stream
t.anthropic.reply({ streamError: { type: "overloaded_error", message: "Overloaded" }, text: "..." });
t.anthropic.reply({ hang: true });                                 // fica pendurada até o cliente desistir
const [chamada] = await t.anthropic.waitForRequests(1);            // apiKey, body (model, system, messages)
t.anthropic.reply({ hang: true, pingEveryMs: 5 });                 // pendurada, só com pings (não é progresso)
await t.anthropic.waitForPings(3);
t.clock.advance(120_000);                                          // a vigia: 2 min sem progresso
await t.drain();                                                   // o dreno do SIGTERM (20 s do relógio injetável)
await t.restart();                                                 // mesmo banco, app novo, fila de novo
await eventually("a resposta sair", async () => /* um GET que devolve algo quando aconteceu */);
```

Para o que a Messages API falsa não sabe dizer (o `api_retry` é do Claude Code; progresso no meio de um passo, com o relógio andando entre um evento e outro), o cérebro roteirizado entra no lugar do cérebro da Chave. `emit` só resolve depois que o Shearim tratou o evento:

```ts
const cerebro = scriptedBrain();                                   // test/fakes/scripted-brain.ts
const t = await testApp({ keyBrain: cerebro.brain });
const chamada = await cerebro.nextRun();                           // request, signal, emit
await chamada.emit({ type: "api_retry", attempt: 1, max: 3 });
t.clock.advance(100_000);
await chamada.emit({ type: "text", text: "Pronto." });
await chamada.emit({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
```

`testApp({ hooks: { executionFailed } })` recebe as falhas de vez; `keyIncidentOpened` e `budgetExceeded`, os avisos da Chave (#28). `testApp({ limits })` troca os tetos de concorrência.

### A Articuladora e o Desfecho (#22, ADR 0004)

- **Ela existe em todo Workspace:** a Sophya nasce na migração `0012` (a linha em `agents` com `builtin: true`, `@sophya` ou com sufixo) e entra em todo Canal, público ou privado (`addArticuladora` na criação do Canal; os de antes, pela migração), nunca nas DMs entre pessoas. `AgentDto.builtin` a marca. A descrição e as instruções dela vêm do código (`src/articuladora.ts`); o Admin muda nome, foto e modelo (o orçamento é do #28). Nos testes, ela já está lá: `GET /api/agents` a devolve primeiro e todo `ChannelDto.participants` a traz.
- **Quem age** (`whoActs`): num Canal com algum Agente além dela, a mensagem de pessoa sem Menção vira uma execução `kind: "route"` da Articuladora (passo `deciding`, "Sophya decidindo quem responde"). Com Menção, só os mencionados (`mention`), inclusive `@sophya`. Num Canal só com ela, nada.
- **O roteamento** (`src/routing.ts`): o pedido vai com `ROUTING_MODEL` (Haiku, fixo) e `ModelRequest.output` (pela Chave, `output_config.format` com `ROUTING_SCHEMA`; pela Conta, o `--json-schema` do #26). Recebe a mensagem e até 5 anteriores (nunca mais que o N), as Instruções do Canal, os Agentes do Canal (`@handle (Nome): descrição`), os outros Agentes do Workspace com os Canais em que estão e os Canais que o autor vê (`workspaceMapFor`, a mesma regra de `canSee`). A saída é `{ decisao: "responder" | "delegar" | "nenhum", agentes: [{ agente, cobrir }], motivo }`; delegado fora do Canal sai, passam até 2; sem Desfecho aproveitável, é falha comum (vigia, nova tentativa e "Tentar de novo" do #24 valem para ela).
- **Depois:** o Desfecho é gravado (`outcomes`) e sai como `outcome.created` (`OutcomeDto`: `decision` `reply | delegate | none`, `reason`, `by`, `delegates` com `cover`). `reply` põe na fila a resposta dela (`kind: "reply"`, modelo dela, contexto completo, com o mapa do Workspace para sugerir em texto quem está fora); `delegate` põe um `delegated` por Agente, com `Call` `{ kind: "delegated", by, cover }`. Os de depois mantêm a hora de chegada do roteamento.
- **Na Messages API falsa:** `reply({ json })` responde a saída estruturada; sem roteiro, o roteamento recebe "nenhum" (`defaultFakeReply`), então um teste que não liga para o Desfecho não ganha resposta a mais (mas ganha uma chamada: filtre `requests` por `!body.output_config`). No e2e, `[delegar]` no texto delega aos dois primeiros Agentes do Canal.

## e2e

Um punhado de testes de tela com o runner do [e2e](https://e2e.com) (`@e2e-dev/web`, Chromium headless), no workspace `e2e/`. Precisa de Node 24.8 ou mais novo (o runner roda no Node; o app sobe com o Bun). Na primeira vez, o Chromium é baixado sozinho.

```sh
bun run e2e                                   # build do PWA + todos os e2e
(cd e2e && npx e2e run tests/realtime.e2e.ts) # um arquivo, sem refazer o build
(cd e2e && npx e2e run --headed)              # vendo o navegador
```

O runner sobe o servidor de verdade (por `e2e/serve.ts`, que antes sobe a Messages API falsa, respondendo devagar para a bolha "escrevendo" aparecer, e aponta o servidor para ela com uma chave mestra temporária; uma mensagem com `[falhe 2x]` no texto recebe a sobrecarga da Anthropic nas duas primeiras chamadas, para o cartão de falha, que sai depois dos 10 s de verdade da nova tentativa, e uma com `[chave recusada]` recebe o 401 que abre o incidente da Chave; as Contas usam o `fake-claude` por `SHEARIM_CLAUDE_BIN`, com um login que vence em 4 dias, para "Minha Conta" já ligar em destaque: `tests/conta.e2e.ts` cola `FAKE_LOGIN_CODE`) numa porta livre, servindo `apps/web/dist`, com `SHEARIM_IDENTITY=dev` e `SHEARIM_PGLITE_DIR=memory://`: cada execução começa de uma Instalação vazia, e a primeira aba a abrir (a "Pessoa Dev") vira Admin. Os testes da mesma execução dividem esse banco, então use textos únicos (`Date.now()`). O Chromium do e2e nega toda permissão; para o caminho de "Ligar notificações", `tests/notificacoes.e2e.ts` troca o push service do navegador por um falso com `browser.addInitScript`. Para o servidor ver uma inscrição morrer, `support/push-service.ts` sobe, no processo do teste, um push service falso em HTTPS (`dead()` responde `410`, `alive()` responde `201`); o `serve.ts` faz o servidor aceitar o certificado dele por `NODE_EXTRA_CA_CERTS` (`apps/server/test/fakes/push-cert.ts`, o mesmo do coletor). Em `tests/aparelhos.e2e.ts`, cada teste tem o seu (fixture `push`), porque os testes rodam ao mesmo tempo. Duas abas da mesma pessoa são `browser.newTab()` + `browser.goto("/")` e `tab.activate()`. O cookie `dev_user` vale para o contexto inteiro (todas as abas), então uma segunda pessoa no mesmo teste age pela API, com os helpers de `e2e/support/people.ts`: `newPerson("Bruno")` (id único na execução), `addMember(app.baseUrl, bruno)` (ela pede e a Pessoa Dev aprova), `requestToJoin`/`approve` separados, e `as(app.baseUrl, bruno)("/api/...", init)` para chamar a API como ela (sem pessoa, é a Pessoa Dev). `/dev/como/<id>?nome=Fulana` troca a pessoa do navegador todo; ela chega como não-Membro, no Pedido de entrada. Para os avisos de conexão, `e2e/support/network.ts` é uma rede de mentira (o runner não tem `setOffline`): `emulateNetwork(browser, modo?)` antes do `app.open` e `network(browser, "offline" | "server-down" | "socket-down" | "online")` depois; `socketsOpened(browser)` conta os WebSockets que a página tentou abrir. O dreno de verdade está em `tests/atualizacao.e2e.ts`, que sobe um Shearim só seu (o fixture `shearim`, com `update()` = SIGTERM e `start()` = a versão nova na mesma porta), porque o servidor da execução é de todos. Resultados e traces ficam em `e2e/.e2e/` (ignorado pelo git). Antes de escrever um teste, leia `npx e2e guide writing-tests`.

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
- **Backup:** o serviço `backup` faz um `pg_dump` por noite em `./backups` (ver abaixo). O backup completo é `./backups` mais `./secrets`.
- **Testes:** o adaptador `whois` tem um teste de contrato contra uma LocalAPI falsa num Unix socket (`fakeLocalApi()` em `apps/server/test/fake-localapi.ts`), com respostas gravadas em `apps/server/test/fixtures/localapi/`. O sidecar de verdade fica no smoke manual.

### Instalador e atualização (#39)

Quem instala precisa do [`gh`](https://cli.github.com) logado numa conta com acesso ao repositório (`gh auth login`). Em Mac ou Linux:

```sh
gh release download --repo rfl-designer/shearim --pattern install.sh --output - | sh
sh ~/shearim/deploy/update.sh            # atualizar para a última release (ou: update.sh v1.3.0)
```

- **O instalador** (`deploy/install.sh`, publicado na release com a tag dela gravada em `RELEASE_TAG`): confere o `gh` (e pede `read:packages`, com `gh auth refresh -s read:packages`, quando o token não tem); garante o Docker; baixa o `shearim-compose.tar.gz` da release em `~/shearim` (`--dir` muda); faz `docker login ghcr.io` com o `gh auth token` pelo stdin; roda o `deploy/setup.sh` (auth key e e-mail, ou `TS_AUTHKEY`/`SHEARIM_CONTACT_EMAIL` sem terminal); `docker compose pull`, `docker compose up -d` e espera o app ficar `healthy`. Pode rodar de novo: o setup nunca troca segredo nem `.env`. Opções: `--dir`, `--version vX.Y.Z`, `--yes` (instala ou inicia o Docker sem perguntar).
- **Docker no Linux:** sem Docker, pergunta e instala pelo script oficial (`get.docker.com`, com sudo); parado, pergunta e roda `systemctl enable --now docker`; sem Compose, instala o `docker-compose-plugin` (apt, dnf ou yum). Se o Docker só responde com sudo, põe o usuário no grupo `docker` (vale na próxima sessão) e, nesta, roda o docker com sudo.
- **Docker no Mac:** usa o que responde (Docker Desktop, OrbStack ou Colima). Parado, pergunta e abre (`open -a OrbStack`/`open -a Docker`, `brew services start colima`). Sem nenhum, pergunta e instala o Colima com o Homebrew (`brew install colima docker docker-compose` e `brew services start colima`, que o sobe a cada login); sem Homebrew, para e aponta https://brew.sh.
- **Mac acordado:** o LaunchAgent `~/Library/LaunchAgents/com.shearim.acordado.plist` roda `/usr/bin/caffeinate -i -t 600` enquanto o `docker info` responde (e espera 60 s quando não). O instalador não muda nenhuma configuração de energia: só lê (`pmset -g`, `defaults read`).
- **Checklist "Mantê-lo rodando"** no fim, com `[x]` no que o terminal verificou: Docker no login/boot (Colima pelo `brew services`, Docker Desktop pelo `AutoStart` do `settings-store.json`, Linux pelo `systemctl is-enabled docker`; OrbStack não dá para ver), Mac acordado (o LaunchAgent carregado), religar depois de falta de luz (`autorestart` do `pmset`; no Linux é a BIOS), login automático no Mac, suspensão mascarada no Linux, containers que voltam sozinhos, MagicDNS e HTTPS (do setup), o app respondendo e a cópia de `./backups` + `./secrets` (nunca marcada). Com a tailnet sem MagicDNS ou HTTPS, o app não sobe, o checklist mostra o que falta e o instalador sai 1.
- **Atualização** (`deploy/update.sh [vX.Y.Z]`, que é o `install.sh --update`): baixa o compose da release (troca `compose.yaml` e `deploy/`; `.env`, `./secrets` e `./backups` ficam), confere com `docker compose config -q` (se o compose novo não fecha com o `.env`, volta o de antes e não reinicia nada), faz o `docker login` e roda `docker compose pull && docker compose up -d`. Avisa quando o `.env` fixa `SHEARIM_VERSION` (aí sobe essa versão, não a da release). Mudanças à mão no `compose.yaml` se perdem: configuração só no `.env`.
- **Imagem e release** (`.github/workflows/release.yml`, numa tag `vX.Y.Z`): a imagem vai para `ghcr.io/rfl-designer/shearim:X.Y.Z` (amd64 e arm64), nunca `latest`, com `SHEARIM_VERSION=X.Y.Z`; o Claude Code fica fixado nela (`CLAUDE_CODE_VERSION` no `Dockerfile`, `DISABLE_AUTOUPDATER=1`). O `deploy/release.sh X.Y.Z dist` gera o `shearim-compose.tar.gz` (o `compose.yaml` com `${SHEARIM_VERSION:-X.Y.Z}` e sem `build:`, e o `deploy/`) e o `install.sh` com a tag; recusa `latest`. Sidecar e Postgres ficam fixados por versão e digest no compose.
- **Testes** (`apps/server/test/deploy/`, no `bun run test`): rodam os scripts de verdade com `/bin/sh`, numa caixa de areia (`sandbox.ts`) com PATH fechado: os dublês de comando (`docker`, `gh`, `brew`, `colima`, `open`, `launchctl`, `pmset`, `defaults`, `uname`, `sudo`, `curl`, `systemctl`, `apt-get`, `sleep`) e poucos utilitários inofensivos; qualquer outro comando dá "not found". `world.ts` monta a máquina de mentira (estado em arquivos, releases empacotadas pelo `release.sh` de verdade). As variáveis `SHEARIM_TTY` (de onde vêm as respostas), `SHEARIM_EXTRA_PATH`, `SHEARIM_APPLICATIONS` e `SHEARIM_WAIT_SECONDS` existem para isso. O `shellcheck` dos scripts roda no mesmo arquivo (pulado sem o `shellcheck` instalado).
- **Smoke manual:** instalar num Mac (com Docker Desktop ou OrbStack, e num sem Docker, aceitando o Colima) e num Linux sem Docker; conferir o checklist, que o Mac não dorme (`pmset -g assertions` mostra o `caffeinate`) e que a URL abre; depois, publicar uma segunda tag e rodar `deploy/update.sh` (o `.env` e `./secrets` iguais, a seção Instalação com a versão nova).

### Backup, restauração e migrações (#38)

```sh
docker compose run --rm app migrate                       # migra à parte (com o dump antes)
docker compose stop app backup                            # antes de restaurar
docker compose run --rm app restore shearim-20261124T030000Z.dump   # pelo nome em ./backups, ou o caminho
docker compose up -d
```

- **Migrações só para a frente.** `serve` e `migrate` comparam o maior `drizzle.__drizzle_migrations.created_at` do banco com o último `when` do `_journal.json` da versão: banco mais novo, a versão não sobe (sai 1 com o que fazer: voltar à versão nova ou restaurar o dump de antes da atualização). Com migração pendente num banco com dados, antes um dump `shearim-pre-migracao-<hora>.dump` em `./backups`; se o dump falha, nada é migrado. Banco vazio não ganha dump.
- **`restore <arquivo>`** troca o banco inteiro pelo do dump (no Postgres: apaga os schemas `public` e `drizzle` e roda o `pg_restore`). Antes, guarda `shearim-pre-restauracao-<hora>.dump` do banco atual (`--sem-copia` pula, para um banco que não tem mais nada a salvar). Os Membros não mudam (são o `UserProfile.ID`); com a mesma `./secrets`, a Chave do Workspace segue legível.
- **Backup noturno** (`backup`, o serviço do compose, a mesma imagem): às `SHEARIM_BACKUP_AT` (padrão 03:00, `TZ` do container), e na subida se não houve backup bom nas últimas 24 h. Arquivo `shearim-<hora UTC>.dump` (`pg_dump -Fc`), escrito em `.partial` e renomeado no fim. Ficam os de menos de 14 dias; os `pre-migracao`/`pre-restauracao` não são apagados. Cada tentativa vai para a tabela `backups`.
- **Seção Instalação** (`GET /api/installation`, só Admin, `InstallationDto`): `version`, `migration` (a última aplicada), `backup.last` e `backup.lastGoodAt`, `nodeKey` (`expires`/`never`/`unknown`, do `GET /localapi/v0/status` do tailscaled, `Self.KeyExpiry`) e `alerts` (`backup_failed`, `backup_stale`). No PWA, "Instalação" na barra do Admin e em `/instalacao`.
- **Avisos ao Admin** (`status.ts`, a cada 15 min, `INSTALLATION_CHECK_MS`): backup que falhou e 36 h sem backup bom (contadas da última boa, ou da primeira subida) mandam push (`Urgency: high`, `tag` `instalacao-backup`, leva a `/instalacao`) a cada Admin e acendem a faixa (`installation.updated` só para Admins, quando muda). A 14 dias do vencimento da chave do nó, push `normal` (`instalacao-chave-do-no`). Cada aviso sai uma vez por ocorrência (`installation_alerts`), também depois de reiniciar. O envio é `push.notify(memberId, { title, body, path, tag, urgency })`, que serve aos outros pushes fora de conversa (#34, #35).

Nos testes:

```ts
const t = await testApp({ installation: { watch: true, version: "1.4.2", nodeKey } });  // watch liga a verificação
const job = createNightlyBackups({ db: t.db, clock: t.clock, dumper: fakeDumper(), dir, log: () => {} });
await job.runNow();                       // ou job.start(); fakeDumper().failWith("...") faz o dump falhar
const localApi = fakeLocalApi(); localApi.status(recordedStatus("status-com-vencimento"));
const nodeKey = localApiNodeKey({ socketPath: localApi.socketPath });
testApp({ db: conn.db, masterKey });      // outro banco (PGlite em disco) e a mesma chave mestra; t.shutdown() para o app
```

- `test/installation-commands.test.ts` roda `bun src/main.ts migrate|serve|restore|backup` de verdade num PGlite em disco (o dump é o `.tar.gz` do diretório de dados).
- `test/postgres-backup.test.ts` sobe um cluster descartável do Postgres 18 (`initdb`/`pg_ctl` numa porta livre) e testa o `pg_dump`/`pg_restore` pela mesma borda. Sem os binários (procura em `SHEARIM_TEST_PG_BIN`, `/opt/homebrew/opt/postgresql@18/bin`, `/usr/lib/postgresql/18/bin`), é pulado.
- **Smoke manual** (Docker): `docker compose build && docker compose up -d`; `docker compose logs backup` mostra o primeiro backup e `ls backups` o arquivo; `docker compose run --rm app migrate`; `docker compose stop app backup && docker compose run --rm app restore <arquivo> && docker compose up -d` e o Workspace volta; a seção Instalação mostra a versão, "há X h" e o vencimento da chave do nó (o de um nó com tag costuma vir "não vence"); `docker compose stop postgres` e esperar o backup falhar (ou mudar `SHEARIM_BACKUP_AT`) para ver o push e a faixa.
