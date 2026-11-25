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
            // As pastas das Contas ficam com os resultados do e2e, não em .data/.
            SHEARIM_ACCOUNTS_DIR: ".e2e/contas",
            // O Pedido de aprovação expira em 45 s (0,0125 h), para o e2e ver a expiração.
            SHEARIM_APPROVAL_TTL_H: "0.0125",
          },
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
