import { formatBytes, type WikiSourceDto, type WikiSourceFormat } from "@shearim/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type Db, schema, type Tx } from "../db/client";
import { pendingOf, reflectedSources } from "./wikis";

const { wikis, wikiSources, wikiSyncs, wikiVersionSources, members } = schema;

/**
 * Trava a linha da Wiki até o fim da transação: o pedido de Sincronização e a remoção de Fonte
 * passam por ela, um de cada vez (a Sincronização nunca começa com uma Fonte saindo pela metade).
 */
export async function lockWiki(tx: Tx, wikiId: string) {
  await tx.select({ id: wikis.id }).from(wikis).where(eq(wikis.id, wikiId)).for("update");
}

/** Uma Fonte pronta para guardar: o nome do arquivo, o formato e o texto. */
export interface SourceUpload {
  fileName: string;
  format: WikiSourceFormat;
  text: string;
  sizeBytes: number;
}

/** O tamanho máximo padrão de uma Fonte: 5 MB (um curso transcrito inteiro cabe em poucas Fontes). */
export const DEFAULT_SOURCE_MAX_BYTES = 5_000_000;

/**
 * O que a Instalação ajusta na Wiki: o tamanho máximo de uma Fonte (`SHEARIM_WIKI_SOURCE_MAX_MB`,
 * aceita fração) e o teto de turnos de Ferramenta de cada chamada da Sincronização
 * (`SHEARIM_WIKI_SYNC_MAX_TURNS`). O que falta fica com o padrão; valor inválido é erro.
 */
export function wikiFromEnv(env: Record<string, string | undefined>): {
  sourceMaxBytes?: number;
  syncMaxToolTurns?: number;
} {
  const out: { sourceMaxBytes?: number; syncMaxToolTurns?: number } = {};
  const raw = env.SHEARIM_WIKI_SOURCE_MAX_MB?.trim();
  if (raw) {
    const mb = Number(raw);
    if (!Number.isFinite(mb) || mb <= 0) {
      throw new Error(`SHEARIM_WIKI_SOURCE_MAX_MB=${raw} não é um número maior que zero.`);
    }
    out.sourceMaxBytes = Math.round(mb * 1_000_000);
  }
  const turns = env.SHEARIM_WIKI_SYNC_MAX_TURNS?.trim();
  if (turns) {
    const n = Number(turns);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`SHEARIM_WIKI_SYNC_MAX_TURNS=${turns} não é um número inteiro maior que zero.`);
    }
    out.syncMaxToolTurns = n;
  }
  return out;
}

/** Por que um arquivo não vira Fonte: o código do erro HTTP e o motivo, em pt-BR. */
export type UploadRefusal = { status: 400 | 413; error: "invalid_source" | "source_too_large"; message: string };

const FORMATS: Record<string, WikiSourceFormat> = { ".txt": "txt", ".md": "md" };
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Lê um arquivo subido como Fonte: só `.txt` e `.md`, até `maxBytes`, com texto em UTF-8 e não
 * vazio. O motivo da recusa nomeia o arquivo, para o Admin saber qual corrigir.
 */
export async function readUpload(file: File, maxBytes: number): Promise<SourceUpload | UploadRefusal> {
  const name = file.name;
  const format = FORMATS[name.slice(name.lastIndexOf(".")).toLowerCase()];
  const invalid = (message: string): UploadRefusal => ({ status: 400, error: "invalid_source", message });
  if (name.lastIndexOf(".") < 0 || !format) {
    return invalid(`${name} não é .txt nem .md: a Wiki só aceita Fontes em texto ou markdown.`);
  }
  if (file.size > maxBytes) {
    return {
      status: 413,
      error: "source_too_large",
      message: `${name} tem ${formatBytes(file.size)} e passa do tamanho máximo de uma Fonte nesta Instalação (${formatBytes(maxBytes)}). Divida o arquivo em partes menores.`,
    };
  }
  let text: string;
  try {
    text = utf8.decode(await file.arrayBuffer());
  } catch {
    return invalid(`${name} não é texto em UTF-8. Salve o arquivo como UTF-8 e suba de novo.`);
  }
  if (!text.trim()) return invalid(`${name} está vazio.`);
  return { fileName: name, format, text, sizeBytes: file.size };
}

/** As Fontes de um pedido, todas ou nenhuma: a primeira recusa recusa o pedido inteiro. */
export async function readUploads(files: File[], maxBytes: number): Promise<SourceUpload[] | UploadRefusal> {
  if (files.length === 0) {
    return { status: 400, error: "invalid_source", message: "Escolha ao menos um arquivo .txt ou .md." };
  }
  const uploads: SourceUpload[] = [];
  for (const file of files) {
    const upload = await readUpload(file, maxBytes);
    if ("error" in upload) return upload;
    uploads.push(upload);
  }
  return uploads;
}

const COLUMNS = {
  id: wikiSources.id,
  wikiId: wikiSources.wikiId,
  fileName: wikiSources.fileName,
  format: wikiSources.format,
  sizeBytes: wikiSources.sizeBytes,
  state: wikiSources.state,
  uploadedAt: wikiSources.uploadedAt,
  uploaderId: members.id,
  uploaderName: members.displayName,
};

/**
 * As Fontes de uma Wiki, na ordem em que subiram, com a pendência de cada uma: as ativas e as
 * removidas "a remover". Uma removida que a versão atual já não reflete saiu da Wiki e não aparece
 * (fica guardada para as versões antigas; voltar a uma delas a mostra "a remover" de novo).
 */
export async function listSources(db: Db, wikiId: string, only?: string[]): Promise<WikiSourceDto[]> {
  const reflected = await reflectedSources(db, wikiId);
  const rows = await db
    .select(COLUMNS)
    .from(wikiSources)
    .innerJoin(members, eq(members.id, wikiSources.uploadedByMemberId))
    .where(only ? inArray(wikiSources.id, only) : eq(wikiSources.wikiId, wikiId))
    .orderBy(asc(wikiSources.seq));
  return rows.flatMap(({ uploaderId, uploaderName, uploadedAt, ...s }) => {
    const pending = pendingOf(s, reflected);
    if (s.state === "removed" && !pending) return [];
    return [
      { ...s, pending, uploadedBy: { id: uploaderId, name: uploaderName }, uploadedAt: uploadedAt.toISOString() },
    ];
  });
}

class SourceExists extends Error {
  constructor(readonly fileName: string) {
    super(fileName);
  }
}

/**
 * Guarda as Fontes juntas (todas ou nenhuma) e devolve as guardadas, na ordem dada. Uma Fonte não
 * muda depois de subir: um arquivo com o nome de uma Fonte ativa da Wiki (sem diferenciar
 * maiúsculas) não a substitui, e o pedido inteiro é recusado com `{ exists: <nome da Fonte> }`.
 */
export async function addSources(
  db: Db,
  input: { wikiId: string; uploads: SourceUpload[]; by: string; now: Date },
): Promise<WikiSourceDto[] | { exists: string }> {
  try {
    const ids = await db.transaction(async (tx) => {
      const out: string[] = [];
      // Uma por vez, para o `seq` seguir a ordem dos arquivos.
      for (const upload of input.uploads) {
        const id = crypto.randomUUID();
        const [added] = await tx
          .insert(wikiSources)
          .values({ id, wikiId: input.wikiId, ...upload, uploadedByMemberId: input.by, uploadedAt: input.now })
          .onConflictDoNothing()
          .returning({ id: wikiSources.id });
        if (!added) {
          const [taken] = await tx
            .select({ fileName: wikiSources.fileName })
            .from(wikiSources)
            .where(
              and(
                eq(wikiSources.wikiId, input.wikiId),
                eq(wikiSources.state, "active"),
                eq(sql`lower(${wikiSources.fileName})`, upload.fileName.toLowerCase()),
              ),
            );
          throw new SourceExists(taken?.fileName ?? upload.fileName);
        }
        out.push(id);
      }
      return out;
    });
    return listSources(db, input.wikiId, ids);
  } catch (err) {
    if (err instanceof SourceExists) return { exists: err.fileName };
    throw err;
  }
}

/**
 * Remove uma Fonte ativa da Wiki (#88). Se alguma versão guardada a reflete, ela só passa a
 * `removed` e fica guardada, com o texto: a versão atual a mostra "a remover" até a próxima
 * Sincronização, e as versões antigas continuam verificáveis. Se nenhuma versão a reflete, ela sai
 * direto, sem pendência. `undefined` quando a Fonte não está ativa na Wiki.
 *
 * Com uma Sincronização em curso, não (`sync_running`): o plano dela já conta com a Fonte. A trava
 * da Wiki (`lockWiki`) ordena a remoção e o pedido de Sincronização.
 */
export async function removeSource(db: Db, input: { wikiId: string; sourceId: string; now: Date }) {
  return db.transaction(async (tx) => {
    await lockWiki(tx, input.wikiId);
    const [open] = await tx
      .select({ id: wikiSyncs.id })
      .from(wikiSyncs)
      .where(and(eq(wikiSyncs.wikiId, input.wikiId), inArray(wikiSyncs.state, ["queued", "running"])));
    if (open) return "sync_running" as const;
    const [source] = await tx
      .select({ id: wikiSources.id })
      .from(wikiSources)
      .where(
        and(eq(wikiSources.id, input.sourceId), eq(wikiSources.wikiId, input.wikiId), eq(wikiSources.state, "active")),
      )
      .for("update");
    if (!source) return undefined;
    const [kept] = await tx
      .select({ id: wikiVersionSources.sourceId })
      .from(wikiVersionSources)
      .where(eq(wikiVersionSources.sourceId, source.id))
      .limit(1);
    if (!kept) {
      await tx.delete(wikiSources).where(eq(wikiSources.id, source.id));
      return "deleted" as const;
    }
    await tx.update(wikiSources).set({ state: "removed", removedAt: input.now }).where(eq(wikiSources.id, source.id));
    return "removed" as const;
  });
}
