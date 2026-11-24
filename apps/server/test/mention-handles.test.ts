import { describe, expect, test } from "bun:test";
import type { AgentDto } from "@shearim/contracts";
import { type HandleOwner, resolveHandles } from "../src/mention-handles";
import { type Person, type TestApp, testApp } from "./harness";

const admin = { id: "1000", login: "admin@exemplo.com", name: "Admin" };

/** O Admin cria um Agente pela rota (`POST /api/agents`). */
async function criarAgente(t: TestApp, name: string): Promise<AgentDto> {
  const res = await t.as(admin).post("/api/agents", { name, model: "claude-sonnet-5-5" });
  expect(res.status).toBe(201);
  return res.json();
}

async function entrar(t: TestApp, who: Person) {
  return t.addMember(who, { by: admin });
}

/** O identificador de Menção é um espaço de nomes só, de Membros e Agentes. */
describe("Identificador de Menção: um espaço só para Membros e Agentes", () => {
  test("um Membro que chega depois de um Agente com o mesmo nome ganha sufixo", async () => {
    const t = await testApp();
    await t.as(admin).get("/api/me");
    const agente = await criarAgente(t, "Rafael");

    const me = await entrar(t, { id: "1001", name: "Rafael Oliveira" });

    expect(agente.handle).toBe("rafael");
    expect(me.handle).toBe("rafael2");
    expect(await resolveHandles(t.db, ["rafael", "rafael2", "ninguem"])).toEqual(
      new Map<string, HandleOwner>([
        ["rafael", { kind: "agent", id: agente.id }],
        ["rafael2", { kind: "member", id: me.id }],
      ]),
    );
  });

  test("um Agente criado depois de um Membro com o mesmo nome ganha sufixo", async () => {
    const t = await testApp();
    await entrar(t, { id: "1001", name: "Faro" });

    const agente = await criarAgente(t, "Faro");

    expect(agente.handle).toBe("faro2");
  });

  test("o Membro não pode editar o seu para o identificador de um Agente", async () => {
    const t = await testApp();
    await entrar(t, { id: "1001", name: "Juliana" });
    await criarAgente(t, "Sophya");

    const res = await t.as({ id: "1001", name: "Juliana" }).patch("/api/me", { handle: "@Sophya" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "handle_taken" });
  });
});
