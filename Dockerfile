# Imagem do app do Regents (ADR 0008: o app fica num container próprio, sem root).
# O servidor roda o TypeScript direto com o Bun; o PWA vai já buildado em apps/web/dist.
ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
# Claude Code fixado na imagem (Spec, módulo 7; ADR 0006): o parse do `stream-json` depende da
# versão. Trocar de versão é mudar esta linha e repetir o smoke manual da execução pela Conta.
ARG CLAUDE_CODE_VERSION=2.1.331

# O binário `claude` da versão fixada, pelo instalador oficial (que confere o checksum).
FROM ${BUN_IMAGE} AS claude
ARG CLAUDE_CODE_VERSION
ENV DISABLE_AUTOUPDATER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && cp -L /root/.local/bin/claude /usr/local/bin/claude \
 && /usr/local/bin/claude --version | grep -F "${CLAUDE_CODE_VERSION}"

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN bun run build

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile --production

FROM ${BUN_IMAGE}
# O cliente do Postgres na mesma versão major do servidor do compose (18): o `pg_dump` dos backups
# e do dump de antes de migrar, e o `pg_restore` do `restore <arquivo>` (#38). Vem do repositório
# oficial do PostgreSQL (o Debian da imagem só tem versões mais velhas, e um pg_dump mais velho que
# o servidor se recusa a rodar).
# /backups e /data/contas nascem do usuário `bun`: um volume nomeado vazio herda o dono da pasta
# da imagem; sem ela, o Docker o cria como root e o app (sem root) não grava nada ali.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" >/etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && install -d -o bun -g bun -m 700 /backups /data/contas
WORKDIR /app
# A versão que a seção Instalação mostra (o CI passa a tag da imagem).
ARG REGENTS_VERSION=local
ENV REGENTS_VERSION=${REGENTS_VERSION}
# `DISABLE_AUTOUPDATER=1`: o Claude Code nunca se atualiza sozinho (o Regents também o passa a
# cada processo, no `env` montado do zero).
ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    REGENTS_CLAUDE_BIN=/usr/local/bin/claude \
    REGENTS_IDENTITY=tailnet \
    TS_SOCKET=/var/run/tailscale/tailscaled.sock \
    HOST=0.0.0.0 \
    PORT=3000 \
    REGENTS_BACKUPS_DIR=/backups
COPY --from=claude /usr/local/bin/claude /usr/local/bin/claude
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
# Não root: assim a LocalAPI do tailscaled só dá leitura (whois), nunca escrita (ADR 0007).
USER bun
EXPOSE 3000
# `docker compose run --rm app migrate`, `docker compose run --rm app restore <arquivo>` e, no
# serviço `backup` do compose, `backup` (o pg_dump noturno).
ENTRYPOINT ["bun", "/app/apps/server/src/main.ts"]
CMD ["serve"]
