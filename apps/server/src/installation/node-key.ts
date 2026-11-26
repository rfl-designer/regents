import type { NodeKeyDto } from "@regents/contracts";

/** De onde vem o vencimento da chave do nó da Instalação na tailnet. */
export interface NodeKeyPort {
  read(): Promise<NodeKeyDto>;
}

/** Host das chamadas à LocalAPI pelo socket (o mesmo do `whois`). */
const LOCALAPI_HOST = "local-tailscaled.sock";

/** Sem tailnet (o desenvolvimento): não há chave do nó para vencer. */
export const noNodeKey: NodeKeyPort = {
  read: async () => ({ kind: "unknown", reason: "sem tailnet (identidade de desenvolvimento)" }),
};

/**
 * O vencimento pela LocalAPI do tailscaled (`GET /localapi/v0/status`, `Self.KeyExpiry`), pelo
 * socket comum do sidecar; a leitura é o que o app (sem root) pode fazer. Sem `KeyExpiry` (ou com
 * a hora zero do Go), o vencimento está desligado, o que é o padrão de um nó com tag.
 */
export function localApiNodeKey(opts: { socketPath: string }): NodeKeyPort {
  return {
    async read() {
      let res: Response;
      let raw: string;
      try {
        res = await fetch(`http://${LOCALAPI_HOST}/localapi/v0/status`, {
          unix: opts.socketPath,
          signal: AbortSignal.timeout(5_000),
        });
        raw = await res.text();
      } catch (err) {
        return { kind: "unknown", reason: `não deu para falar com o tailscaled em ${opts.socketPath}: ${String(err)}` };
      }
      if (!res.ok) return { kind: "unknown", reason: `o status do tailscaled respondeu ${res.status}: ${raw.trim()}` };
      let expiry: unknown;
      try {
        expiry = (JSON.parse(raw) as { Self?: { KeyExpiry?: unknown } }).Self?.KeyExpiry;
      } catch {
        return { kind: "unknown", reason: "o status do tailscaled não é JSON" };
      }
      if (expiry === undefined || expiry === null) return { kind: "never" };
      const at = typeof expiry === "string" ? new Date(expiry) : new Date(Number.NaN);
      if (Number.isNaN(at.getTime())) return { kind: "unknown", reason: `KeyExpiry estranho: ${String(expiry)}` };
      // A hora zero do Go (0001-01-01) também quer dizer "não vence".
      if (at.getUTCFullYear() <= 1) return { kind: "never" };
      return { kind: "expires", expiresAt: at.toISOString() };
    },
  };
}
