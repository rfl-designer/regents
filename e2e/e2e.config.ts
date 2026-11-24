/**
 * e2e do PWA (Spec, "Testing Decisions": seam secundário, fino).
 *
 * O runner sobe o servidor de verdade servindo o build do PWA (`bun run build` antes),
 * com a identidade de dev e um PGlite em memória: cada execução começa de uma
 * Instalação vazia, e a primeira pessoa a abrir (a "Pessoa Dev") vira Admin.
 * `serve.ts` põe os dublês nas pontas: a Messages API falsa no lugar da Anthropic.
 */
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      engine: web({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" }),
      app: {
        url: "http://127.0.0.1:0",
        readyUrl: "http://127.0.0.1:{port}/api/health",
        command: {
          executable: "bun",
          args: ["serve.ts"],
          env: {
            SHEARIM_IDENTITY: "dev",
            HOST: "127.0.0.1",
            PORT: "{port}",
            SHEARIM_PGLITE_DIR: "memory://",
          },
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
