/**
 * O certificado autoassinado dos push services falsos (o coletor dos testes e o push service
 * morto do e2e), para 127.0.0.1. Só usa `node:*`: roda no Bun e no Node (o runner do e2e).
 *
 * Fica no tmp entre execuções (vale 30 dias): o `openssl` roda quase nunca. Quem manda o push
 * aceita o certificado por um `https.Agent` próprio (testes) ou por `NODE_EXTRA_CA_CERTS`
 * apontando para `certFile` (o servidor do e2e).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PushServiceCert {
  cert: string;
  key: string;
  /** O caminho do `cert.pem`, para o `NODE_EXTRA_CA_CERTS`. */
  certFile: string;
}

let cached: PushServiceCert | undefined;
const CERT_DIR = join(tmpdir(), "shearim-push-collector-cert");

export function pushServiceCert(): PushServiceCert {
  if (cached) return cached;
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
      throw new Error(`push service falso: o openssl não gerou o certificado (${why})`);
    }
    renameSync(join(work, "key.pem"), keyFile);
    renameSync(join(work, "cert.pem"), certFile);
    rmSync(work, { recursive: true, force: true });
  }
  cached = { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), certFile };
  return cached;
}
