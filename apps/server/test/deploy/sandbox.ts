/**
 * Caixa de areia dos scripts de `deploy/` (instalador, atualização, empacotamento da release).
 *
 * O script roda de verdade (`/bin/sh`), mas com um PATH fechado: os dublês de comando que o teste
 * escreve (`docker`, `gh`, `brew`, `colima`, `launchctl`, `pmset`, `uname`, `sudo`...) e uma lista
 * curta de utilitários inofensivos (sed, grep, tar...). Qualquer outro comando dá "not found": nada
 * de verdade é instalado, iniciado ou mudado na máquina. HOME, TMPDIR e as pastas de apps do Mac
 * ficam dentro da caixa.
 *
 * Cada dublê anota a chamada em `calls()` ("docker compose up -d") e roda o corpo que o teste deu,
 * com `$STATE` (uma pasta para o estado entre chamadas) e `$LOG`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onCleanup } from "../harness";

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");

// Inofensivos e necessários aos scripts. Tudo que mexe na máquina (docker, gh, brew, sudo,
// launchctl, pmset, caffeinate, open, systemctl, curl, sleep, uname...) só existe como dublê.
const SAFE_TOOLS = [
  "sh",
  "cat",
  "sed",
  "grep",
  "tr",
  "od",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "touch",
  "tail",
  "head",
  "mktemp",
  "tar",
  "gzip",
  "dirname",
  "basename",
  "ln",
  "stat",
  "wc",
  "cut",
  "tee",
  "env",
  "ls",
  "test",
  "[",
  "expr",
  "sort",
  "id",
  "openssl",
  "find",
  "awk",
  "cmp",
  "printf",
];

export type Sandbox = {
  root: string;
  home: string;
  state: string;
  /** Escreve um dublê de comando: `body` é shell, roda depois de anotar a chamada. */
  fake(name: string, body?: string): void;
  /** As chamadas aos dublês, em ordem ("gh auth status", "docker compose pull"...). */
  calls(): string[];
  run(script: string, args?: string[], opts?: RunOptions): Promise<RunResult>;
};

export type RunOptions = {
  env?: Record<string, string>;
  /** O que a pessoa responde no terminal, uma linha por pergunta. Sem: não há terminal. */
  answers?: string[];
  cwd?: string;
};

export type RunResult = { code: number; stdout: string; stderr: string; output: string };

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "shearim-deploy-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const sys = join(root, "sys");
  const home = join(root, "home");
  const state = join(root, "state");
  const tmp = join(root, "tmp");
  const log = join(root, "calls.log");
  for (const dir of [bin, sys, home, state, tmp, join(root, "Applications")]) mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");

  for (const tool of SAFE_TOOLS) {
    const real = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
    if (real) symlinkSync(real, join(sys, tool));
  }

  return {
    root,
    home,
    state,
    fake(name, body = "") {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>"$LOG"\n${body}\n`);
      chmodSync(file, 0o755);
    },
    calls() {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.trimEnd());
    },
    async run(script, args = [], opts = {}) {
      let tty = "/dev/null";
      if (opts.answers) {
        tty = join(root, `answers-${Date.now()}-${Math.random()}`);
        writeFileSync(tty, opts.answers.map((a) => `${a}\n`).join(""));
      }
      const proc = Bun.spawn(["/bin/sh", script, ...args], {
        cwd: opts.cwd ?? root,
        env: {
          PATH: `${bin}:${sys}`,
          HOME: home,
          TMPDIR: tmp,
          USER: "quem-instala",
          LOG: log,
          STATE: state,
          // Onde o instalador procuraria o Docker e os apps no Mac: só dentro da caixa.
          SHEARIM_EXTRA_PATH: join(root, "extra-bin"),
          SHEARIM_APPLICATIONS: join(root, "Applications"),
          SHEARIM_TTY: tty,
          SHEARIM_WAIT_SECONDS: "1",
          ...opts.env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr, output: stdout + stderr };
    },
  };
}
