import { crc32, deflateRawSync } from "node:zlib";

/**
 * Um `.zip` montado à mão, para os testes da importação de skill: cada arquivo comprimido com
 * deflate (ou guardado sem compressão, com `stored`), como os programas de zip comuns gravam. Só
 * `node:zlib`: o e2e (no Node) também o usa.
 */
export function zip(files: Record<string, string>, opts: { stored?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = new TextEncoder().encode(path);
    const raw = new TextEncoder().encode(text);
    const data = opts.stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = opts.stored ? 0 : 8;
    const crc = crc32(raw);
    const local = header(30, name, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(8, method, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, raw.length, true);
      v.setUint16(26, name.length, true);
    });
    central.push(
      header(46, name, (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(10, method, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, data.length, true);
        v.setUint32(24, raw.length, true);
        v.setUint16(28, name.length, true);
        v.setUint32(42, offset, true);
      }),
    );
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = header(22, new Uint8Array(), (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, central.length, true);
    v.setUint16(10, central.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, offset, true);
  });
  return concat([...parts, ...central, end]);
}

function header(size: number, name: Uint8Array, fill: (v: DataView) => void): Uint8Array {
  const out = new Uint8Array(size + name.length);
  fill(new DataView(out.buffer));
  out.set(name, size);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
