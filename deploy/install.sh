#!/bin/sh
# Instalador de uma linha do Regents (Spec, histórias 1 a 6 e 8; módulo 13). Em Mac ou Linux:
#
#   curl -fsSL https://github.com/rfl-designer/regents/releases/latest/download/install.sh | sh
#
# As releases e a imagem no GHCR são públicas: não precisa de conta no GitHub. O que faz, nesta ordem:
# 1. Confere o `curl`.
# 2. Garante o Docker. No Linux: o Docker Engine e o Compose (pelo script oficial, depois de
#    perguntar). No Mac: o Docker que existe (Docker Desktop, OrbStack ou Colima) ou, depois de
#    perguntar, o Colima pelo Homebrew.
# 3. Baixa o compose da release em ~/regents (--dir muda).
# 4. Roda o deploy/setup.sh: pede só a auth key do Tailscale e um e-mail, gera os segredos e confere
#    MagicDNS e HTTPS.
# 5. `docker compose pull` e `docker compose up -d`, e espera o app responder.
# 6. No Mac, instala o LaunchAgent que não deixa o Mac dormir enquanto o Docker está de pé (caffeinate -i).
# 7. Imprime o checklist "Mantê-lo rodando", com o que o terminal conseguiu verificar marcado.
#
# Pode rodar de novo: nunca troca um segredo nem o .env. Opções:
#   --dir <pasta>      onde fica a Instalação (padrão: ~/regents)
#   --version <tag>    a release (padrão: a deste instalador; sem ela, a última)
#   --yes              instala ou inicia o Docker sem perguntar
#   --update           atualiza uma Instalação (é o que o deploy/update.sh roda); numa Instalação
#                      que ainda é Shearim, faz antes a migração do nome (veja o README)
#
# Tudo fica dentro de main, chamada na última linha: um download pela metade não roda nada, e a
# atualização pode trocar este arquivo enquanto ele roda.

# Várias funções só são chamadas por wait_until, yes_if e mac_start, que o shellcheck não segue.
# shellcheck disable=SC2329

# Preenchido pelo deploy/release.sh com a tag da release.
RELEASE_TAG=""

main() {
  set -eu
  REPO=${REGENTS_REPO:-rfl-designer/regents}
  RELEASES=https://github.com/$REPO/releases
  ASSET=regents-compose.tar.gz
  LABEL=com.regents.acordado
  TTY=${REGENTS_TTY:-/dev/tty}
  WAIT_SECONDS=${REGENTS_WAIT_SECONDS:-180}
  DIR=$HOME/regents
  TAG=$RELEASE_TAG
  TAG_GIVEN=0
  YES=0
  MODE=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ $# -gt 1 ] || fail "--dir precisa de uma pasta."
        DIR=$2
        shift
        ;;
      --version)
        [ $# -gt 1 ] || fail "--version precisa de uma tag, como v1.2.3."
        TAG=$2
        TAG_GIVEN=1
        shift
        ;;
      --yes | -y) YES=1 ;;
      --update) MODE=update ;;
      *) fail "não conheço a opção $1 (veja o começo do deploy/install.sh)." ;;
    esac
    shift
  done
  case "$DIR" in /*) ;; *) DIR=$(pwd)/$DIR ;; esac
  # Num `| sh`, o stdin é o próprio script: as perguntas vão pelo terminal (fd 3).
  if ! (exec <"$TTY") 2>/dev/null; then TTY=/dev/null; fi
  exec 3<"$TTY"

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/regents-install.XXXXXX")
  trap on_exit EXIT

  OS=$(uname -s)
  case "$OS" in
    Darwin | Linux) ;;
    *) fail "o Regents instala em Mac ou Linux, e este computador é $OS." ;;
  esac

  if [ "$MODE" = update ]; then
    update
    return
  fi

  need_curl
  need_answers
  ensure_docker
  download
  run_setup
  if [ "$SETUP_OK" = 1 ]; then start_regents; fi
  if [ "$OS" = Darwin ]; then keep_awake; fi
  checklist

  if [ "$SETUP_OK" = 0 ]; then
    say ""
    say "O setup parou (veja acima). Depois de consertar, rode de novo: sh $DIR/deploy/install.sh"
    return 1
  fi
  if [ "$HEALTHY" = 0 ]; then
    say ""
    say "O Regents não respondeu em $WAIT_SECONDS s. Veja 'cd $DIR && docker compose logs app'."
    return 1
  fi
  say ""
  say "Pronto: abra $URL. A primeira pessoa a abrir entra como Admin."
  say "Para atualizar: sh $DIR/deploy/update.sh"
}

ensure_docker() {
  if [ "$OS" = Darwin ]; then
    mac_docker
    docker compose version >/dev/null 2>&1 ||
      fail "falta o 'docker compose' (plugin Compose v2). Com o Homebrew: brew install docker-compose, e rode de novo."
  else
    linux_docker
    linux_compose
  fi
}

update() {
  [ -f "$DIR/compose.yaml" ] && [ -f "$DIR/.env" ] ||
    fail "$DIR não parece uma Instalação do Regents (falta compose.yaml ou .env). Para instalar, rode o instalador."
  # A tag gravada neste instalador é a da versão de agora: sem --version, a atualização vai para a última.
  if [ "$TAG_GIVEN" = 0 ]; then TAG=""; fi
  need_curl
  ensure_docker
  cd "$DIR"
  from=$(compose_version)

  mkdir -p "$WORK/antes"
  cp -R compose.yaml deploy "$WORK/antes/"
  if still_shearim; then
    rename_installation
    return
  fi
  download
  if ! docker compose config -q; then
    rm -rf compose.yaml deploy
    cp -R "$WORK/antes/compose.yaml" "$WORK/antes/deploy" .
    fail "o compose da $TAG não fecha com o seu .env (veja acima). Voltei o compose de antes; nada foi reiniciado."
  fi
  warn_pinned

  start_regents
  if [ "$HEALTHY" = 0 ]; then
    fail "o Regents não respondeu em $WAIT_SECONDS s depois de atualizar. Veja 'docker compose logs app'."
  fi
  say "ok: Regents atualizado de $from para $(compose_version)"
}

warn_pinned() {
  pinned=$(sed -n 's/^REGENTS_VERSION=//p' .env | tail -n 1)
  if [ -n "$pinned" ]; then
    say "AVISO: o .env fixa REGENTS_VERSION=$pinned: sobe essa versão, não a da release. Apague a linha para seguir as releases."
  fi
}

# Os volumes do projeto do Compose que a migração do nome copia.
VOLUMES="ts-state ts-socket pgdata contas"
# O compose e o deploy/ do Shearim, guardados enquanto a migração do nome não termina.
ANTES=.migracao-regents/antes

# Uma Instalação que ainda é Shearim: uma migração do nome que não terminou (a pasta
# .migracao-regents), o .env só com SHEARIM_*, ou o banco só no volume do projeto shearim. Sem
# nenhum dos três, a atualização é a de sempre.
still_shearim() {
  if [ -d .migracao-regents ]; then return 0; fi
  if grep -q '^SHEARIM_' .env && ! grep -q '^REGENTS_' .env; then return 0; fi
  docker volume inspect shearim_pgdata >/dev/null 2>&1 && ! docker volume inspect regents_pgdata >/dev/null 2>&1
}

# O compose do projeto shearim, com o .env de antes (o .env.shearim, depois que o .env mudou) e os
# caminhos da pasta.
shearim_compose() {
  env=.env
  if [ -f .env.shearim ]; then env=.env.shearim; fi
  docker compose --project-directory "$DIR" --env-file "$DIR/$env" -f "$DIR/$ANTES/compose.yaml" "$@"
}

# A migração do nome (spec #96), uma vez: a Instalação Shearim passa a ser Regents com os mesmos
# dados e a mesma URL. Cada passo pode rodar de novo, e uma execução interrompida continua de onde
# parou: o compose e o deploy/ do Shearim, o backup e os volumes já copiados ficam em
# .migracao-regents/, e o .env novo sai sempre do .env.shearim, o .env de antes. Uma falha volta
# tudo para o Shearim (rename_failed).
rename_installation() {
  old_host=$(sed -n 's/^TS_HOSTNAME=//p' .env | tail -n 1)
  old_host=${old_host:-shearim}
  say ""
  say "Esta Instalação ainda é Shearim. A atualização faz a migração do nome, uma vez:"
  say "  muda: o .env passa de SHEARIM_* para REGENTS_* (o de antes fica em .env.shearim)"
  say "  muda: os volumes shearim_* são copiados para regents_* (shearim_pgdata para regents_pgdata,"
  say "        e também ts-state, ts-socket e contas); os shearim_* ficam como estão"
  say "  muda: o projeto do Compose passa de shearim para o projeto regents, depois de um backup"
  say "  fica: o hostname $old_host e a URL, a tag tag:shearim e o papel e o banco shearim do Postgres"
  say "  fica: a pasta $DIR"
  agree "Fazer a migração do nome agora?" ||
    fail "Nada mudou. A migração do nome precisa do seu sim: rode num terminal, ou com --yes para não perguntar."
  mkdir -p .migracao-regents
  if [ ! -d "$ANTES" ]; then
    rm -rf "$ANTES.partial"
    mkdir "$ANTES.partial"
    cp -R compose.yaml deploy "$ANTES.partial/"
    mv "$ANTES.partial" "$ANTES"
  fi
  from=$(compose_version "$ANTES/compose.yaml")
  # Daqui até o app novo responder, toda saída com erro (um fail ou um comando que falha com o
  # set -e) passa pela volta para o Shearim: on_exit chama rename_failed.
  RENAMING=1
  download
  backup_shearim
  shearim_compose down || fail "o 'docker compose down' do projeto shearim falhou (veja acima)."
  copy_volumes
  rename_env
  docker compose config -q || fail "o compose da $TAG não fecha com o .env novo (veja acima)."
  warn_pinned
  if [ "$OS" = Darwin ]; then rename_keep_awake; fi
  start_regents
  if [ "$HEALTHY" = 0 ]; then
    fail "o Regents não respondeu em $WAIT_SECONDS s. Veja 'docker compose logs app'."
  fi
  RENAMING=0
  rm -rf .migracao-regents
  say "ok: o Shearim $from agora é o Regents $(compose_version)"
  say ""
  say "Os volumes do Shearim ficaram como estavam, para voltar se algo der errado:$OLD_VOLUMES"
  say "Quando o Regents estiver bem, apague-os para liberar o disco:"
  say "  docker volume rm$OLD_VOLUMES"
  say ""
  say "O hostname ($old_host) e a tag (tag:shearim) ficaram os de antes, e a URL é a mesma. Para trocar,"
  say "mude TS_HOSTNAME (e REGENTS_TAILNET_TAG, que também vai para os tagOwners da tailnet) no"
  say "$DIR/.env e rode 'docker compose up -d'. A URL muda, e param: o app na Tela de Início (instale"
  say "de novo), as notificações push (cada aparelho liga de novo) e o GitHub App da Instalação (a URL"
  say "de callback é a antiga). Veja \"Migração do nome\" no README."
}

# Uma migração que falhou antes de o app novo responder (ADR 0003: o Shearim de pé, com o motivo):
# o projeto regents sai, o compose, o deploy/ e o .env de antes voltam e o projeto shearim sobe com
# os volumes shearim_*. Os volumes regents_* ficam, e a próxima tentativa os completa. O Shearim
# volta a escrever nos shearim_*, então o backup e as cópias desta tentativa deixam de valer: a
# próxima faz de novo. Só on_exit a chama, uma vez, sem o set -e: cada passo da volta tenta, mesmo
# se o anterior falhou, e a mensagem diz o que voltou.
rename_failed() {
  # Os dois projetos juntos teriam o mesmo hostname na tailnet.
  if grep -q '^name: regents$' compose.yaml 2>/dev/null; then docker compose down >/dev/null 2>&1 || true; fi
  for mark in backup $VOLUMES; do rm -f ".migracao-regents/$mark"; done
  restored=1
  if ! { rm -rf compose.yaml deploy && cp -R "$ANTES/compose.yaml" "$ANTES/deploy" .; }; then restored=0; fi
  if [ -f .env.shearim ]; then
    # O .env pode ainda ser o de antes (a falha veio antes do .env novo): aí não há o que escrever.
    if cmp -s .env.shearim .env || cat .env.shearim >.env; then rm -f .env.shearim; else restored=0; fi
  fi
  if [ "$restored" = 1 ]; then
    back="Voltei o compose, o deploy/ e o .env de antes"
  else
    back="Não consegui voltar tudo (veja acima): o compose e o deploy/ do Shearim estão em $DIR/$ANTES, e o .env de antes em $DIR/.env.shearim"
  fi
  # O shearim_compose usa os de antes onde estiverem: o Shearim sobe mesmo se a volta não terminou.
  if shearim_compose up -d; then
    back="$back, e o Shearim subiu de novo com os volumes shearim_*."
  elif [ "$restored" = 1 ]; then
    back="$back, mas o Shearim não subiu (veja acima): rode 'cd $DIR && docker compose up -d'."
  else
    back="$back, e o Shearim também não subiu (veja acima)."
  fi
  printf 'regents install: a migração do nome parou: %s %s Os volumes regents_* ficaram; para tentar de novo, rode o instalador com --update outra vez.\n' \
    "$1" "$back" >&2
}

# No Mac, o LaunchAgent que não deixa o Mac dormir troca de nome: sai o do Shearim, entra o do Regents.
rename_keep_awake() {
  launchctl bootout "gui/$(id -u)/com.shearim.acordado" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/com.shearim.acordado.plist"
  keep_awake
  say "ok: no Mac, com.regents.acordado no lugar de com.shearim.acordado"
}

# O backup de antes da migração, com o Shearim ainda de pé: o pg_dump do Postgres da Instalação, no
# formato dos backups da noite, em ./backups (um pre-migracao, que a retenção não apaga). Numa
# execução depois de uma interrompida, o backup dela ainda vale: o Shearim não rodou desde então.
backup_shearim() {
  if [ -f .migracao-regents/backup ]; then return 0; fi
  file=backups/shearim-pre-migracao-$(date -u +%Y%m%dT%H%M%SZ).dump
  mkdir -p backups
  if ! shearim_compose exec -T postgres pg_dump -U shearim -d shearim --format=custom --no-owner --no-privileges \
    >"$file.partial"; then
    rm -f "$file.partial"
    fail "o backup de antes da migração falhou (veja acima). Nada foi parado."
  fi
  mv "$file.partial" "$file"
  touch .migracao-regents/backup
  say "ok: backup de antes da migração em $DIR/$file"
}

# Cada volume shearim_<nome> vai para regents_<nome>, com o mesmo dono e as mesmas permissões
# (cp -a como root, na imagem do Postgres que a Instalação já tem). O de origem não muda.
copy_volumes() {
  image=$(sed -n 's/^ *image: \(postgres:[^ ]*\)$/\1/p' compose.yaml | head -n 1)
  mkdir -p .migracao-regents
  OLD_VOLUMES=""
  for v in $VOLUMES; do
    docker volume inspect "shearim_$v" >/dev/null 2>&1 || continue
    OLD_VOLUMES="$OLD_VOLUMES shearim_$v"
    if [ -f ".migracao-regents/$v" ] && docker volume inspect "regents_$v" >/dev/null 2>&1; then continue; fi
    docker volume inspect "regents_$v" >/dev/null 2>&1 ||
      docker volume create --label com.docker.compose.project=regents --label "com.docker.compose.volume=$v" \
        "regents_$v" >/dev/null || fail "não consegui criar o volume regents_$v."
    docker run --rm -v "shearim_$v:/antigo:ro" -v "regents_$v:/novo" "$image" \
      sh -c 'rm -rf /novo/* /novo/.[!.]* /novo/..?* && cp -a /antigo/. /novo/' ||
      fail "não consegui copiar o volume shearim_$v para regents_$v."
    touch ".migracao-regents/$v"
    say "ok: volume shearim_$v copiado para regents_$v"
  done
}

# O .env novo, a partir do de antes (guardado em .env.shearim): cada SHEARIM_<sufixo> vira
# REGENTS_<sufixo> com o mesmo valor (se as duas existem, fica a REGENTS_), e entram o hostname, a
# tag e o papel e o banco do Postgres do Shearim, que o compose novo lê do .env.
rename_env() {
  # Pelo .partial: uma interrupção no meio não deixa um .env.shearim pela metade.
  if [ ! -f .env.shearim ]; then
    cp -p .env .env.shearim.partial
    mv .env.shearim.partial .env.shearim
  fi
  awk '
    NR == FNR { if (/^REGENTS_[A-Za-z0-9_]*=/) { key = $0; sub(/=.*/, "", key); have[key] = 1 }; next }
    /^SHEARIM_[A-Za-z0-9_]*=/ {
      key = "REGENTS_" substr($0, 9); sub(/=.*/, "", key)
      if (key in have) next
      $0 = "REGENTS_" substr($0, 9)
    }
    { print }
  ' .env.shearim .env.shearim >"$WORK/env"
  kept=""
  for line in TS_HOSTNAME=shearim REGENTS_TAILNET_TAG=tag:shearim REGENTS_POSTGRES_USER=shearim REGENTS_POSTGRES_DB=shearim; do
    grep -q "^${line%%=*}=" "$WORK/env" || kept="$kept$line
"
  done
  if [ -n "$kept" ]; then
    printf '\n# Do Shearim: o hostname e a tag (a URL não muda) e o papel e o banco do Postgres. Veja o README.\n%s' \
      "$kept" >>"$WORK/env"
  fi
  # Por cima, para o .env manter o dono e as permissões.
  cat "$WORK/env" >.env
  say "ok: .env com REGENTS_* (o de antes está em $DIR/.env.shearim)"
}

# A versão que o compose (o da pasta, ou o arquivo dado) sobe por padrão: a da release. O prefixo
# não importa: o compose de uma Instalação que ainda é Shearim tem SHEARIM_VERSION.
compose_version() { sed -n 's/.*_VERSION:-\([^}]*\)}.*/\1/p' "${1:-compose.yaml}" | head -n 1; }

say() { printf '%s\n' "$*"; }
fail() {
  # No meio da migração do nome, o motivo vai para a volta (on_exit), que o mostra com o que voltou.
  if [ "${RENAMING:-0}" = 1 ]; then RENAME_REASON=$*; else printf 'regents install: %s\n' "$*" >&2; fi
  exit 1
}

# A saída do script, por onde for (o fim de main, um fail, um comando que falha com o set -e): no
# meio da migração do nome, volta para o Shearim antes de sair.
on_exit() {
  status=$?
  if [ "${RENAMING:-0}" = 1 ]; then
    RENAMING=0
    set +e
    rename_failed "${RENAME_REASON:-um comando falhou (veja acima).}"
    [ "$status" != 0 ] || status=1
  fi
  rm -rf "$WORK"
  exit "$status"
}

# wait_until COMANDO...: tenta a cada 2 s, até WAIT_SECONDS.
wait_until() {
  tries=$((WAIT_SECONDS / 2))
  [ "$tries" -gt 0 ] || tries=1
  while [ "$tries" -gt 0 ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    tries=$((tries - 1))
    [ "$tries" -eq 0 ] || sleep 2
  done
  return 1
}

# O `curl | sh` já tem o curl, mas o `sh install.sh` e a atualização podem não ter.
need_curl() {
  command -v curl >/dev/null 2>&1 ||
    fail "falta o curl. Instale o curl (no Linux: sudo apt-get install curl) e rode de novo."
}

# Sem terminal, o setup não tem a quem perguntar a auth key e o e-mail: só pelas variáveis (ou o que
# uma instalação anterior já gravou).
need_answers() {
  [ "$TTY" = /dev/null ] || return 0
  missing=""
  if [ -z "${TS_AUTHKEY:-}" ] && [ ! -s "$DIR/secrets/ts_authkey" ]; then missing="TS_AUTHKEY=tskey-auth-..."; fi
  if [ -z "${REGENTS_CONTACT_EMAIL:-}" ] && ! grep -q '^REGENTS_VAPID_CONTACT=.' "$DIR/.env" 2>/dev/null; then
    missing="${missing:+$missing }REGENTS_CONTACT_EMAIL=voce@exemplo.com"
  fi
  [ -z "$missing" ] ||
    fail "sem terminal para perguntar. Rode num terminal, ou passe $missing antes do sh."
}

docker_answers() { docker info >/dev/null 2>&1; }

# agree PERGUNTA: sim com --yes; senão pergunta no terminal. Sem terminal, é não.
agree() {
  if [ "$YES" = 1 ]; then return 0; fi
  [ "$TTY" != /dev/null ] || return 1
  printf '%s [s/N] ' "$1"
  answer=""
  IFS= read -r answer <&3 || true
  case "$answer" in s | S | sim | Sim | SIM | y | Y | yes) return 0 ;; *) return 1 ;; esac
}

has_app() {
  old_ifs=$IFS
  IFS=:
  for d in $APPS; do
    if [ -d "$d/$1.app" ]; then
      IFS=$old_ifs
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

mac_docker() {
  # Onde o Homebrew, o Docker Desktop e o OrbStack põem os comandos, que o PATH de um `| sh` nem
  # sempre tem.
  extra=${REGENTS_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin}
  if [ -n "$extra" ]; then PATH=$PATH:$extra; fi
  export PATH
  APPS=${REGENTS_APPLICATIONS:-/Applications:$HOME/Applications}

  if ! docker_answers; then
    if has_app OrbStack; then
      mac_start OrbStack open -a OrbStack
    elif has_app Docker; then
      mac_start "Docker Desktop" open -a Docker
    elif command -v colima >/dev/null 2>&1; then
      mac_start Colima colima_service
    elif command -v docker >/dev/null 2>&1; then
      fail "o Docker está neste Mac, mas não responde. Abra o Docker Desktop, o OrbStack ou o Colima e rode de novo."
    else
      install_colima
    fi
  fi
  RUNTIME=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || echo Docker)
  say "ok: Docker respondendo ($RUNTIME)"
}

# mac_start NOME COMANDO...: um Docker que está no Mac mas parado, iniciado depois de perguntar.
mac_start() {
  name=$1
  shift
  agree "O $name está neste Mac, mas parado. Iniciar agora?" ||
    fail "o Regents roda no Docker, e o $name não está rodando. Abra o $name e rode de novo (--yes inicia sem perguntar)."
  "$@" || fail "não consegui iniciar o $name."
  say "Esperando o $name responder..."
  wait_until docker_answers || fail "o $name não respondeu em $WAIT_SECONDS s. Abra o $name, espere e rode de novo."
}

# O Colima a cada login: pelo brew services, quando o Homebrew existe.
colima_service() {
  if command -v brew >/dev/null 2>&1; then brew services start colima; else colima start; fi
}

install_colima() {
  agree "Este Mac não tem Docker. Instalar o Colima (o Docker de código aberto, sem janela) com o Homebrew e deixá-lo subir a cada login?" ||
    fail "o Regents roda no Docker, e este Mac não tem um. Instale o Docker Desktop, OrbStack ou Colima e rode de novo (ou responda sim para o instalador instalar o Colima; --yes não pergunta)."
  command -v brew >/dev/null 2>&1 ||
    fail "para instalar o Colima falta o Homebrew: https://brew.sh (ou instale o Docker Desktop ou o OrbStack). Depois, rode de novo."
  brew install colima docker docker-compose || fail "o Homebrew não instalou o Colima (veja acima)."
  # O docker do Homebrew acha o Compose entre os plugins.
  plugins=${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins
  mkdir -p "$plugins"
  ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" "$plugins/docker-compose"
  brew services start colima || fail "não consegui iniciar o Colima (brew services start colima)."
  say "Esperando o Colima responder (a primeira vez demora)..."
  wait_until docker_answers || fail "o Colima não respondeu em $WAIT_SECONDS s. Veja 'colima status' e rode de novo."
  say "ok: Colima instalado e subindo a cada login"
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

docker_as_root() { as_root docker info >/dev/null 2>&1; }

linux_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    agree "Este computador não tem Docker. Instalar o Docker Engine e o Compose pelo script oficial (https://get.docker.com, com sudo)?" ||
      fail "o Regents roda no Docker. Instale o Docker Engine (https://docs.docker.com/engine/install/) e rode de novo, ou responda sim para o instalador instalar (--yes não pergunta)."
    curl -fsSL https://get.docker.com -o "$WORK/get-docker.sh" || fail "não consegui baixar https://get.docker.com."
    as_root sh "$WORK/get-docker.sh" || fail "o script oficial do Docker falhou (veja acima)."
    say "ok: Docker Engine instalado"
  fi
  if ! docker_answers && ! docker_as_root; then
    agree "O Docker está instalado, mas parado. Iniciar agora e a cada boot (systemctl enable --now docker)?" ||
      fail "o Docker não está rodando. Rode 'sudo systemctl enable --now docker' e rode de novo."
    as_root systemctl enable --now docker || fail "não consegui iniciar o Docker (systemctl enable --now docker)."
    wait_until docker_as_root || fail "o Docker não respondeu em $WAIT_SECONDS s. Veja 'sudo systemctl status docker'."
  fi
  if ! docker_answers; then
    # O Docker só responde com sudo: o seu usuário não está no grupo docker. Entra agora (vale na
    # próxima sessão) e, nesta, o docker roda com sudo.
    user=${USER:-$(id -un)}
    as_root usermod -aG docker "$user" || say "AVISO: não consegui pôr $user no grupo docker."
    real=$(command -v docker)
    mkdir -p "$WORK/bin"
    printf '#!/bin/sh\nexec sudo %s "$@"\n' "$real" >"$WORK/bin/docker"
    chmod 755 "$WORK/bin/docker"
    PATH=$WORK/bin:$PATH
    export PATH
    say "ok: $user no grupo docker (vale a partir da próxima sessão; nesta, o docker roda com sudo)"
  fi
  say "ok: Docker respondendo"
}

linux_compose() {
  if docker compose version >/dev/null 2>&1; then return 0; fi
  agree "Falta o Compose do Docker. Instalar o plugin docker-compose-plugin (com sudo)?" ||
    fail "falta o 'docker compose'. Instale o plugin (https://docs.docker.com/compose/install/linux/) e rode de novo."
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get install -y docker-compose-plugin || as_root apt-get install -y docker-compose-v2 || true
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y docker-compose-plugin || true
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y docker-compose-plugin || true
  fi
  docker compose version >/dev/null 2>&1 ||
    fail "não consegui instalar o Compose. Instale o plugin (https://docs.docker.com/compose/install/linux/) e rode de novo."
  say "ok: Compose instalado"
}

# Das releases públicas: a da tag, ou (sem tag) a última, cuja tag vem do compose que ela traz.
download() {
  if [ -n "$TAG" ]; then url=$RELEASES/download/$TAG/$ASSET; else url=$RELEASES/latest/download/$ASSET; fi
  curl -fsSL "$url" -o "$WORK/$ASSET" ||
    fail "não consegui baixar $url (veja acima)."
  mkdir -p "$DIR"
  tar -xzf "$WORK/$ASSET" -C "$DIR" || fail "não consegui abrir $ASSET, o compose da release (veja acima)."
  if [ -z "$TAG" ]; then TAG=v$(compose_version "$DIR/compose.yaml"); fi
  say "ok: release $TAG em $DIR"
}

run_setup() {
  cd "$DIR"
  : >"$WORK/setup.log"
  { sh deploy/setup.sh || echo "$?" >"$WORK/setup.failed"; } | tee "$WORK/setup.log"
  SETUP_OK=1
  if [ -f "$WORK/setup.failed" ]; then SETUP_OK=0; fi
  URL=https://$(sed -n 's/^ok: HTTPS ligado (\(.*\))$/\1/p' "$WORK/setup.log")
}

app_healthy() { [ "$(docker compose ps app --format '{{.Health}}' 2>/dev/null)" = healthy ]; }

start_regents() {
  HEALTHY=0
  docker compose pull || fail "o 'docker compose pull' falhou (veja acima)."
  docker compose up -d || fail "o 'docker compose up -d' falhou (veja acima)."
  UP=1
  say "Esperando o Regents responder..."
  if wait_until app_healthy; then HEALTHY=1; fi
}

# O LaunchAgent: enquanto o Docker responde, `caffeinate -i` segura o sono por 10 min, e de novo.
keep_awake() {
  plist=$HOME/Library/LaunchAgents/$LABEL.plist
  docker_bin=$(command -v docker)
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Instalado pelo instalador do Regents: o Mac não dorme enquanto o Docker está de pé. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>while :; do if '$docker_bin' info &gt;/dev/null 2&gt;&amp;1; then /usr/bin/caffeinate -i -t 600; else sleep 60; fi; done</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST
  uid=$(id -u)
  launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$plist" || say "AVISO: o launchctl não carregou $plist."
}

# item MARCADO TEXTO [COMO]: uma linha do checklist.
item() {
  if [ "$1" = 1 ]; then
    say "  [x] $2"
  else
    say "  [ ] $2"
    if [ -n "${3:-}" ]; then say "        $3"; fi
  fi
}

found() { grep -q "$1" "$WORK/setup.log" 2>/dev/null; }
yes_if() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

checklist() {
  say ""
  say "Mantê-lo rodando"
  if [ "$OS" = Darwin ]; then mac_checklist; else linux_checklist; fi
  item "${UP:-0}" "Os containers voltam sozinhos quando o Docker sobe (restart: unless-stopped)"
  item "$(yes_if found '^ok: MagicDNS ligado')" "MagicDNS ligado na tailnet" "https://login.tailscale.com/admin/dns"
  item "$(yes_if found '^ok: HTTPS ligado')" "HTTPS ligado na tailnet" "https://login.tailscale.com/admin/dns (\"Enable HTTPS\")"
  item "${HEALTHY:-0}" "O Regents respondeu" "cd $DIR && docker compose ps"
  item 0 "Uma cópia de ./backups e ./secrets fora deste computador" "o backup completo é $DIR/backups mais $DIR/secrets"
}

mac_checklist() {
  case "${RUNTIME:-}" in
    *"Docker Desktop"*)
      item "$(yes_if docker_desktop_autostarts)" "O Docker Desktop abre quando você entra no Mac" \
        "Docker Desktop › Settings › General › \"Start Docker Desktop when you sign in to your computer\""
      ;;
    *OrbStack*)
      item 0 "O OrbStack abre quando você entra no Mac" "OrbStack › Settings › \"Start at login\""
      ;;
    *)
      if command -v colima >/dev/null 2>&1; then
        item "$(yes_if colima_at_login)" "O Colima sobe quando você entra no Mac" "brew services start colima"
      else
        item 0 "O Docker sobe quando você entra no Mac" "configure no seu Docker para iniciar com a sessão"
      fi
      ;;
  esac
  item "$(yes_if launchctl print "gui/$(id -u)/$LABEL")" "O Mac não dorme com o Docker de pé" \
    "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$LABEL.plist"
  item "$(yes_if mac_autorestarts)" "O Mac liga sozinho depois de uma falta de luz" \
    "Ajustes do Sistema › Energia › \"Iniciar automaticamente após falta de energia\" (só em Macs de mesa)"
  item "$(yes_if defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser)" \
    "O Mac entra sozinho na sua sessão quando religa" \
    "Ajustes do Sistema › Usuários e Grupos › \"Iniciar sessão automaticamente\" (o Docker e o LaunchAgent só rodam com a sessão aberta; com o FileVault ligado a opção não existe)"
}

linux_checklist() {
  item "$(yes_if systemd_says docker enabled)" "O Docker sobe com o computador" "sudo systemctl enable docker"
  item "$(yes_if systemd_says sleep.target masked)" "O computador não suspende sozinho" \
    "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target (num notebook ou desktop)"
  item 0 "O computador liga sozinho depois de uma falta de luz" \
    "na BIOS/UEFI: \"Restore on AC Power Loss\" (ou \"AC Power Recovery\") em \"Power On\""
}

systemd_says() { [ "$(systemctl is-enabled "$1" 2>/dev/null)" = "$2" ]; }

docker_desktop_autostarts() {
  grep -qi '"autostart": *true' "$HOME/Library/Group Containers/group.com.docker/settings-store.json" \
    "$HOME/Library/Group Containers/group.com.docker/settings.json" 2>/dev/null
}
colima_at_login() { brew services list 2>/dev/null | grep -q '^colima  *started'; }
mac_autorestarts() { pmset -g 2>/dev/null | grep -q '^ *autorestart  *1'; }

main "$@"
exit $?
