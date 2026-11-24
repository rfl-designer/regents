import type { Clock } from "../clock";
import type { Identity, IdentityPort } from "./port";

/**
 * Host das chamadas à LocalAPI pelo socket. É o que o cliente Go do Tailscale usa;
 * o tailscaled confere o Host para barrar DNS rebinding.
 */
const LOCALAPI_HOST = "local-tailscaled.sock";

/** Forma do `apitype.WhoIsResponse` que o Shearim lê. */
interface WhoIsResponse {
  Node?: { Tags?: string[]; ComputedName?: string; Hostinfo?: { Hostname?: string; ShareeNode?: boolean } };
  UserProfile?: { ID?: number; LoginName?: string; DisplayName?: string; ProfilePicURL?: string };
}

/**
 * Não deu para perguntar ao tailscaled (socket ausente, LocalAPI com erro, resposta
 * estranha). É falha da Instalação, não "sem identidade": o app responde 503.
 */
export class IdentityUnavailableError extends Error {
  override name = "IdentityUnavailableError";
}

export interface WhoisIdentityOptions {
  /** Socket do tailscaled (o mesmo `TS_SOCKET` do sidecar), montado num volume comum. */
  socketPath: string;
  clock: Clock;
  /** Quanto dura a "sessão" de um peer: o tempo em que a resposta do whois vale (padrão 60 s). */
  sessionMs?: number;
}

export const WHOIS_SESSION_MS = 60_000;

/**
 * Identidade de verdade (Spec, módulo 1; ADRs 0007 e 0008): o Serve é o único proxy na
 * frente do app e põe no `X-Forwarded-For` o IP tailnet do peer; o app pergunta ao
 * tailscaled, pela LocalAPI `whois`, de quem é esse IP. O Membro é o `UserProfile.ID`.
 *
 * Os headers `Tailscale-User-*` do Serve não são lidos: login, nome e foto vêm do mesmo
 * `whois`. O único header do Serve usado é `Tailscale-Funnel-Request`, e só para dar o
 * motivo de não haver identidade.
 */
export function createWhoisIdentity(opts: WhoisIdentityOptions): IdentityPort {
  const sessionMs = opts.sessionMs ?? WHOIS_SESSION_MS;
  // "Uma vez por sessão" (ADR 0007): a resposta vale por `sessionMs` para aquele IP de peer.
  // O WebSocket pergunta uma vez no upgrade e fixa a identidade na conexão.
  const sessions = new Map<string, { who: Identity; until: number }>();

  return {
    async whoAmI(req) {
      if (req.headers.has("tailscale-funnel-request")) return { kind: "none", reason: "funnel" };
      const ip = peerIp(req);
      // Sem X-Forwarded-For a requisição não passou pelo Serve.
      if (!ip) return { kind: "none", reason: "unknown" };

      const now = opts.clock.now().getTime();
      const cached = sessions.get(ip);
      if (cached && now < cached.until) return cached.who;
      const who = await whois(opts.socketPath, ip); // falha não fica guardada
      for (const [k, s] of sessions) if (now >= s.until) sessions.delete(k);
      sessions.set(ip, { who, until: now + sessionMs });
      return who;
    },
  };
}

/**
 * O Serve é o único proxy e escreve o `X-Forwarded-For` sozinho (apaga o do cliente).
 * Se ainda assim vier uma lista, vale o último: é o que o proxy mais próximo anotou.
 */
function peerIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  return xff?.split(",").at(-1)?.trim() || undefined;
}

async function whois(socketPath: string, ip: string): Promise<Identity> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`http://${LOCALAPI_HOST}/localapi/v0/whois?addr=${encodeURIComponent(ip)}`, {
      unix: socketPath,
    });
    raw = await res.text();
  } catch (err) {
    throw new IdentityUnavailableError(`LocalAPI do tailscaled inacessível em ${socketPath}: ${String(err)}`);
  }
  // 404: o IP não é de nenhum nó da tailnet ("no match for IP:port").
  if (res.status === 404) return { kind: "none", reason: "unknown" };
  if (!res.ok) throw new IdentityUnavailableError(`whois respondeu ${res.status}: ${raw.trim()}`);

  let body: WhoIsResponse;
  try {
    body = JSON.parse(raw) as WhoIsResponse;
  } catch {
    throw new IdentityUnavailableError("whois devolveu um corpo que não é JSON");
  }
  // Nó com tag: o UserProfile é o genérico "tagged-devices", não uma pessoa.
  if (body.Node?.Tags?.length) return { kind: "none", reason: "tagged" };

  const userId = userProfileId(raw);
  const p = body.UserProfile;
  // Confere o número cru contra o parseado, para não pegar outro "ID" por engano.
  if (!userId || !p || Number(userId) !== p.ID) {
    throw new IdentityUnavailableError("whois devolveu uma resposta sem UserProfile.ID");
  }
  return {
    kind: "user",
    userId,
    login: p.LoginName ?? "",
    displayName: p.DisplayName || p.LoginName || userId,
    profilePicUrl: p.ProfilePicURL || undefined,
    // O nome que a pessoa deu ao aparelho; sem ele, o nome do nó na tailnet.
    device: body.Node?.Hostinfo?.Hostname || body.Node?.ComputedName || undefined,
    sharee: body.Node?.Hostinfo?.ShareeNode === true,
  };
}

/**
 * `UserProfile.ID` é int64: acima de 2^53 o `JSON.parse` perde precisão. O número é
 * lido do corpo cru. Dentro de strings JSON as aspas vêm escapadas, então o padrão só
 * casa com a chave de verdade.
 */
function userProfileId(raw: string): string | undefined {
  return /"UserProfile"\s*:\s*\{\s*"ID"\s*:\s*(\d+)/.exec(raw)?.[1];
}
