# Imagem do app do Shearim (ADR 0008: o app fica num container próprio, sem root).
# O servidor roda o TypeScript direto com o Bun; o PWA vai já buildado em apps/web/dist.
ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

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
WORKDIR /app
ENV NODE_ENV=production \
    SHEARIM_IDENTITY=tailnet \
    TS_SOCKET=/var/run/tailscale/tailscaled.sock \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
# Não root: assim a LocalAPI do tailscaled só dá leitura (whois), nunca escrita (ADR 0007).
USER bun
EXPOSE 3000
# `docker compose run --rm app migrate` (e, no #38, `restore <arquivo>`).
ENTRYPOINT ["bun", "/app/apps/server/src/main.ts"]
CMD ["serve"]
