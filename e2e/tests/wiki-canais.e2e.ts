import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("Wiki ligada a Canais", () => {
  test("o Admin liga a Wiki a #geral, e a ligação continua depois de recarregar; depois a desliga", {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    const nome = `Curso nos Canais ${Date.now()}`;
    await app.open("/wikis");
    await screen.getByRole("textbox", "Nome da Wiki").fill(nome);
    await screen.getByRole("textbox", "Descrição da Wiki").fill("O curso transcrito, aula por aula.");
    await screen.getByRole("button", "Criar").tap();

    const wiki = screen.getByRole("listitem", `Wiki ${nome}`);
    const canais = wiki.getByRole("group", `Canais de ${nome}`);
    await expect(canais).toContainText("A Wiki só entra nas respostas depois da primeira Sincronização.");
    const geral = canais.getByRole("checkbox", "#geral");
    await expect(geral).not.toBeChecked();
    await geral.tap();
    await expect(geral).toBeChecked();

    await app.open("/wikis");
    await screen.getByRole("listitem", `Wiki ${nome}`).getByRole("button", "Fontes, alcance e Canais").tap();
    const deNovo = screen.getByRole("group", `Canais de ${nome}`).getByRole("checkbox", "#geral");
    await expect(deNovo).toBeChecked();
    await deNovo.tap();
    await expect(deNovo).not.toBeChecked();
  });
});
