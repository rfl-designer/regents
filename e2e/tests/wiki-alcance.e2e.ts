import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { addMember, newPerson } from "../support/people";

/**
 * O alcance da Wiki na administração (#83): o Admin restringe a Wiki a uma lista de Membros, e a
 * escolha continua depois de recarregar.
 */
describe("Alcance da Wiki", () => {
  test("o Admin restringe a Wiki à Bia, e a lista continua depois de recarregar; depois a torna pública", {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    // Um nome único: o banco é da execução, e outros testes também põem Membros.
    const bia = newPerson(`Bia${Date.now() % 1_000_000}`);
    await addMember(app.baseUrl, bia);
    const nome = `Financeiro ${Date.now()}`;
    await app.open("/wikis");
    await screen.getByRole("textbox", "Nome da Wiki").fill(nome);
    await screen.getByRole("textbox", "Descrição da Wiki").fill("O caixa e as metas.");
    await screen.getByRole("button", "Criar").tap();

    const wiki = screen.getByRole("listitem", `Wiki ${nome}`);
    const alcance = wiki.getByRole("group", `Alcance de ${nome}`);
    await expect(alcance.getByRole("radio", "Pública: todo Membro")).toBeChecked();
    await alcance.getByRole("radio", "Restrita a uma lista de Membros").tap();
    await expect(alcance).toContainText("num Canal público, nunca");
    const daBia = alcance.getByRole("checkbox", bia.name);
    await expect(daBia).not.toBeChecked();
    await daBia.tap();
    await expect(daBia).toBeChecked();
    await expect(wiki).toContainText("restrita");

    await app.open("/wikis");
    await screen.getByRole("listitem", `Wiki ${nome}`).getByRole("button", "Fontes, alcance e Canais").tap();
    const deNovo = screen.getByRole("group", `Alcance de ${nome}`);
    await expect(deNovo.getByRole("radio", "Restrita a uma lista de Membros")).toBeChecked();
    await expect(deNovo.getByRole("checkbox", bia.name)).toBeChecked();

    await deNovo.getByRole("radio", "Pública: todo Membro").tap();
    await expect(deNovo.getByRole("radio", "Pública: todo Membro")).toBeChecked();
    await expect(screen.getByRole("listitem", `Wiki ${nome}`)).toContainText("pública");
  });
});
