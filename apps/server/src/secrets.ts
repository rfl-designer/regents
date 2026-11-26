import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cifra e decifra segredos guardados no banco (a Chave do Workspace) com a chave mestra
 * de `./secrets` (Spec, módulo 9). AES-256-GCM, um IV novo a cada gravação.
 */
export interface SecretBox {
  seal(plain: string): Promise<Sealed>;
  open(sealed: Sealed): Promise<string>;
}

/** O que vai para o banco: tudo em base64. */
export interface Sealed {
  ciphertext: string;
  iv: string;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as Uint8Array).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export async function secretBox(masterKey: Uint8Array): Promise<SecretBox> {
  if (masterKey.byteLength !== 32) throw new Error("A chave mestra tem 32 bytes.");
  const key = await crypto.subtle.importKey("raw", masterKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
      return { ciphertext: b64(ciphertext), iv: b64(iv) };
    },
    async open(sealed) {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource },
        key,
        unb64(sealed.ciphertext) as BufferSource,
      );
      return new TextDecoder().decode(plain);
    },
  };
}

/** 32 bytes em hex (o que o `deploy/setup.sh` grava, `openssl rand -hex 32`) ou em base64. */
export function parseMasterKey(text: string): Uint8Array {
  const t = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? new Uint8Array(Buffer.from(t, "hex")) : unb64(t);
  if (key.byteLength !== 32) throw new Error("a chave mestra precisa de 32 bytes, em hex ou base64");
  return key;
}

/**
 * Lê a chave mestra do arquivo (`REGENTS_MASTER_KEY_FILE`; no compose, `./secrets/master_key`
 * gerado pelo `deploy/setup.sh`). Com `generate`, um arquivo que falta é criado (0600): só no
 * desenvolvimento. Sem a mesma chave mestra, a Chave gravada não abre e o Admin a grava de novo.
 */
export function loadMasterKey(
  file: string,
  opts: { generate?: boolean; log?: (msg: string) => void } = {},
): Uint8Array {
  if (!existsSync(file)) {
    if (!opts.generate) throw new Error(`a chave mestra não existe em ${file}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
    (opts.log ?? console.log)(`shearim: chave mestra nova gerada em ${file}`);
  }
  try {
    return parseMasterKey(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
}
