import { describe, expect, test } from "bun:test";
import { testApp, testDb } from "./harness";

describe("Instalação", () => {
  test("/api/health responde sem identidade (é o healthcheck do container)", async () => {
    const t = await testApp();

    const res = await t.anonymous().get("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("nenhuma tabela das migrações tem org_id (ADR 0001)", async () => {
    const { client } = await testDb();

    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id'`,
    );
    const tables = await client.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );

    expect(tables.rows[0]!.n).toBeGreaterThan(0);
    expect(rows).toEqual([]);
  });
});
