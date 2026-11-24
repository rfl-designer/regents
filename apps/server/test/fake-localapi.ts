/**
 * LocalAPI falsa do tailscaled num Unix socket de verdade, para o teste de contrato
 * do adaptador `whois` (ticket #37). Responde `GET /localapi/v0/whois?addr=<ip>` com as
 * respostas gravadas em `test/fixtures/localapi/`; IP sem resposta dá o 404 da LocalAPI. Também
 * responde `GET /localapi/v0/status` (o vencimento da chave do nó, #38) com o que o teste mandar.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCleanup } from "./harness";

/** Uma resposta gravada da LocalAPI (`whois-membro`, `whois-sharee`, `whois-tag`). */
export function recordedWhois(name: "whois-membro" | "whois-sharee" | "whois-tag"): string {
  return readFileSync(join(import.meta.dir, "fixtures/localapi", `${name}.json`), "utf8");
}

/** Um `GET /localapi/v0/status` gravado: o nó com vencimento da chave, ou com ele desligado. */
export function recordedStatus(name: "status-com-vencimento" | "status-sem-vencimento"): string {
  return readFileSync(join(import.meta.dir, "fixtures/localapi", `${name}.json`), "utf8");
}

export interface FakeLocalApi {
  socketPath: string;
  /** Cada chamada recebida, na ordem: o `addr` pedido e o `Host` usado. */
  calls: { addr: string | null; host: string | null }[];
  /** Responde a esse IP com este corpo (status 200) ou com outro status. */
  answer(ip: string, body: string, status?: number): void;
  /** O que `GET /localapi/v0/status` responde daqui em diante (sem isto, 404). */
  status(body: string, status?: number): void;
  stop(): void;
}

export function fakeLocalApi(): FakeLocalApi {
  // Caminho curto: Unix sockets têm limite de ~104 bytes no macOS.
  const socketPath = join(mkdtempSync(join(tmpdir(), "ts-")), "tailscaled.sock");
  const answers = new Map<string, { body: string; status: number }>();
  const calls: FakeLocalApi["calls"] = [];
  let statusAnswer: { body: string; status: number } | undefined;

  const server = Bun.serve({
    unix: socketPath,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/localapi/v0/status" && statusAnswer) {
        return new Response(statusAnswer.body, {
          status: statusAnswer.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname !== "/localapi/v0/whois") return new Response("not found\n", { status: 404 });
      const addr = url.searchParams.get("addr");
      calls.push({ addr, host: req.headers.get("host") });
      const a = addr ? answers.get(addr) : undefined;
      if (!a) return new Response("no match for IP:port\n", { status: 404 });
      return new Response(a.body, {
        status: a.status,
        headers: { "content-type": a.status === 200 ? "application/json" : "text/plain" },
      });
    },
  });
  const stop = () => server.stop(true);
  onCleanup(stop);

  return {
    socketPath,
    calls,
    answer: (ip, body, status = 200) => answers.set(ip, { body, status }),
    status: (body, status = 200) => {
      statusAnswer = { body, status };
    },
    stop,
  };
}
