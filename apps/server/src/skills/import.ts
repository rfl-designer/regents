import { inflateRawSync } from "node:zlib";
import { type CreateSkillInput, SKILL_BODY_MAX } from "@shearim/contracts";

/** O que sai de um `SKILL.md`: os campos da Habilidade (ainda sem conferir) e os arquivos ignorados. */
export type SkillFile = { input: Partial<CreateSkillInput>; ignored: string[] } | { error: string };

/** Um arquivo de dentro do pacote da skill (`.zip` ou pasta): o caminho e a leitura do texto. */
type Entry = { name: string; read(): string | undefined | Promise<string | undefined> };

/**
 * Lê o arquivo da importação: um `SKILL.md` (o frontmatter YAML dá o `name` e a `description`; o
 * resto é o corpo) ou um `.zip` de skill, com o `SKILL.md` na raiz ou numa pasta. Do `.zip`, os
 * outros arquivos ficam de fora (os Agentes do Shearim não executam código) e voltam em `ignored`,
 * com o caminho a partir da pasta do `SKILL.md`. Sem `name` ou sem `description`, ou um `.zip` sem
 * `SKILL.md`, a importação falha com o motivo.
 */
export async function readSkillFile(file: File): Promise<SkillFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) return fromSkillMd(new TextDecoder().decode(bytes), []);
  const entries = zipEntries(bytes);
  if (!entries) return { error: "Não foi possível ler o .zip: ele está corrompido ou usa um formato sem suporte." };
  return fromPackage(entries, { what: "O .zip", from: "de dentro do .zip" });
}

/**
 * Lê uma pasta de skill: cada arquivo com o caminho a partir da pasta escolhida no nome, ou só o
 * caminho (texto), sem o conteúdo, para os arquivos que não precisam subir. Como no `.zip`, só o
 * `SKILL.md` vira Habilidade, e os outros arquivos voltam em `ignored`.
 */
export function readSkillFolder(files: (File | string)[]): Promise<SkillFile> {
  const entries = files.map((f) =>
    typeof f === "string"
      ? { name: f.replace(/^\/+/, ""), read: () => undefined }
      : { name: f.name.replace(/^\/+/, ""), read: () => f.text() },
  );
  return fromPackage(entries, { what: "A pasta", from: "da pasta" });
}

async function fromPackage(entries: Entry[], words: { what: string; from: string }): Promise<SkillFile> {
  const files = entries.filter((e) => !e.name.endsWith("/") && !isJunk(e.name));
  const depth = (name: string) => name.split("/").length;
  const skills = files.filter((e) => /(^|\/)SKILL\.md$/i.test(e.name)).sort((a, b) => depth(a.name) - depth(b.name));
  const [skill, next] = skills;
  if (!skill) return { error: `${words.what} não tem um SKILL.md.` };
  if (next && depth(next.name) === depth(skill.name)) {
    return { error: `${words.what} tem mais de um SKILL.md no mesmo nível: importe uma skill por vez.` };
  }
  const folder = skill.name.slice(0, skill.name.length - "SKILL.md".length);
  const ignored = files
    .filter((e) => e !== skill)
    .map((e) => (e.name.startsWith(folder) ? e.name.slice(folder.length) : e.name))
    .sort();
  const text = await skill.read();
  if (text === undefined) return { error: `Não foi possível ler o SKILL.md ${words.from}.` };
  return fromSkillMd(text, ignored);
}

function fromSkillMd(text: string, ignored: string[]): SkillFile {
  const parsed = splitFrontmatter(text);
  if (!parsed) return { error: "O SKILL.md não tem frontmatter: comece com --- e os campos name e description." };
  const { name, description } = parsed.fields;
  if (!name) return { error: "O frontmatter do SKILL.md não tem o campo name." };
  if (!description) return { error: "O frontmatter do SKILL.md não tem o campo description." };
  return { input: { name, description, body: parsed.body }, ignored };
}

/**
 * O frontmatter (entre a linha `---` do início e a próxima `---`) e o corpo depois dele. Do YAML,
 * só as chaves do primeiro nível com valor de texto: simples, entre aspas ou em bloco (`|`, `>`).
 */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined;
  const fields: Record<string, string> = {};
  const yaml = lines.slice(1, end);
  for (let i = 0; i < yaml.length; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(yaml[i]!);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    const value = rest.replace(/\s+#.*$/, "").trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < yaml.length && (/^\s/.test(yaml[i + 1]!) || !yaml[i + 1]!.trim())) block.push(yaml[++i]!);
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
      const body = block.map((l) => l.slice(indent).trimEnd());
      fields[key] = (value.startsWith("|") ? body.join("\n") : body.join(" ").replace(/\s+/g, " ")).trim();
    } else {
      fields[key] = unquote(rest.trim());
    }
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\s*\n/, ""),
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, "");
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Lixo que o macOS põe nos `.zip` e nas pastas: não é arquivo da skill, nem entra na lista de ignorados. */
const isJunk = (name: string) => /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name);

/** O maior `SKILL.md` que se descomprime: o corpo cabe no limite da Habilidade, com folga para UTF-8. */
const SKILL_MD_MAX_BYTES = SKILL_BODY_MAX * 4 + 64 * 1024;

/**
 * As entradas do diretório central de um `.zip` (sem zip64 nem criptografia), cada uma com o nome
 * e a leitura do conteúdo (guardado ou deflate). `undefined` se o arquivo não é um `.zip` legível.
 */
function zipEntries(b: Uint8Array): { name: string; read(): string | undefined }[] | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const entries: { name: string; read(): string | undefined }[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || v.getUint32(at, true) !== 0x02014b50) return undefined;
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const fullSize = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name,
      read() {
        if (flags & 1 || fullSize > SKILL_MD_MAX_BYTES || local + 30 > b.length) return undefined;
        if (v.getUint32(local, true) !== 0x04034b50) return undefined;
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = b.subarray(start, start + size);
        try {
          if (method === 0) return new TextDecoder().decode(data);
          if (method === 8)
            return new TextDecoder().decode(inflateRawSync(data, { maxOutputLength: SKILL_MD_MAX_BYTES }));
        } catch {}
        return undefined;
      },
    });
  }
  return entries;
}
