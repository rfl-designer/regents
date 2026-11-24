/**
 * Dublê do push (Spec, "Testing Decisions"): um coletor no lugar dos push services (APNs, FCM,
 * Mozilla). Fala HTTPS como eles, com um certificado autoassinado gerado na hora (por isso o app,
 * nos testes, manda o push por um `https.Agent` que aceita esse certificado).
 *
 * Cada `subscription()` é um "aparelho": um endpoint próprio e o par de chaves ECDH do navegador,
 * com que o coletor decifra o corpo (`aes128gcm`, RFC 8291) como o navegador faria. Guarda, de
 * cada entrega, o payload decifrado, a `tag` da notificação, o `Topic`, a `Urgency` e o `TTL`, e
 * responde `201`, ou o status que o teste pedir (`404`/`410`: inscrição morta).
 *
 * Nos testes: `t.push` (o arnês sobe um por teste).
 */
import { spawnSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ece from "http_ece";

/** O que o navegador recebe e mostra: o JSON do Declarative Web Push. */
export interface DeclarativePushPayload {
  web_push: number;
  notification: { title: string; body?: string; navigate: string; tag?: string; lang?: string };
  app_badge?: number;
  [k: string]: unknown;
}

/** Um push que chegou ao coletor. */
export interface Delivery {
  endpoint: string;
  /** O corpo decifrado, já como JSON. */
  payload: DeclarativePushPayload;
  /** `payload.notification.tag`: o que faz uma notificação substituir a anterior no aparelho. */
  tag: string | undefined;
  topic: string | null;
  urgency: string | null;
  /** O header `TTL`, em segundos. */
  ttl: number | null;
  /** O status que o coletor respondeu. */
  status: number;
}

/** O que o navegador entrega ao servidor depois do `pushManager.subscribe` (`PushSubscription.toJSON()`). */
export interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushCollector {
  /** Um aparelho novo: endpoint próprio e as chaves do "navegador". */
  subscription(): FakeSubscription;
  /** A partir de agora, esse endpoint responde `status` (ex.: `410`, a inscrição morreu). */
  respond(endpoint: string, status: number): void;
  /** Tudo o que chegou, em ordem (as entregas recusadas inclusive, com o `status`). */
  deliveries: Delivery[];
  /**
   * A próxima entrega ainda não lida (de um endpoint, se dado). Espera até `timeoutMs`
   * e falha dizendo o que chegou.
   */
  next(opts?: { endpoint?: string; timeoutMs?: number }): Promise<Delivery>;
  /** O agente HTTPS que aceita o certificado autoassinado do coletor. */
  agent: https.Agent;
  stop(): Promise<void>;
}

let cert: { cert: string; key: string } | undefined;
/** Fica no tmp entre execuções (vale 30 dias): o `openssl` roda quase nunca. */
const CERT_DIR = join(tmpdir(), "shearim-push-collector-cert");

/** Um certificado autoassinado para 127.0.0.1, só para o coletor. */
function selfSignedCert() {
  if (cert) return cert;
  const keyFile = join(CERT_DIR, "key.pem");
  const certFile = join(CERT_DIR, "cert.pem");
  const fresh = existsSync(certFile) && Date.now() - statSync(certFile).mtimeMs < 29 * 24 * 3600_000;
  if (!fresh) {
    // Gera numa pasta própria e só então troca, para dois processos de teste não se atropelarem.
    mkdirSync(CERT_DIR, { recursive: true });
    const work = mkdtempSync(join(CERT_DIR, "gerando-"));
    const args = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    args.push("-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-days", "30");
    args.push("-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1");
    const r = spawnSync("openssl", args, { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0 || !existsSync(join(work, "cert.pem"))) {
      const why = r.error ?? r.stderr ?? `status ${r.status}, sinal ${r.signal}`;
      throw new Error(`coletor de push: o openssl não gerou o certificado (${why})`);
    }
    renameSync(join(work, "key.pem"), keyFile);
    renameSync(join(work, "cert.pem"), certFile);
    rmSync(work, { recursive: true, force: true });
  }
  cert = { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
  return cert;
}

/** Mais folga que o WebSocket: o primeiro push do processo cifra, assina e abre TLS a frio. */
const NEXT_TIMEOUT_MS = 2_000;

export async function startPushCollector(): Promise<PushCollector> {
  const browsers = new Map<string, { ecdh: ReturnType<typeof createECDH>; auth: string }>();
  const answers = new Map<string, number>();
  const deliveries: Delivery[] = [];
  let read = 0;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: selfSignedCert(),
    async fetch(req) {
      const endpoint = req.url;
      const browser = browsers.get(endpoint);
      if (!browser) return new Response("endpoint desconhecido", { status: 404 });
      const body = Buffer.from(await req.arrayBuffer());
      const plain = ece.decrypt(body, { version: "aes128gcm", privateKey: browser.ecdh, authSecret: browser.auth });
      const payload = JSON.parse(plain.toString("utf8")) as DeclarativePushPayload;
      const status = answers.get(endpoint) ?? 201;
      const ttl = req.headers.get("ttl");
      deliveries.push({
        endpoint,
        payload,
        tag: payload.notification?.tag,
        topic: req.headers.get("topic"),
        urgency: req.headers.get("urgency"),
        ttl: ttl === null ? null : Number(ttl),
        status,
      });
      wake();
      return new Response(null, { status });
    },
  });
  const origin = `https://127.0.0.1:${server.port}`;

  function takeNext(endpoint: string | undefined) {
    for (let i = read; i < deliveries.length; i++) {
      const d = deliveries[i]!;
      if (endpoint && d.endpoint !== endpoint) continue;
      // Marca como lida trocando a posição: as de outros endpoints ficam para quem as pedir.
      deliveries.splice(i, 1);
      deliveries.splice(read, 0, d);
      read++;
      return d;
    }
    return undefined;
  }

  return {
    subscription() {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const auth = randomBytes(16).toString("base64url");
      const endpoint = `${origin}/push/${crypto.randomUUID()}`;
      browsers.set(endpoint, { ecdh, auth });
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth } };
    },
    respond(endpoint, status) {
      answers.set(endpoint, status);
    },
    deliveries,
    next(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? NEXT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const tryTake = () => {
          const d = takeNext(opts.endpoint);
          if (!d) return false;
          clearTimeout(timer);
          waiters.delete(tryTake);
          resolve(d);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(tryTake);
          const got = deliveries.map((d) => `"${d.payload.notification?.title}" (${d.status})`).join(", ") || "nada";
          const where = opts.endpoint ? ` em ${opts.endpoint}` : "";
          reject(new Error(`coletor de push: nenhum push novo${where} em ${timeoutMs} ms (chegou: ${got})`));
        }, timeoutMs);
        if (!tryTake()) waiters.add(tryTake);
      });
    },
    agent: new https.Agent({ rejectUnauthorized: false }),
    async stop() {
      await server.stop(true);
    },
  };
}
