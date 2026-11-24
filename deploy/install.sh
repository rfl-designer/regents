#!/bin/sh
# Instalador de uma linha do Shearim (Spec, histórias 1 a 6 e 8; módulo 13). Em Mac ou Linux, com
# o `gh` autenticado numa conta com acesso ao repositório:
#
#   gh release download --repo rfl-designer/shearim --pattern install.sh --output - | sh
#
# O que faz, nesta ordem:
# 1. Confere o `gh` (logado, com a permissão read:packages para baixar a imagem do GHCR).
# 2. Garante o Docker. No Linux: o Docker Engine e o Compose (pelo script oficial, depois de
#    perguntar). No Mac: o Docker que existe (Docker Desktop, OrbStack ou Colima) ou, depois de
#    perguntar, o Colima pelo Homebrew.
# 3. Baixa o compose da release em ~/shearim (--dir muda) e faz `docker login ghcr.io` com o token do gh.
# 4. Roda o deploy/setup.sh: pede só a auth key do Tailscale e um e-mail, gera os segredos e confere
#    MagicDNS e HTTPS.
# 5. `docker compose pull` e `docker compose up -d`, e espera o app responder.
# 6. No Mac, instala o LaunchAgent que não deixa o Mac dormir enquanto o Docker está de pé (caffeinate -i).
# 7. Imprime o checklist "Mantê-lo rodando", com o que o terminal conseguiu verificar marcado.
#
# Pode rodar de novo: nunca troca um segredo nem o .env. Opções:
#   --dir <pasta>      onde fica a Instalação (padrão: ~/shearim)
#   --version <tag>    a release (padrão: a deste instalador; sem ela, a última)
#   --yes              instala ou inicia o Docker sem perguntar
#   --update           atualiza uma Instalação (é o que o deploy/update.sh roda)
#
# Tudo fica dentro de main, chamada na última linha: um download pela metade não roda nada, e a
# atualização pode trocar este arquivo enquanto ele roda.

# Várias funções só são chamadas por wait_until, yes_if e mac_start, que o shellcheck não segue.
# shellcheck disable=SC2329

# Preenchido pelo deploy/release.sh com a tag da release.
RELEASE_TAG=""

main() {
  set -eu
  REPO=${SHEARIM_REPO:-rfl-designer/shearim}
  ASSET=shearim-compose.tar.gz
  LABEL=com.shearim.acordado
  TTY=${SHEARIM_TTY:-/dev/tty}
  WAIT_SECONDS=${SHEARIM_WAIT_SECONDS:-180}
  DIR=$HOME/shearim
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

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/shearim-install.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT

  OS=$(uname -s)
  case "$OS" in
    Darwin | Linux) ;;
    *) fail "o Shearim instala em Mac ou Linux, e este computador é $OS." ;;
  esac

  if [ "$MODE" = update ]; then
    update
    return
  fi

  need_gh
  need_answers
  ensure_docker
  download
  ghcr_login
  run_setup
  if [ "$SETUP_OK" = 1 ]; then start_shearim; fi
  if [ "$OS" = Darwin ]; then keep_awake; fi
  checklist

  if [ "$SETUP_OK" = 0 ]; then
    say ""
    say "O setup parou (veja acima). Depois de consertar, rode de novo: sh $DIR/deploy/install.sh"
    return 1
  fi
  if [ "$HEALTHY" = 0 ]; then
    say ""
    say "O Shearim não respondeu em $WAIT_SECONDS s. Veja 'cd $DIR && docker compose logs app'."
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
    fail "$DIR não parece uma Instalação do Shearim (falta compose.yaml ou .env). Para instalar, rode o instalador."
  # A tag gravada neste instalador é a da versão de agora: sem --version, a atualização vai para a última.
  if [ "$TAG_GIVEN" = 0 ]; then TAG=""; fi
  need_gh
  ensure_docker
  cd "$DIR"
  from=$(compose_version)

  mkdir -p "$WORK/antes"
  cp -R compose.yaml deploy "$WORK/antes/"
  download
  if ! docker compose config -q; then
    rm -rf compose.yaml deploy
    cp -R "$WORK/antes/compose.yaml" "$WORK/antes/deploy" .
    fail "o compose da $TAG não fecha com o seu .env (veja acima). Voltei o compose de antes; nada foi reiniciado."
  fi
  pinned=$(sed -n 's/^SHEARIM_VERSION=//p' .env | tail -n 1)
  if [ -n "$pinned" ]; then
    say "AVISO: o .env fixa SHEARIM_VERSION=$pinned: sobe essa versão, não a da release. Apague a linha para seguir as releases."
  fi

  ghcr_login
  start_shearim
  if [ "$HEALTHY" = 0 ]; then
    fail "o Shearim não respondeu em $WAIT_SECONDS s depois de atualizar. Veja 'docker compose logs app'."
  fi
  say "ok: Shearim atualizado de $from para $(compose_version)"
}

# A versão que o compose sobe por padrão (a da release).
compose_version() { sed -n 's/.*SHEARIM_VERSION:-\([^}]*\)}.*/\1/p' compose.yaml | head -n 1; }

say() { printf '%s\n' "$*"; }
fail() {
  printf 'shearim install: %s\n' "$*" >&2
  exit 1
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

need_gh() {
  command -v gh >/dev/null 2>&1 ||
    fail "falta o gh (GitHub CLI): https://cli.github.com. Depois, 'gh auth login' e rode de novo."
  status=$(gh auth status 2>&1) ||
    fail "o gh não está logado. Rode 'gh auth login' (numa conta com acesso a $REPO) e rode de novo."
  # A imagem do GHCR pede read:packages, que o `gh auth login` não dá por padrão. (Um token sem a
  # linha "Token scopes", como um fine-grained, passa: o docker pull diz se faltar.)
  case "$status" in
    *"Token scopes:"*packages*) ;;
    *"Token scopes:"*)
      say "O gh precisa da permissão read:packages para baixar a imagem do Shearim do GHCR."
      gh auth refresh -h github.com -s read:packages <&3 ||
        fail "rode 'gh auth refresh -h github.com -s read:packages' e rode de novo."
      ;;
  esac
  say "ok: gh logado"
}

# Sem terminal, o setup não tem a quem perguntar a auth key e o e-mail: só pelas variáveis (ou o que
# uma instalação anterior já gravou).
need_answers() {
  [ "$TTY" = /dev/null ] || return 0
  missing=""
  if [ -z "${TS_AUTHKEY:-}" ] && [ ! -s "$DIR/secrets/ts_authkey" ]; then missing="TS_AUTHKEY=tskey-auth-..."; fi
  if [ -z "${SHEARIM_CONTACT_EMAIL:-}" ] && ! grep -q '^SHEARIM_VAPID_CONTACT=.' "$DIR/.env" 2>/dev/null; then
    missing="${missing:+$missing }SHEARIM_CONTACT_EMAIL=voce@exemplo.com"
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
  extra=${SHEARIM_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin}
  if [ -n "$extra" ]; then PATH=$PATH:$extra; fi
  export PATH
  APPS=${SHEARIM_APPLICATIONS:-/Applications:$HOME/Applications}

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
    fail "o Shearim roda no Docker, e o $name não está rodando. Abra o $name e rode de novo (--yes inicia sem perguntar)."
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
    fail "o Shearim roda no Docker, e este Mac não tem um. Instale o Docker Desktop, OrbStack ou Colima e rode de novo (ou responda sim para o instalador instalar o Colima; --yes não pergunta)."
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
      fail "o Shearim roda no Docker. Instale o Docker Engine (https://docs.docker.com/engine/install/) e rode de novo, ou responda sim para o instalador instalar (--yes não pergunta)."
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

download() {
  if [ -z "$TAG" ]; then
    TAG=$(gh release view --repo "$REPO" --json tagName --jq .tagName) ||
      fail "não consegui descobrir a última release de $REPO (o gh tem acesso ao repositório?)."
  fi
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$WORK" --clobber >/dev/null ||
    fail "não consegui baixar o $ASSET da release $TAG de $REPO."
  mkdir -p "$DIR"
  tar -xzf "$WORK/$ASSET" -C "$DIR"
  say "ok: release $TAG em $DIR"
}

ghcr_login() {
  user=$(gh api user --jq .login) || fail "o gh não disse qual é a sua conta (gh api user)."
  gh auth token | docker login ghcr.io -u "$user" --password-stdin >/dev/null 2>&1 ||
    fail "o 'docker login ghcr.io' falhou com o token do gh."
  say "ok: docker login ghcr.io como $user"
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

start_shearim() {
  HEALTHY=0
  docker compose pull || fail "o 'docker compose pull' falhou (veja acima)."
  docker compose up -d || fail "o 'docker compose up -d' falhou (veja acima)."
  UP=1
  say "Esperando o Shearim responder..."
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
<!-- Instalado pelo instalador do Shearim: o Mac não dorme enquanto o Docker está de pé. -->
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
  item "${HEALTHY:-0}" "O Shearim respondeu" "cd $DIR && docker compose ps"
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
