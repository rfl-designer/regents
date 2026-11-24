/**
 * Helper de teste do `fake-claude`: cria a pasta do dublê, o wrapper executável
 * `<pasta>/bin/claude` (o "caminho do binário" que o app recebe) e dá acesso ao
 * roteiro e ao log de chamadas.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FAKE_ACCOUNT,
  FAKE_ACCESS_TOKEN,
  type FakeAccount,
  type FakeClaudeCall,
  type FakeClaudeScript,
  type FakeClaudeSignal,
} from "./script";

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
  /** Os sinais que os `-p` levaram, em ordem (de um só processo, com `pid`). */
  signals(pid?: number): FakeClaudeSignal[];
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
    signals(pid) {
      const log = join(home, "signals.jsonl");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeClaudeSignal)
        .filter((s) => pid === undefined || s.pid === pid);
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

/**
 * Deixa `configDir` "logada", como o `auth login` do dublê deixaria: para testar o `claude -p`
 * de uma Conta sem passar pelo fluxo de ligar.
 */
export function fakeLogin(configDir: string, account: Partial<FakeAccount> = {}) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS_TOKEN } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { ...DEFAULT_FAKE_ACCOUNT, ...account } }),
  );
}
