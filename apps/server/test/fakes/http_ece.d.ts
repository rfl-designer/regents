// `http_ece` (dependência do `web-push`) não traz tipos. Só o que o coletor de push usa.
declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  export function decrypt(
    buffer: Buffer,
    params: { version: "aes128gcm"; privateKey: ECDH; authSecret: string },
  ): Buffer;

  const ece: { decrypt: typeof decrypt };
  export default ece;
}
