import { afterEach, setDefaultTimeout } from "bun:test";
import { runCleanups } from "./harness";

// O primeiro teste do processo migra o template do PGlite (~0,6 s). Com vários arquivos, o Bun
// 1.3.11 não aplica isto ao primeiro arquivo (e, com a máquina carregada, nem sempre aos outros):
// o `bun run test` passa `--timeout 30000`, que vale para todos.
setDefaultTimeout(30_000);

// Fechar o que o teste abriu (PGlite, processos, servidores) passa dos 5 s padrão do hook com a
// máquina carregada.
afterEach(runCleanups, 30_000);
