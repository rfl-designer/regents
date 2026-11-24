# Claude Code como motor dos Agentes

Pesquisa para a issue #2 (parte do mapa #1). Data: 2026-11-23.

**Pergunta.** Os Agentes pensam por dois caminhos (ADR 0002, emendado pelo ADR 0005): **(A)** o Claude Code headless com a Conta de quem escreveu a mensagem (login de `claude auth login` numa pasta por Membro via `CLAUDE_CONFIG_DIR`; pelo Agent SDK em TypeScript ou `claude -p`; tools desligadas; sem `--bare`) e **(B)** a Messages API com a Chave do Workspace. O que se sabe de fato sobre: (1) detecção de cada falha no caminho A; (2) saber que a Conta está no limite e quando volta; (3) execuções simultâneas por assinatura; (4) sessão viva por pessoa; (5) streaming nos dois caminhos; (6) tempo até a primeira palavra; (7) disputa da renovação do login entre execuções na mesma pasta.

Os fatos sobre `setup-token`, token inválido em `-p` (exit 1, `is_error: true`, `api_error_status: 401`), `auth login` sem TTY e `auth status` que não valida já estão no [comentário de resolução da issue #9](https://github.com/rfl-designer/shearim/issues/9) e não são repetidos aqui.

**Como ler as marcas.**
- **documentado**: afirmado por fonte primária (link ao lado). As páginas de `code.claude.com` foram lidas na versão `.md` em 2026-11-23.
- **medido**: reproduzido nesta pesquisa em macOS arm64, Claude Code **2.1.331**, `@anthropic-ai/claude-agent-sdk` **0.3.331** (só os tipos `.d.ts` do tarball do npm), Bun 1.3.11, assinatura Max já logada na pasta padrão, sempre `--model haiku` (resolveu para `claude-haiku-5-5`) e `--tools ""`. Os comandos estão na seção 9.
- **não verificado**: inferência, relato de terceiros não reproduzido, ou algo que exigiria forçar limite, chave de API ou mexer no login.

---

## 1. Como detectar cada tipo de falha no caminho A

### O contrato geral

- Saída 0 em sucesso e diferente de zero em falha. Flag inválida vai para o stderr antes de começar; falha dentro da execução (por exemplo, sem login) sai **como `result` no stdout**. **documentado** ([headless](https://code.claude.com/docs/en/headless.md)).
- Antes de mostrar um erro, o Claude Code já tentou de novo até 10 vezes com backoff exponencial (`CLAUDE_CODE_MAX_RETRIES`, padrão 10). Cada nova tentativa emite um evento `system/api_retry` com `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (HTTP ou `null` sem resposta) e `error`, uma categoria entre `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error` e `unknown`. **documentado** ([headless, Handle API retries](https://code.claude.com/docs/en/headless.md); [errors, Automatic retries](https://code.claude.com/docs/en/errors.md)) e **medido** (abaixo).
- O erro final tem sempre a mesma forma: uma mensagem `assistant` com o campo `error` (mesma lista de categorias) e o texto legível, seguida de um `result` com `is_error: true`, `api_error_status` e `terminal_reason`. O `subtype` do `result` pode vir `"success"` mesmo com `is_error: true`. Não use o `subtype` para decidir. **medido** e **documentado** nos tipos (`SDKAssistantMessageError`, `SDKResultSuccess.is_error`, `TerminalReason` em `sdk.d.ts`).
- `terminal_reason` vem no `result` com valores como `completed`, `api_error`, `aborted_streaming`, `blocking_limit`, `rapid_refill_breaker`, `prompt_too_long`, `model_error`, `max_turns`, `budget_exhausted`, `turn_setup_failed`. **documentado** (tipo `TerminalReason` em `sdk.d.ts` 0.3.331). O significado de `blocking_limit` e `rapid_refill_breaker` não tem doc em prosa. **não verificado**.

### Tabela por falha

| Falha | O que aparece no stdout (`stream-json`) | Código de saída | Marca |
|---|---|---|---|
| Sucesso | `result` com `is_error: false`, `terminal_reason: "completed"` | 0 | **medido** |
| Modelo inexistente | `assistant.error: "model_not_found"`, `result.is_error: true`, `api_error_status: 404`, `terminal_reason: "api_error"` | 1 | **medido** |
| Conexão recusada | 2× `system/api_retry` (`error_status: null`, `error: "unknown"`), depois `assistant.error: "server_error"` com "API Error: Connection refused … (ECONNREFUSED)" | 1 | **medido** com `CLAUDE_CODE_MAX_RETRIES=2` |
| API não responde | **nada** no stdout durante cada tentativa; um `api_retry` a cada `API_TIMEOUT_MS`; ao fim, "Request timed out…" com `error: "server_error"` | 1 | **medido** com `API_TIMEOUT_MS=15000`: 47 s no total, 16 s de silêncio entre linhas |
| Limite da assinatura | `assistant.error: "rate_limit"` com "You've hit your session limit · resets 3:45pm" (ou weekly/Opus/Sonnet); `rate_limit_event` com `status: "rejected"` | não verificado (provavelmente 1) | **documentado** ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)); não forçado |
| Limite no meio da resposta | a assinatura pode deixar terminar o passo em curso ("Usage limit reached · wrapping up") | — | **documentado** ([support 11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)) |
| Throttle do servidor | "Server is temporarily limiting requests (not your usage limit)"; retentado sozinho desde v2.1.199 | — | **documentado** ([errors](https://code.claude.com/docs/en/errors.md#server-is-temporarily-limiting-requests)) |
| 529 sobrecarga | `api_retry` com `error: "overloaded"`; ao fim "Repeated 529 Overloaded errors". Não conta na cota | 1 | **documentado** ([errors](https://code.claude.com/docs/en/errors.md#api-error-repeated-529-overloaded-errors)) |
| Erro no meio do streaming | o texto já completo é mantido, com "API Error: Server error mid-response. The response above may be incomplete." | — | **documentado** ([errors](https://code.claude.com/docs/en/errors.md#the-response-above-may-be-incomplete)) |
| Login expirado ou no fim da cadeia | `authentication_failed`: "OAuth session expired and could not be refreshed" ou "this login reached its time limit" | não verificado | **documentado** ([errors, Login expired](https://code.claude.com/docs/en/errors.md#login-expired)) |
| Lock de renovação preso | "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh…", categoria `server_error` (e não `authentication_failed`) | não verificado | **documentado** ([errors](https://code.claude.com/docs/en/errors.md#could-not-refresh-your-login-because-another-claude-code-process-is-refreshing-it)) |
| Disco cheio | `system/session_writes_lost` com `error_code: "ENOSPC"`/`"EDQUOT"` | — | **documentado** (tipo em `sdk.d.ts`) |
| `SIGTERM` no meio | os deltas continuam ~0,7 s; **nenhum `result`** | 143 | **medido**; **documentado** ([headless, Stop a run with SIGTERM](https://code.claude.com/docs/en/headless.md)) |
| `SIGKILL` no meio | nenhum `result` | 137 | **medido** |
| `SIGINT` no meio | `result` com `subtype: "error_during_execution"`, `is_error: true`, `terminal_reason: "aborted_streaming"` | **0** | **medido** |
| Fim do stdin (`--input-format stream-json`) | termina o turno em curso inteiro, `result` normal | 0 | **medido** |

### Processo travado sem saída

- Enquanto espera a API, o processo **não escreve nada** no stdout. Os únicos sinais são os `api_retry` entre tentativas. **medido**.
- Com os padrões, o silêncio pode ser longo. Sem cabeçalhos de resposta, a primeira tentativa espera o prazo do primeiro byte (por padrão o watchdog de bytes, 180 s na API direta) e a nova tentativa espera `API_TIMEOUT_MS` − 1 s (≈ 10 min). Depois disso, "No response from API". **documentado** ([errors, No response from API](https://code.claude.com/docs/en/errors.md#no-response-from-api); [network-config, Streaming idle watchdogs](https://code.claude.com/docs/en/network-config.md)). Em falha de conexão TCP, cada tentativa levou exatamente `API_TIMEOUT_MS` (**medido** com 15 s). Com o padrão de 600 s × 11 tentativas, isso chega a perto de 2 h. É uma conta, **não medido**.
- Depois que a resposta começa, quatro watchdogs abortam um stream parado: o de eventos (300 s), o de bytes (180 s na API direta), o do corpo ocioso e o do primeiro byte. Todos dá para ajustar por variável de ambiente (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`, entre 10 s e 30 min). **documentado** ([network-config](https://code.claude.com/docs/en/network-config.md)).
- O protocolo de controle tem `keep_alive` ("the CLI emits it periodically, for example while a long-running control request is in progress"). **documentado** (`SDKKeepAliveMessage` em `sdk.d.ts`). Ele não apareceu no `-p` com `stream-json` durante a espera. **medido**. Não serve de batimento cardíaco.
- Issues abertas mostram buracos no contrato:
  - [#103820](https://github.com/anthropics/claude-code/issues/103820): no limite semanal, o processo saiu com 1 **sem** `rate_limit_event`, sem `assistant.error` e sem `result` no stdout. A mensagem ficou só no transcript. Antes, ficou 23,5 min sem escrever nada. **não verificado** (relato, v2.1.303–2.1.310).
  - [#103253](https://github.com/anthropics/claude-code/issues/103253): um `rate_limit_event` que chega **depois** do `result` faz `--output-format json`/`text` sair com 1 e "No messages returned from query". Com `stream-json` isso não acontece. **não verificado** (relato). Nas medições, o `rate_limit_event` veio depois do `message_stop` e antes do `result`.

### O que sobra quando o servidor reinicia no meio

- O SDK roda o Claude Code como subprocesso, falando por stdio, um processo por sessão. **documentado** ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting.md)). Reiniciar o container mata o processo. O turno fica sem `result`, como no `SIGTERM`/`SIGKILL` acima. **medido** (por sinal; reinício de container **não medido**).
- Fica no disco o transcript `$CLAUDE_CONFIG_DIR/projects/<cwd-codificado>/<session-id>.jsonl` até a última linha gravada, se a sessão persistir (`persistSession`, padrão `true`). **documentado** ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md)). Ao retomar, o turno interrompido fica como está e o próximo prompt conduz a conversa. Com `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, o turno é continuado; `resume_reason` marca os quadros dessa continuação. **documentado** ([headless](https://code.claude.com/docs/en/headless.md); [env-vars](https://code.claude.com/docs/en/env-vars.md)).
- Pode ficar também um `.oauth_refresh.lock` na pasta, se o processo morreu no meio de uma renovação. Ver o item 7: o pior caso é perder o refresh token girado.
- O Shearim não recebe nenhum aviso. O estado "em andamento" de uma execução sem processo vivo precisa ser resolvido do lado do Shearim, ao subir.

## 2. Como saber que a Conta está no limite e quando volta

- **Durante a execução**: o stream traz `rate_limit_event` "when rate limit info changes", com `status` (`allowed` | `allowed_warning` | `rejected`), `resetsAt` (epoch em segundos), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`…), `utilization`, e campos de uso extra (`overageStatus`, `isUsingOverage`, `overageDisabledReason`). **documentado** (`SDKRateLimitInfo` em `sdk.d.ts`; [SDK TS reference](https://code.claude.com/docs/en/agent-sdk/typescript.md)).
- Exemplo real (**medido**, uma vez por processo, depois do `message_stop` e antes do `result`):
  ```json
  {"status":"allowed","resetsAt":1795482000,"rateLimitType":"five_hour","overageStatus":"rejected",
   "overageDisabledReason":"org_level_disabled","isUsingOverage":false,
   "unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":1795482000,"status":"allowed"},
                     "seven_day":{"utilization":0.29,"resetsAt":1795906800,"status":"allowed"}}}
  ```
  `unifiedWindows` veio no JSON, mas **não está nos tipos** publicados. **medido**. No processo longo, o evento saiu só no primeiro turno. **medido**.
- Esses valores vêm de cabeçalhos de resposta `anthropic-ratelimit-unified-status`, `-reset`, `-representative-claim`, `-overage-status`, `-overage-disabled-reason`. **não verificado** (citados na [#104690](https://github.com/anthropics/claude-code/issues/104690); não há doc pública desses cabeçalhos para assinatura).
- **No limite**: "You've hit your session limit · resets 3:45pm" (também weekly, Opus, Sonnet). O limite de sessão e o semanal valem para todos os modelos; o de Opus/Sonnet só para a família. **documentado** ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)). Antes de acabar, aparece um aviso em 85% e um `allowed_warning`. **documentado** (mesma página; tipo).
- **Antes da execução, sem gastar modelo**: `claude -p "/usage"` responde em ~3 s, com custo 0 e `num_turns: 0`, e traz o texto "Current session: 12% used · resets Nov 23 at 10pm", "Current week (all models): 30% used…", "Current week (Fable): 18%…". É texto para humanos, no fuso local. **medido**. Comandos como `/usage` mandados como prompt voltam como `SDKAssistantMessage`. **documentado** ([SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript.md)).
- Na mesma consulta, `/usage` disse 12% e o `rate_limit_event` de minutos antes disse 0,1. Não sei se são escalas ou momentos diferentes. **medido** / causa **não verificada**.
- Forma estruturada pelo SDK: `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` devolve `rate_limits.limits[]` com `kind`, `percent` e `resets_at`. O nome avisa que pode mudar. **documentado** (`sdk.d.ts`).
- O limite é **do plano** e vale para claude.ai, Claude Code e IDEs juntos. Pro e Max têm janela de 5 h e semanal; Max e Ultra têm também uma semanal de Fable; Ultra verificado não tem janela de 5 h. **documentado** ([support 11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)). O uso da própria pessoa no claude.ai, fora do Shearim, gasta a mesma cota.
- **Uso extra (usage credits)**: se o dono ligou, a Conta não para no limite, passa a gastar créditos pagos (`isUsingOverage`, `overageStatus`). **documentado** (mesma página; tipos). Uma `rejected` com `errorCode: "credits_required"` quer dizer que a cota acabou e só volta com compra de créditos. **documentado** ([SDK TS, SDKRateLimitEvent](https://code.claude.com/docs/en/agent-sdk/typescript.md)).
- Relatos de que o bloqueio dispara um pouco antes de 100% ([#64885](https://github.com/anthropics/claude-code/issues/64885), em 95%). **não verificado**.
- O modo "esperar o reset" (`CLAUDE_CODE_RETRY_WATCHDOG=1`) segura a requisição até o limite voltar. Numa assinatura sem uso extra, ele falha na hora por um bug de classificação ([#104690](https://github.com/anthropics/claude-code/issues/104690), aberta). **documentado** ([errors, Tune retry behavior](https://code.claude.com/docs/en/errors.md#tune-retry-behavior)) / bug **não verificado**.

## 3. Quantas execuções simultâneas uma assinatura aguenta

- Não há número publicado de concorrência para assinatura. A doc de limites de API (RPM/ITPM/OTPM) vale para chaves do Console. **documentado por ausência** ([rate-limits](https://platform.claude.com/docs/en/api/rate-limits.md); [costs](https://code.claude.com/docs/en/costs.md); [errors](https://code.claude.com/docs/en/errors.md)).
- 4 execuções em paralelo na mesma assinatura e na mesma pasta de config: todas ok, sem `api_retry`, TTFT 1,18–1,31 s (iguais às sequenciais). **medido**. Não tentei mais que 4, por regra.
- Ao passar do que o servidor aceita, o sintoma relatado é "Server is temporarily limiting requests (not your usage limit)": ~10 sessões disparadas de uma vez, as 3–4 primeiras passam e as outras falham ([#53922](https://github.com/anthropics/claude-code/issues/53922), fechada por inatividade, v2.1.119). **não verificado**. Desde v2.1.199, esse 429 sem cabeçalhos de cota é retentado sozinho com backoff. **documentado** ([errors, Automatic retries](https://code.claude.com/docs/en/errors.md#automatic-retries)).
- A concorrência gasta a cota mais depressa ("A single burst of heavy activity … can exhaust the weekly allowance"). **documentado** ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)).
- O limite no host é a memória: um processo por sessão. A doc sugere 1 GiB, 1 CPU por agente como ponto de partida. **documentado** ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting.md)). Medido: ~249 MB de RSS por processo vivo, ocioso entre turnos, sem tools nem MCP. **medido**.

## 4. Manter uma sessão viva por pessoa

Dá, de três jeitos.

- **Processo longo com `--input-format stream-json`** (no SDK: `prompt` como `AsyncIterable<SDKUserMessage>`). A doc recomenda esse modo para chat e manda esperar o `result` de uma mensagem antes de mandar a próxima. **documentado** ([streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md)). Medido com 3 mensagens num processo só: o contexto se manteve (lembrou a "palavra secreta"), o mesmo `session_id` nos três turnos, TTFT de 823 ms e 844 ms nos turnos 2 e 3, RSS estável em 249 MB, e `total_cost_usd` acumulado entre turnos. **medido**.
  - Um `system/init` sai a cada turno. **medido**.
  - Mensagens enviadas perto umas das outras podem virar **um turno só** (`user_message_uuids`), e o `result` traz `queued_turn_count`. **documentado** (`sdk.d.ts`).
- **Um processo por mensagem com `resume`** (`--resume <id>` / `options.resume`). Medido: o 2º processo lembrou o contexto, manteve o `session_id`, TTFT de 1,1 s e 1,9 s de parede. **medido**. O arquivo da sessão precisa estar na mesma máquina, em `$CLAUDE_CONFIG_DIR/projects/`; o `cwd` entra na chave. **documentado** ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md)).
- **Pré-aquecimento**: `startup()` adianta o spawn de um `query()` conhecido, e `prewarm()` (alpha) deixa um processo reserva "parked", que ocupa 230–260 MB, para dar `claim()` depois. **documentado** (`sdk.d.ts`). Os dois herdam o `env` de quando nasceram, então uma reserva serve a uma pasta de Conta só. É inferência do que o `claim` aceita. **não verificado**.
- `close()` mata o subprocesso; o SDK fecha o stdin antes do sinal para o CLI encerrar limpo. **documentado** (`sdk.d.ts`). Encerrar fechando o stdin deixa o turno em curso terminar (**medido**, item 1).

## 5. A resposta chega em pedaços?

- **Caminho A**: sim. Com `--include-partial-messages` (SDK: `includePartialMessages: true`), chegam eventos `stream_event` que embrulham os eventos SSE da Messages API (`message_start`, `content_block_delta` com `text_delta`, `message_stop`). Depois vem a mensagem `assistant` completa. **documentado** ([streaming-output](https://code.claude.com/docs/en/agent-sdk/streaming-output.md)) e **medido**: 20 a 24 deltas para contar até 30, espalhados por ~0,5 s, com pedaços de 2 a 20 caracteres.
- Sem a flag, só chega a mensagem `assistant` inteira por bloco. **documentado** (mesma página).
- **Caminho B**: sim, com `"stream": true` (SSE). Os eventos são `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` e `ping`. Um erro pode chegar **depois do 200**, como evento `error` (por exemplo `overloaded_error`). **documentado** ([streaming](https://platform.claude.com/docs/en/build-with-claude/streaming.md); [errors](https://platform.claude.com/docs/en/api/errors.md)). Não testado, por falta de chave. **não verificado** na prática.
- Nos dois caminhos o formato do pedaço é o mesmo evento da Messages API, então o código que desenha a resposta pode ser um só. **documentado** (o `SDKPartialAssistantMessage.event` é `BetaRawMessageStreamEvent`).

## 6. Tempo até a primeira palavra (secundário)

Medido do `spawn` até o primeiro `text_delta`, Haiku, prompt curto, sem tools, sem settings do usuário, sem MCP (seção 9):

| Cenário | TTFT | Observação |
|---|---|---|
| Processo novo, sequencial (4 rodadas) | 1,71 / 1,22 / 1,15 / 1,06 s | `init` sai ~0,6–0,9 s após o spawn; o processo sai ~0,7 s após o `result` |
| Processo novo, 4 em paralelo | 1,18 / 1,19 / 1,25 / 1,31 s | sem degradação |
| Processo longo, turnos 2 e 3 (do envio) | 0,82 / 0,84 s | economiza o spawn |
| Processo novo com `--resume` | 1,1 s (`ttft_ms` do CLI) | 1,9 s de parede |
| Um caso fora da curva | ~7 s até o 5º delta | numa rodada do teste de `SIGINT`; causa não investigada |

- O `result` traz as próprias medidas: `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms` (73 ms numa rodada) e `duration_api_ms`. **medido**; campos **documentados** em `sdk.d.ts`.
- Caminho B: sem medição (sem chave). **não verificado**. A Messages API não tem o custo de subir um processo.

## 7. Execuções simultâneas na mesma pasta disputam a renovação do login?

**Sim, a renovação é compartilhada e protegida por um lock entre processos. O mecanismo tem modos de falha conhecidos e abertos.**

- O login fica em `$CLAUDE_CONFIG_DIR/.credentials.json` (modo 0600) no Linux. No macOS fica no Keychain, numa entrada própria por `CLAUDE_CONFIG_DIR`. **documentado** ([authentication, credential management](https://code.claude.com/docs/en/authentication.md)). Todas as execuções de um Membro leem e gravam o mesmo arquivo.
- Para renovar, o processo pega um lock por diretório (`mkdir`, via proper-lockfile) em `<configDir>/.oauth_refresh.lock`, com `stale: 60000` e `update: 5000`, e relê a credencial depois de pegar o lock (se outro processo já renovou, usa a nova: `tengu_oauth_token_refresh_race_resolved`). **medido** (strings do binário 2.1.331: `lockfilePath:dp(e,".oauth_refresh.lock"),realpath:!1,stale:60000,update:5000`). A doc confirma "the shared refresh lock" e a mensagem de quem esperou e desistiu. **documentado** ([errors](https://code.claude.com/docs/en/errors.md#could-not-refresh-your-login-because-another-claude-code-process-is-refreshing-it)).
- O refresh token gira a cada uso: quem manda o token antigo leva `invalid_grant`. Relatos dizem que o access token dura ~8 h e cada processo tenta renovar nos 5 min antes de vencer. **não verificado** (código citado em [#91708](https://github.com/anthropics/claude-code/issues/91708) e logs em [#102985](https://github.com/anthropics/claude-code/issues/102985)).
- Modos de falha relatados, todos em issues abertas e **não verificados** aqui:
  - **Processo morto no meio da renovação** ([#102985](https://github.com/anthropics/claude-code/issues/102985), Linux headless, ~10 sessões stream-json + `-p` curtos): o POST gira o token no servidor, o processo morre antes de gravar, o próximo manda o token velho, leva `invalid_grant` e **apaga a credencial do arquivo para todos**. Os logouts pararam quando eles deixaram de matar (SIGTERM, timeout de 20–30 s) processos que usavam a credencial compartilhada.
  - **Lock que sobra e não é recuperado** ([#95236](https://github.com/anthropics/claude-code/issues/95236), Windows, e um comentário com o mesmo sintoma num sandbox Linux): todo `claude -p` falha até alguém apagar o diretório vazio. O paliativo citado é `find "$CLAUDE_CONFIG_DIR" -maxdepth 1 -name .oauth_refresh.lock -type d -empty -mmin +1 -exec rmdir {} \;`.
  - **Lock com data no futuro** depois que o relógio voltou ([#95739](https://github.com/anthropics/claude-code/issues/95739)): bloqueia até o tempo real passar a mtime.
- Nas medições, 4 execuções paralelas na mesma pasta não deram erro. Mas não houve renovação nesse intervalo, então isso **não prova nada** sobre a disputa. **medido** / **inconclusivo**.
- Jeitos de evitar sem copiar a pasta (inferências do mecanismo acima, **não verificados**):
  1. **Não matar processos à força.** Encerrar fechando o stdin, com `interrupt()` ou com `SIGINT`, e só depois mandar sinal. O `SIGTERM`/`SIGKILL` por timeout do vigia é exatamente o gatilho da #102985.
  2. **Poucos processos por pasta.** Uma sessão viva por Membro (item 4), ou uma fila que serializa as execuções de cada Conta, reduz quem disputa a janela de renovação.
  3. **Volume local** para as pastas. O lock depende de `mkdir` atômico e de mtime; em volume de rede, o comportamento é **não verificado**.
  4. **Relógio estável** no container (sem saltos para trás), por causa da #95739.
  5. **Limpar lock órfão** ao subir o servidor, só se estiver vazio e mais velho que 60 s.
- Fato vizinho que pesa no ADR 0005: **o login tem fim**. A cadeia de renovação tem uma data final, que "renewing the access token does not move"; o `result` traz `credential_expires_at`, e `claude auth status --text` mostra "Sign-in ends: between … and …". "Using Claude Code doesn't extend the login". **documentado** ([authentication, Check when a stored login ends](https://code.claude.com/docs/en/authentication.md); `credential_expires_at` em `sdk.d.ts`). Na máquina medida: "Sign-in ends: between 2026-12-09 and 2026-12-12". **medido**. A doc chama a data de "a 30-day estimate" quando o servidor não manda uma. O ADR 0005 diz que "o login se renova sozinho; não existe o vencimento de um ano". A segunda parte está certa, mas existe um vencimento, de semanas. Depois dele, a mensagem é "this login reached its time limit" (`authentication_failed`).

## 8. Implicações para o desenho

Sem decidir nada: isto é o que os fatos acima impõem à fila, ao vigia e à troca para a Chave.

- **O vigia não pode confiar no stdout para saber se está vivo.** Um processo esperando a API fica em silêncio por minutos (até ~13 min sem cabeçalhos, até ~2 h em falha de conexão com os padrões). Ele precisa de prazo próprio, ou de baixar `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES` e `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` para caber no tempo que o Andamento tolera. Os `api_retry` servem para mostrar "tentando de novo (n/m)".
- **O jeito de matar importa.** Matar à força por timeout é o gatilho conhecido para perder o login de todas as execuções da pasta (item 7). O caminho limpo é fechar o stdin ou dar `interrupt()`/`SIGINT` (que devolve `result` com `aborted_streaming` e exit 0), e só no fim um sinal.
- **A classificação precisa ser defensiva.** Usar `is_error` + `assistant.error` + `terminal_reason`, nunca o `subtype` nem só o exit code (o `SIGINT` sai com 0 e `is_error: true`). Tratar "saiu sem `result`" como falha própria (sinal, reinício, ou a #103820 no limite semanal). Usar `stream-json` sempre (a #103253 quebra `json`/`text`).
- **A troca para a Chave tem gatilhos distintos:** `rate_limit_event.status == "rejected"` ou `assistant.error == "rate_limit"` (Conta no limite, com `resetsAt` para mostrar "volta às HH:MM"); `authentication_failed` (Precisa ligar de novo); o lock preso (`server_error` com o texto de refresh), que não é falha de login e talvez mereça nova tentativa antes de ir para a Chave. O throttle do servidor e o 529 não dizem nada sobre a Conta.
- **"No limite até HH:MM" dá para saber antes**, sem gastar modelo, com `/usage` (texto) ou com a API experimental do SDK. O `rate_limit_event` de cada execução também atualiza o estado. Os dois podem divergir um pouco, e o uso que a pessoa faz no claude.ai mexe na mesma cota.
- **Uso extra ligado muda o significado de "limite".** A Conta passa a gastar dinheiro da pessoa em vez de parar. Isso aparece em `isUsingOverage`/`overageStatus`.
- **A fila por Conta tem dois motivos para existir:** a cota da assinatura (a concorrência gasta mais rápido; burst de ~10 já foi relatado como throttle) e o lock de renovação da pasta. Em memória, cada processo custa ~250 MB.
- **Sessão viva por pessoa funciona** e economiza ~0,2–0,9 s por mensagem. Em troca, cada Membro ativo ocupa ~250 MB e o processo precisa de reciclagem. O `resume` por mensagem é a alternativa sem processo residente; depende do transcript na pasta da Conta e do mesmo `cwd`.
- **Reinício do servidor** deixa execuções sem `result` e talvez um lock órfão. A reconciliação ao subir é do Shearim (marcar a falha visível ou retomar com `resume` + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`).
- **O ADR 0005 precisa saber que o login vence** (item 7): haverá um "Precisa ligar de novo" previsível, a cada poucas semanas por Membro, que dá para avisar com antecedência por `credential_expires_at`.
- **O streaming é o mesmo evento nos dois caminhos.** Uma só camada de desenho da resposta serve à Conta e à Chave.

## 9. Experimentos

Todos em uma pasta temporária, com o login já existente da pasta padrão (nenhum `CLAUDE_CONFIG_DIR` novo, nenhum `auth login`/`logout`/`setup-token`, nenhum arquivo de credencial lido). Ao todo, ~20 chamadas ao Haiku, cerca de US$ 0,02 estimado pelo `total_cost_usd`.

Comando-base, chamado por um script Bun que carimba cada linha do stdout com o tempo desde o `spawn`:

```sh
claude -p "Conte de 1 a 30 por extenso, separados por virgula. Sem mais nada." \
  --model haiku --tools "" \
  --output-format stream-json --verbose --include-partial-messages \
  --no-session-persistence --setting-sources "" --strict-mcp-config
```

- **TTFT e streaming** (itens 5 e 6): o comando acima, 4× em sequência e depois 4× em paralelo (`for i in 1 2 3 4; do bun run1.ts par$i & done; wait`).
- **Processo longo** (item 4): o mesmo sem prompt e com `--input-format stream-json`. No stdin, `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null,"session_id":""}` por linha, a próxima só depois do `result` da anterior. RSS lido com `ps -o rss= -p <pid>`.
- **Resume** (item 4): `claude -p "Guarde a palavra secreta: jabuticaba..." --session-id <uuid> --output-format json`, depois `claude -p "Qual era a palavra secreta?" --resume <uuid> --output-format json`.
- **Modelo inválido** (item 1): `--model claude-nao-existe-9`.
- **Sinais** (item 1): prompt de 400 palavras; no 5º `text_delta`, `proc.kill("SIGTERM" | "SIGKILL" | "SIGINT")`, ou fechamento do stdin no modo `stream-json`.
- **Rede** (item 1): `ANTHROPIC_BASE_URL=http://127.0.0.1:9` (porta fechada) e `ANTHROPIC_BASE_URL=http://10.255.255.1` (não roteável), com `CLAUDE_CODE_MAX_RETRIES=2 API_TIMEOUT_MS=15000`. Em nenhum dos dois a conexão se estabelece, então nenhum cabeçalho sai da máquina.
- **Uso do plano** (item 2): `claude -p "/usage" --setting-sources "" --strict-mcp-config --no-session-persistence --output-format stream-json --verbose`.
- **Fim do login** (item 7): `claude auth status --text`, lendo só a linha `Sign-in ends`.
- **Lock** (item 7): `strings -n 12 ~/.local/share/claude/versions/2.1.331 | rg -o '.{0,160}oauth_refresh\.lock.{0,200}'`.
- **Tipos do SDK**: `npm pack @anthropic-ai/claude-agent-sdk` (0.3.331) e leitura de `package/sdk.d.ts` (`SDKMessage`, `SDKRateLimitInfo`, `SDKAPIRetryMessage`, `SDKResultSuccess`, `TerminalReason`, `startup`, `prewarm`).

O que ficou de fora de propósito: forçar o limite da assinatura, passar de 4 processos paralelos, provocar uma renovação concorrente e qualquer chamada à Messages API com chave.

## 10. Ferramentas pelo endpoint MCP do Shearim (#46, 2026-11-24)

Smoke do #46 (Spec #44, "Não medido"), **medido** em macOS arm64 com o binário **2.1.331** (o da imagem, `~/.local/share/claude/versions/2.1.331`) e repetido no 2.1.332, `--model haiku` (`claude-haiku-5-5`), login da pasta padrão. O servidor era o `createMcpEndpoint()` de `apps/server/src/tools/mcp.ts` com uma sessão aberta e uma Ferramenta `listar_agentes` falsa. Linha de comando: a do cérebro da Conta (`--tools ""`, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `stream-json` com parciais) mais `--mcp-config '<JSON>' --allowedTools mcp__shearim`. Três chamadas, ~US$ 0,001.

- **Funciona em `-p`, sem pergunta de permissão.** O `--mcp-config` aceita o JSON inline com `{"type":"http","url":"http://127.0.0.1:<porta>/mcp/<id>","headers":{"Authorization":"Bearer <token>"}}` (streamable HTTP, respostas em JSON, `GET` com 405). Com `--tools ""`, as tools nativas somem e só a do MCP fica: o `system/init` traz `tools: ["mcp__shearim__listar_agentes"]` e `mcp_servers: [{"name":"shearim","status":"connected","source":"dynamic"}]`. O `--allowedTools mcp__shearim` libera a Ferramenta: o `result` vem com `permission_denials: []`.
- **Os blocos de tool no `stream-json`:**
  - `stream_event` `content_block_start` com `{"type":"tool_use","id":"toolu_…","name":"mcp__shearim__listar_agentes","input":{},"caller":{"type":"direct"}}`, um `input_json_delta` (vazio sem argumentos), a linha `assistant` com o mesmo bloco, `content_block_stop`, `message_delta` com `stop_reason: "tool_use"` e `message_stop`.
  - Depois da chamada, uma linha `user` com o `tool_result`. No sucesso, `{"tool_use_id","type":"tool_result","content":[{"type":"text","text":"…"}]}`. Na falha (`isError: true` do MCP), `{"type":"tool_result","content":"<texto>","is_error":true,"tool_use_id"}`: o conteúdo vem como texto, não em blocos.
  - O turno seguinte começa com outro `message_start`. `num_turns` conta os turnos (2 com uma chamada), e `total_cost_usd`/`usage` do `result` são o total.
- **Falha de Ferramenta não derruba a resposta.** Com o `isError`, o modelo tentou de novo uma vez e respondeu dizendo que não conseguiu (`is_error: false`, 3 turnos). O teto de turnos (#53) vale também aqui.
- **Não medido aqui:** o `SIGINT` no meio de uma chamada MCP (o caminho do Pedido de aprovação, #50) e o servidor recusando o token no meio da execução.
