#!/bin/sh
# Setup da Instalação do Shearim (Spec, módulo 13; histórias 5 e 6).
#
# Pede só a auth key do Tailscale e um e-mail de contato. Gera a senha do Postgres e a
# chave mestra em ./secrets, sobe o sidecar e confere MagicDNS, HTTPS e a tag do nó,
# dizendo como consertar. Pode ser rodado de novo: nunca troca um segredo que já existe
# (trocar a chave mestra torna a Chave do Workspace ilegível).
#
# Sem perguntas (para o instalador, #39): TS_AUTHKEY=tskey-auth-... SHEARIM_CONTACT_EMAIL=...
#   deploy/setup.sh
# Só as conferências da tailnet:  deploy/setup.sh --check
set -eu

cd "$(dirname "$0")/.."
SECRETS=./secrets
ENV_FILE=./.env
TS_SOCKET=/var/run/tailscale/tailscaled.sock
TAG=tag:shearim

say() { printf '%s\n' "$*"; }
fail() {
  printf 'shearim setup: %s\n' "$*" >&2
  exit 1
}

need_docker() {
  command -v docker >/dev/null 2>&1 || fail "o Docker não está instalado (o instalador cuida disso)."
  docker compose version >/dev/null 2>&1 || fail "falta o 'docker compose' (plugin Compose v2)."
  docker info >/dev/null 2>&1 || fail "o Docker está instalado, mas não está rodando. Abra o Docker (ou 'colima start') e rode de novo."
}

# 32 bytes aleatórios em hex.
random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Escreve um segredo. A pasta ./secrets é 700 (só o dono entra); o arquivo é 644 porque o
# Docker monta cada segredo com as permissões do host, e quem lê dentro do container não é
# o seu usuário (o app roda como bun; o sidecar, como root sem capabilities).
write_secret() {
  umask 022
  printf '%s\n' "$2" >"$SECRETS/$1"
  chmod 644 "$SECRETS/$1"
}

ask() {
  # $1 = pergunta, $2 = "secreto" para não ecoar
  printf '%s ' "$1" >/dev/tty
  if [ "${2:-}" = secreto ]; then
    stty -echo </dev/tty
    IFS= read -r answer </dev/tty || answer=""
    stty echo </dev/tty
    printf '\n' >/dev/tty
  else
    IFS= read -r answer </dev/tty || answer=""
  fi
  printf '%s' "$answer"
}

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

set_env() {
  touch "$ENV_FILE"
  grep -v "^$1=" "$ENV_FILE" >"$ENV_FILE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

setup_secrets() {
  mkdir -p "$SECRETS"
  chmod 700 "$SECRETS"

  if [ ! -s "$SECRETS/ts_authkey" ]; then
    key="${TS_AUTHKEY:-}"
    if [ -z "$key" ]; then
      say "Crie uma auth key em https://login.tailscale.com/admin/settings/keys com a tag $TAG"
      say "(se a tag não existir, declare-a em tagOwners na política da tailnet)."
      key=$(ask "Auth key do Tailscale (tskey-auth-...):" secreto)
    fi
    case "$key" in
      tskey-*) write_secret ts_authkey "$key" ;;
      *) fail "isso não parece uma auth key do Tailscale (começa com tskey-)." ;;
    esac
    say "ok: auth key em $SECRETS/ts_authkey"
  fi

  for name in postgres_password master_key; do
    if [ ! -s "$SECRETS/$name" ]; then
      write_secret "$name" "$(random_secret)"
      say "ok: $name gerada em $SECRETS/$name"
    fi
  done

  if [ -z "$(env_value SHEARIM_VAPID_CONTACT)" ]; then
    email="${SHEARIM_CONTACT_EMAIL:-}"
    [ -n "$email" ] || email=$(ask "E-mail de contato (vai nas notificações push, para os serviços de push):")
    case "$email" in
      *@localhost | *@*.local) fail "o e-mail precisa de um domínio de verdade (a Apple recusa localhost)." ;;
      ?*@?*.?*) set_env SHEARIM_VAPID_CONTACT "mailto:$email" ;;
      *) fail "\"$email\" não parece um e-mail." ;;
    esac
    say "ok: contato $email em $ENV_FILE"
  fi
}

ts_status() {
  docker compose exec -T tailscale tailscale --socket="$TS_SOCKET" status --json 2>/dev/null
}

check_tailnet() {
  say "Subindo o sidecar do Tailscale e esperando ele entrar na tailnet..."
  docker compose up -d tailscale >/dev/null || fail "não consegui subir o sidecar. Veja 'docker compose logs tailscale'."

  status=""
  i=0
  while [ "$i" -lt 60 ]; do
    status=$(ts_status || true)
    case "$status" in *'"BackendState": "Running"'*) break ;; esac
    i=$((i + 1))
    sleep 2
  done
  case "$status" in
    *'"BackendState": "Running"'*) ;;
    *'"BackendState": "NeedsLogin"'*)
      fail "a auth key foi recusada (vencida, já usada ou sem permissão para $TAG). Crie outra, apague $SECRETS/ts_authkey e rode de novo."
      ;;
    *) fail "o sidecar não entrou na tailnet em 2 minutos. Veja 'docker compose logs tailscale'." ;;
  esac

  problems=0
  case "$status" in
    *'"MagicDNSEnabled": true'*) say "ok: MagicDNS ligado" ;;
    *)
      say "FALTA: MagicDNS está desligado. Ligue em https://login.tailscale.com/admin/dns (botão \"Enable MagicDNS\")."
      problems=$((problems + 1))
      ;;
  esac

  domain=$(printf '%s\n' "$status" | sed -n '/"CertDomains": \[/{n;s/^[^"]*"\([^"]*\)".*/\1/p;q;}')
  if [ -n "$domain" ]; then
    say "ok: HTTPS ligado ($domain)"
  else
    say "FALTA: os certificados HTTPS estão desligados. Ligue em https://login.tailscale.com/admin/dns (seção \"HTTPS Certificates\", \"Enable HTTPS\")."
    say "       Sem isso o Tailscale Serve não sobe e a URL não abre."
    problems=$((problems + 1))
  fi

  self_tags=$(printf '%s\n' "$status" | sed -n '/^  "Self": {/,/^  },*$/p' | grep -c "\"$TAG\"" || true)
  if [ "$self_tags" -gt 0 ]; then
    say "ok: o nó tem a tag $TAG"
  else
    say "FALTA: o nó não tem a tag $TAG. Crie a auth key com essa tag (o que sai da Instalação não pode herdar a identidade de uma pessoa)."
    problems=$((problems + 1))
  fi

  if [ "$problems" -gt 0 ]; then
    say ""
    say "Depois de consertar, rode 'deploy/setup.sh --check'."
    exit 1
  fi
  say ""
  say "Tudo certo. Suba o resto com 'docker compose up -d' e abra https://$domain"
  say "A primeira pessoa a abrir a URL entra como Admin."
}

need_docker
if [ "${1:-}" != "--check" ]; then
  setup_secrets
fi
check_tailnet
