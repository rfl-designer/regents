import { describe, expect, test } from "bun:test";
import { claimHandle, type HandleOwner, handleBase, resolveHandles } from "../src/mention-handles";
import { testApp } from "./harness";

/**
 * O identificador de Menção é um espaço de nomes só, de Membros e Agentes.
 * Os Agentes ainda não existem por HTTP (#20); aqui o Agente pega o identificador pelo
 * mesmo seam que a criação de Agente vai usar: `claimHandle(tx, { kind: "agent", id }, base)`.
 * Quando o #20 chegar, o Agente destes testes passa a ser criado pela rota dele.
 */
describe("Identificador de Menção: um espaço só para Membros e Agentes", () => {
  test("um Membro que chega depois de um Agente com o mesmo nome ganha sufixo", async () => {
    const t = await testApp();
    const agente: HandleOwner = { kind: "agent", id: crypto.randomUUID() };
    const doAgente = await claimHandle(t.db, agente, handleBase("Rafael"));

    const me = await (await t.as({ id: "1001", name: "Rafael Oliveira" }).get("/api/me")).json();

    expect(doAgente).toBe("rafael");
    expect(me.handle).toBe("rafael2");
    expect(await resolveHandles(t.db, ["rafael", "rafael2", "ninguem"])).toEqual(
      new Map<string, HandleOwner>([
        ["rafael", agente],
        ["rafael2", { kind: "member", id: me.id }],
      ]),
    );
  });

  test("um Agente criado depois de um Membro com o mesmo nome ganha sufixo", async () => {
    const t = await testApp();
    await t.as({ id: "1001", name: "Faro" }).get("/api/me");

    const doAgente = await claimHandle(t.db, { kind: "agent", id: crypto.randomUUID() }, handleBase("Faro"));

    expect(doAgente).toBe("faro2");
  });

  test("o Membro não pode editar o seu para o identificador de um Agente", async () => {
    const t = await testApp();
    await claimHandle(t.db, { kind: "agent", id: crypto.randomUUID() }, "sophya");

    const res = await t.as({ id: "1001", name: "Juliana" }).patch("/api/me", { handle: "@Sophya" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "handle_taken" });
  });
});
