import { afterEach } from "bun:test";
import { runCleanups } from "./harness";

// O timeout de 30 s vem do script `bun run test` (`--timeout 30000`):
// no Bun 1.3.11, `setDefaultTimeout` no preload não vale para os arquivos de teste.

// Fechar o que o teste abriu (PGlite, processos, servidores) passa dos 5 s padrão do hook com a
// máquina carregada.
afterEach(runCleanups, 30_000);
