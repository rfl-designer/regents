import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Arquivos de verdade numa pasta temporária, para o seletor de arquivos. */
function arquivos(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "shearim-fontes-"));
  return Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
}

describe("Wikis na administração", () => {
  test('o Admin cria uma Wiki, sobe duas Fontes e as vê como "nova"; um .pdf é recusado com o motivo', {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    const nome = `Curso de Redes Sociais ${Date.now()}`;
    await app.open("/wikis");
    await screen.getByRole("textbox", "Nome da Wiki").fill(nome);
    await screen.getByRole("textbox", "Descrição da Wiki").fill("O curso transcrito, aula por aula.");

    await screen.getByRole("button", "Criar").tap();

    const wiki = screen.getByRole("listitem", `Wiki ${nome}`);
    await expect(wiki).toContainText("nunca sincronizada");
    await expect(wiki).toContainText("nada pendente");
    const subir = wiki.getByLabel("Subir Fontes (.txt ou .md)");
    await subir.setInputFiles(arquivos({ "aula-01.md": "# Aula 1\n\nO gancho.\n", "aula-02.txt": "Aula 2." }));
    const fontes = wiki.getByRole("list", `Fontes da Wiki ${nome}`);
    await expect(fontes.getByRole("listitem").filter({ hasText: "aula-01.md" })).toContainText("nova");
    await expect(fontes.getByRole("listitem").filter({ hasText: "aula-02.txt" })).toContainText("nova");
    await expect(wiki).toContainText("2 Fontes pendentes");

    await subir.setInputFiles(arquivos({ "apostila.pdf": "%PDF-1.7" }));
    await expect(wiki.getByRole("alert")).toContainText("apostila.pdf não é .txt nem .md");
    await expect(fontes.getByRole("listitem")).toHaveCount(2);
  });
});
