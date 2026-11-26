/**
 * Um push service falso para o e2e, no processo do teste: HTTPS em 127.0.0.1, com o certificado
 * que o `serve.ts` manda o servidor aceitar (`NODE_EXTRA_CA_CERTS`). Não decifra nada: responde
 * `410` (a inscrição morreu, como o iOS faz em silêncio) aos endpoints de `dead()` e `201` aos de
 * `alive()`. É o que faz o servidor anotar "parou em" num aparelho e as faixas aparecerem.
 */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { PushSubscriptionInput } from "@regents/contracts";
import { pushServiceCert } from "../../apps/server/test/fakes/push-cert";

export interface FakePushService {
  /** Uma inscrição cujo endpoint responde `410`. */
  dead(): PushSubscriptionInput;
  /** Uma inscrição cujo endpoint responde `201`. */
  alive(): PushSubscriptionInput;
  /** Os endpoints que receberam push, em ordem. */
  hits: string[];
  stop(): Promise<void>;
}

export async function startFakePushService(): Promise<FakePushService> {
  const { cert, key } = pushServiceCert();
  const hits: string[] = [];
  let origin = "";
  const server = https.createServer({ cert, key }, (req, res) => {
    hits.push(`${origin}${req.url}`);
    req.resume();
    req.on("end", () => {
      res.statusCode = req.url?.startsWith("/morta/") ? 410 : 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const subscription = (path: string): PushSubscriptionInput => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      endpoint: `${origin}/${path}/${randomUUID()}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    };
  };
  return {
    dead: () => subscription("morta"),
    alive: () => subscription("viva"),
    hits,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
