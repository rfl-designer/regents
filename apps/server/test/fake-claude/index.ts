/**
 * Helper de teste do `fake-claude`: cria a pasta do dublê, o wrapper executável
 * `<pasta>/bin/claude` (o "caminho do binário" que o app recebe) e dá acesso ao
 * roteiro e ao log de chamadas.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeClaudeCall, FakeClaudeScript } from "./script";

export * from "./script";

const FAKE = new URL("./fake-claude.ts", import.meta.url).pathname;

export interface FakeClaude {
  /** Caminho do executável falso; vai em `deps.accounts.claudeBin`. */
  bin: string;
  /** Troca o roteiro. Vale a partir do próximo start do binário. */
  script(script: FakeClaudeScript): void;
  /** Todos os starts até agora, em ordem. */
  calls(): FakeClaudeCall[];
  /** Os starts de um subcomando: `"auth login"`, `"auth status"`, `"auth logout"` ou `"-p"`. */
  callsOf(kind: "auth login" | "auth status" | "auth logout" | "-p"): FakeClaudeCall[];
  dispose(): void;
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function fakeClaude(script: FakeClaudeScript = {}): FakeClaude {
  const home = mkdtempSync(join(tmpdir(), "fake-claude-"));
  mkdirSync(join(home, "bin"));
  const bin = join(home, "bin", "claude");
  writeFileSync(bin, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(FAKE)} --fake-home ${sh(home)} "$@"\n`);
  chmodSync(bin, 0o755);

  const fake: FakeClaude = {
    bin,
    script: (s) => writeFileSync(join(home, "script.json"), JSON.stringify(s)),
    calls() {
      const log = join(home, "calls.jsonl");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeClaudeCall);
    },
    callsOf(kind) {
      return fake.calls().filter((c) => {
        if (kind === "-p") return c.argv.includes("-p");
        const [a, b] = kind.split(" ");
        return c.argv[0] === a && c.argv[1] === b;
      });
    },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
  fake.script(script);
  return fake;
}
