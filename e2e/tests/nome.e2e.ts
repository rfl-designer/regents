import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** O nome do produto (spec #96, #99): o Membro vê Regents na aba, na barra do topo e no app instalado. */
describe("o nome Regents", () => {
  test("a aba e a barra do topo dizem Regents", async ({ app, browser, screen }) => {
    await app.open("/");
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");

    await expect(browser).toHaveTitle("Regents");
    await expect(screen.getByRole("banner")).toContainText("Regents");
    await expect(screen.getByRole("banner")).not.toContainText("Shearim");
  });

  test("o app instalado na Tela de Início se chama Regents, e o ícone também", async ({ app }) => {
    const manifest = await (await fetch(`${app.baseUrl}/manifest.webmanifest`)).json();
    const icone = await (await fetch(`${app.baseUrl}/icon.svg`)).text();

    expect(manifest).toMatchObject({ name: "Regents", short_name: "Regents" });
    expect(icone).toContain("<title>Regents</title>");
  });
});
