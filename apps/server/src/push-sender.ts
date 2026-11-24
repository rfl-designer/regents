import type https from "node:https";
import * as webpush from "web-push";

/** O par VAPID em base64url, como o `web-push` usa. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Uma inscrição como o navegador a dá. */
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface OutgoingPush {
  /** O JSON que vai cifrado no corpo. */
  payload: unknown;
  /** Segundos que o push service guarda o push se o aparelho estiver fora. */
  ttl: number;
  urgency: "high" | "normal";
  /** Push novo com o mesmo `Topic` substitui o que ainda não foi entregue (base64url, até 32). */
  topic: string;
}

export type SendResult =
  | { kind: "delivered" }
  /** O push service diz que a inscrição morreu (404/410): não adianta tentar de novo. */
  | { kind: "gone"; status: number }
  | { kind: "failed"; detail: string };

/**
 * O adaptador do `web-push` v4 (nota 04): cifra em `aes128gcm`, assina o VAPID e manda com
 * `TTL`, `Urgency` e `Topic` explícitos (o TTL padrão da lib é de 4 semanas). `agent` só nos
 * testes, para o certificado autoassinado do coletor.
 */
export function webPushSender(opts: { contact: string; agent?: https.Agent }) {
  return async function send(vapid: VapidKeys, to: Subscription, push: OutgoingPush): Promise<SendResult> {
    try {
      await webpush.sendNotification(to, JSON.stringify(push.payload), {
        vapidDetails: { subject: opts.contact, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: push.ttl,
        urgency: push.urgency,
        topic: push.topic,
        ...(opts.agent ? { agent: opts.agent } : {}),
      });
      return { kind: "delivered" };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return { kind: "gone", status };
      const body = (err as { body?: string }).body;
      return { kind: "failed", detail: status ? `${status} ${body ?? ""}`.trim() : String(err) };
    }
  };
}

export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}
