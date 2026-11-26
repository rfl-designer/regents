import { describe, test } from "@e2e-dev/web";
import type { DmDto } from "@regents/contracts";
import { expect } from "e2e";
import { addMember, as, ensureAdmin, newPerson } from "../support/people";

/** O que a Messages API falsa do `serve.ts` responde a toda chamada. */
const RESPOSTA = "Oi! Tudo certo por aqui: o prazo é sexta-feira.";

describe("DMs", () => {
  test("uma DM aberta por outra pessoa aparece na hora em Mensagens diretas, fora dos Canais", async ({
    app,
    screen,
  }) => {
    const eu = await ensureAdmin(app.baseUrl);
    const fulana = newPerson("Fulana");
    await addMember(app.baseUrl, fulana);
    await app.open("/");
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    const texto = `oi, só entre nós ${Date.now()}`;

    const dm: DmDto = await as(app.baseUrl, fulana)("/api/dms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberIds: [eu.id] }),
    });
    await as(app.baseUrl, fulana)(`/api/conversations/${dm.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: texto }),
    });

    await screen.getByRole("list", "DMs").getByRole("button", fulana.name).tap();
    await expect(screen.getByRole("heading", fulana.name)).toBeVisible();
    await expect(screen.getByText(texto)).toBeVisible();
  });
});

describe("DM com Agente", () => {
  test("um Membro abre a DM com um Agente pela lista e a resposta chega ancorada, sem Menção", async ({
    app,
    screen,
  }) => {
    await ensureAdmin(app.baseUrl);
    const chamar = as(app.baseUrl);
    await chamar("/api/workspace-key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-e2e" }),
    });
    const nome = `Lia${Date.now() % 1_000_000}`;
    await chamar("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nome, description: "", instructions: "Responda curto.", model: "claude-haiku-5-5" }),
    });
    await app.open("/");
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");

    await screen.getByRole("button", "+ Nova DM").tap();
    await screen.getByRole("list", "Conversar com um Agente").getByRole("button", nome).tap();
    await expect(screen.getByRole("heading", nome)).toBeVisible();
    const mensagens = screen.getByRole("list", `Mensagens de ${nome}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `qual o prazo? ${Date.now()}`;
    await screen.getByRole("textbox", `Mensagem para ${nome}`).fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    await expect(origem.getByRole("article", `Mensagem de ${nome}`)).toContainText(RESPOSTA, { timeout: 20_000 });
  });
});
