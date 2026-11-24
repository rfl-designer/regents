import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Nome do arquivo da chave mestra dentro da pasta de segredos: 32 bytes em base64. */
export const MASTER_KEY_FILE = "master_key";

/**
 * Lê a chave mestra de `<dir>/master_key` (32 bytes em base64, como `openssl rand -base64 32`).
 * Se o arquivo não existe, gera um (0600) e avisa: o setup da Instalação (#37) já o cria;
 * isto é para o desenvolvimento e o e2e. Sem a mesma chave mestra, a Chave gravada não abre
 * e o Admin precisa gravá-la de novo.
 */
export function loadMasterKey(dir: string, log: (msg: string) => void = console.log): Uint8Array {
  const file = join(dir, MASTER_KEY_FILE);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${b64(crypto.getRandomValues(new Uint8Array(32)))}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    log(`shearim: chave mestra nova gerada em ${file}`);
  }
  const key = unb64(readFileSync(file, "utf8").trim());
  if (key.byteLength !== 32) throw new Error(`${file} não tem uma chave de 32 bytes em base64.`);
  return key;
}
