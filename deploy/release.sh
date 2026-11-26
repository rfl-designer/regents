#!/bin/sh
# Empacota a release do Regents (Spec, módulo 13: "Imagem" e "Distribuição"). Roda no workflow de
# release (.github/workflows/release.yml), depois de publicar a imagem no GHCR com a mesma tag.
#
#   deploy/release.sh <versão> <pasta de saída>      versão como 1.2.3 (a tag do git é v1.2.3)
#
# Escreve na pasta:
# - regents-compose.tar.gz: compose.yaml e deploy/ (setup, instalador, atualização, serve.json), o
#   que o instalador e o deploy/update.sh baixam com o `curl`. No compose, a imagem do app e do backup
#   sai com a tag fixa da versão (nunca latest) e sem `build:` (quem instala não builda).
# - shearim-compose.tar.gz: uma cópia do mesmo pacote, com o nome que o updater antigo (de uma
#   Instalação que ainda é Shearim) baixa.
# - install.sh: o instalador de uma linha, que instala esta versão.
set -eu

fail() {
  printf 'regents release: %s\n' "$*" >&2
  exit 1
}

[ $# -eq 2 ] || fail "uso: deploy/release.sh <versão> <pasta de saída> (versão como 1.2.3)"
version=$1
out=$2
case "$version" in
  latest) fail "a versão não pode ser latest: a imagem sai sempre com tag fixa." ;;
  *[!0-9.]* | .* | *. | *..*) fail "\"$version\" não é uma versão como 1.2.3." ;;
esac
case "$version" in
  *.*.*) ;;
  *) fail "\"$version\" não é uma versão como 1.2.3." ;;
esac

cd "$(dirname "$0")/.."
stage=$(mktemp -d "${TMPDIR:-/tmp}/regents-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/deploy/tailscale" "$out"

sed -e "s/\${REGENTS_VERSION:-local}/\${REGENTS_VERSION:-$version}/g" -e '/^    build: \.$/d' \
  compose.yaml >"$stage/compose.yaml"
if grep -q -e ':-local}' -e '^ *build:' "$stage/compose.yaml"; then
  fail "o compose.yaml ainda tem a tag local ou um build: (mudou o formato da linha image:?)."
fi

sed "s/^RELEASE_TAG=\"\"/RELEASE_TAG=\"v$version\"/" deploy/install.sh >"$stage/deploy/install.sh"
grep -q "^RELEASE_TAG=\"v$version\"" "$stage/deploy/install.sh" ||
  fail "não achei a linha RELEASE_TAG=\"\" no deploy/install.sh."

cp deploy/setup.sh deploy/update.sh "$stage/deploy/"
cp deploy/tailscale/serve.json "$stage/deploy/tailscale/"
chmod 755 "$stage/deploy/"*.sh

COPYFILE_DISABLE=1 tar -czf "$out/regents-compose.tar.gz" -C "$stage" compose.yaml deploy
cp "$out/regents-compose.tar.gz" "$out/shearim-compose.tar.gz"
cp "$stage/deploy/install.sh" "$out/install.sh"
printf 'ok: %s/regents-compose.tar.gz e %s/install.sh (versão %s)\n' "$out" "$out" "$version"
