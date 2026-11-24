import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("mensagens em tempo real", () => {
  test("a mensagem enviada numa aba aparece na outra sem recarregar", async ({ app, browser, screen }) => {
    const composer = () => screen.getByRole("textbox", "Mensagem para #geral");
    const messages = () => screen.getByRole("list", "Mensagens de #geral");
    await app.open("/");
    await expect(messages()).toHaveAttribute("aria-busy", "false");
    const [primeira] = await browser.tabs();
    const segunda = await browser.newTab();
    await browser.goto("/");
    await expect(messages()).toHaveAttribute("aria-busy", "false");
    await primeira!.activate();
    const body = `Oi da primeira aba ${Date.now()}`;

    await composer().fill(body);
    await screen.getByRole("button", "Enviar").tap();
    await screen.getByText(body).waitFor();

    await segunda.activate();
    await expect(screen.getByText(body)).toBeVisible();
  });
});
