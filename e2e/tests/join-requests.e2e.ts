import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { approve, as, ensureAdmin, newPerson, requestToJoin } from "../support/people";

describe("Pedido de entrada", () => {
  test("quem espera entra no Workspace sozinho quando um Admin aprova", async ({ app, screen }) => {
    const fulana = newPerson("Fulana");
    await ensureAdmin(app.baseUrl);
    await app.open(`/dev/como/${fulana.id}?nome=${fulana.name}`);
    await screen.getByRole("button", "Pedir para entrar").tap();
    await screen.getByRole("heading", "Seu pedido de entrada está esperando um Admin").waitFor();

    await approve(app.baseUrl, fulana);

    await expect(screen.getByRole("textbox", "Mensagem para #geral")).toBeVisible();
    await expect(screen.getByText("Você está como Fulana")).toBeVisible();
  });

  test("o Admin vê o pedido novo chegar na hora, com o aparelho, e o aprova", async ({ app, screen }) => {
    const beltrano = newPerson("Beltrano");
    await app.open("/");
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    await requestToJoin(app.baseUrl, beltrano);
    const card = screen.getByRole("listitem", `Pedido de ${beltrano.name}`);
    await card.getByText("Aparelho: navegador de dev").waitFor();

    await card.getByRole("button", "Aprovar").tap();

    await expect(card).toBeHidden();
    expect((await as(app.baseUrl, beltrano)("/api/me")).role).toBe("member");
  });

  test("quem foi recusado vê a recusa e pode pedir de novo", async ({ app, screen }) => {
    const sicrana = newPerson("Sicrana");
    await requestToJoin(app.baseUrl, sicrana);
    await app.open(`/dev/como/${sicrana.id}?nome=${sicrana.name}`);
    await screen.getByRole("heading", "Seu pedido de entrada está esperando um Admin").waitFor();
    const pending = await as(app.baseUrl)("/api/join-requests");
    const request = pending.find((r: { login: string }) => r.login === `${sicrana.id}@dev.local`);
    await as(app.baseUrl)(`/api/join-requests/${request.id}/refuse`, { method: "POST" });
    await screen.getByRole("heading", "Seu pedido de entrada foi recusado").waitFor();

    await screen.getByRole("button", "Pedir de novo").tap();

    await expect(screen.getByRole("heading", "Seu pedido de entrada está esperando um Admin")).toBeVisible();
  });
});
