#!/bin/sh
# Atualização do Regents (Spec, história 8). Na pasta da Instalação:
#
#   sh deploy/update.sh            a última release
#   sh deploy/update.sh v1.3.0     uma release em particular
#
# Baixa o compose da release pública com o `curl` (compose.yaml e deploy/ são trocados; o .env,
# ./secrets e ./backups ficam como estão), confere que o compose novo fecha com o .env e roda
# `docker compose pull && docker compose up -d`. Na subida, o app faz um dump antes
# de migrar. É o deploy/install.sh --update.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -gt 0 ]; then
  case "$1" in
    -*) ;;
    *)
      version=$1
      shift
      set -- --version "$version" "$@"
      ;;
  esac
fi
exec sh "$here/install.sh" --update --dir "$(dirname "$here")" "$@"
