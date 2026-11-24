import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder, schema } from "../src/db/client";
import { resolveHandles } from "../src/mention-handles";
import { onCleanup } from "./harness";

/**
 * Um banco migrado só até `tag` (inclusive), como estaria uma Instalação antes das
 * migrações seguintes. Depois, `migrate(db, { migrationsFolder })` aplica o resto.
 */
async function migratedUntil(tag: string) {
  const folder = mkdtempSync(join(tmpdir(), "shearim-migrations-"));
  onCleanup(() => rmSync(folder, { recursive: true, force: true }));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const until = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  if (until < 0) throw new Error(`migração ${tag} não existe`);
  journal.entries = journal.entries.slice(0, until + 1);
  writeFileSync(journalPath, JSON.stringify(journal));

  const client = new PGlite();
  onCleanup(() => client.close());
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: folder });
  return { db, client };
}

describe("Migração do identificador de Menção (0006)", () => {
  test("Membros e Agentes de antes ganham identificador; o do Agente vem do nome, para a Menção seguir valendo", async () => {
    const { db, client } = await migratedUntil("0005_agentes-chave-e-execucoes");
    const ids = { juliana: crypto.randomUUID(), faro: crypto.randomUUID(), sophya: crypto.randomUUID() };
    const ontem = "2026-11-23T12:00:00Z";
    await client.query(
      `INSERT INTO members (id, tailnet_user_id, login, display_name, role, created_at)
       VALUES ($1, '1001', 'juliana@exemplo.com', 'Juliana', 'admin', $2)`,
      [ids.juliana, ontem],
    );
    await client.query(
      `INSERT INTO agents (id, name, model, created_at) VALUES ($1, 'Faro', 'claude-sonnet-5-5', $3),
         ($2, 'Sophya Jurídico', 'claude-sonnet-5-5', $3)`,
      [ids.faro, ids.sophya, ontem],
    );

    await migrate(db, { migrationsFolder });

    const owners = await resolveHandles(db, ["faro", "sophyajuridico"]);
    expect(owners).toEqual(
      new Map([
        ["faro", { kind: "agent", id: ids.faro }],
        ["sophyajuridico", { kind: "agent", id: ids.sophya }],
      ]),
    );
    const handles = await db.select().from(schema.mentionHandles);
    expect(handles).toContainEqual({
      handle: expect.stringMatching(/^membro_[0-9a-f]{12}$/),
      memberId: ids.juliana,
      agentId: null,
    });
    // Os 3 de antes, mais o da Articuladora, que chega na 0012.
    expect(handles.filter((h) => h.handle !== "sophya")).toHaveLength(3);
  });
});

describe("Migração da Articuladora (0012)", () => {
  test("um Workspace de antes ganha a Sophya, em todo Canal (não nas DMs), com sufixo se @sophya já é de alguém", async () => {
    const { db, client } = await migratedUntil("0011_push-e-presenca");
    const ids = { sophya: crypto.randomUUID(), vendas: crypto.randomUUID(), dm: crypto.randomUUID() };
    const ontem = "2026-11-23T12:00:00Z";
    await client.query(
      `INSERT INTO members (id, tailnet_user_id, login, display_name, role, created_at)
       VALUES ($1, '1001', 'sophya@exemplo.com', 'Sophya Lima', 'admin', $2)`,
      [ids.sophya, ontem],
    );
    await client.query(`INSERT INTO mention_handles (handle, member_id) VALUES ('sophya', $1)`, [ids.sophya]);
    await client.query(
      `INSERT INTO channels (id, name, kind, created_at) VALUES ($1, 'vendas', 'private', $3), ($2, NULL, 'dm', $3)`,
      [ids.vendas, ids.dm, ontem],
    );

    await migrate(db, { migrationsFolder });

    const builtin = await db.select().from(schema.agents);
    expect(builtin).toMatchObject([{ name: "Sophya", builtin: true, model: "claude-sonnet-5-5" }]);
    const owners = await resolveHandles(db, ["sophya", "sophya2"]);
    expect(owners.get("sophya")).toEqual({ kind: "member", id: ids.sophya });
    expect(owners.get("sophya2")).toEqual({ kind: "agent", id: builtin[0]!.id });
    const where = await db.select().from(schema.channelAgents);
    expect(where.map((r) => [r.channelId, r.agentId])).toEqual([[ids.vendas, builtin[0]!.id]]);
  });
});
