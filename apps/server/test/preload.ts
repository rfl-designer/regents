import { afterEach } from "bun:test";
import { runCleanups } from "./harness";

// O timeout de 30 s vem do script `bun run test` (`--timeout 30000`):
// no Bun 1.3.11, `setDefaultTimeout` no preload não vale para os arquivos de teste.

afterEach(runCleanups);
