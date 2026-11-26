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

describe("Sincronização da Wiki", () => {
  test('o Admin sobe duas Fontes, aperta "Sincronizar" e vê a versão 1 com o relatório', {
    timeout: 90_000,
  }, async ({ app, screen }) => {
    // A Sincronização é paga pela Chave do Workspace.
    const chave = await fetch(`${app.baseUrl}/api/workspace-key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-e2e" }),
    });
    if (!chave.ok) throw new Error(`PUT /api/workspace-key: ${chave.status}`);
    const nome = `Curso Sincronizado ${Date.now()}`;
    await app.open("/wikis");
    await screen.getByRole("textbox", "Nome da Wiki").fill(nome);
    await screen.getByRole("textbox", "Descrição da Wiki").fill("O curso transcrito, aula por aula.");
    await screen.getByRole("button", "Criar").tap();

    const wiki = screen.getByRole("listitem", `Wiki ${nome}`);
    await expect(wiki.getByRole("button", "Nada a sincronizar")).toBeDisabled();
    await wiki.getByLabel("Subir Fontes (.txt ou .md)").setInputFiles(
      arquivos({
        "ganchos.md": "# Ganchos\n\nO gancho vem nos 3 primeiros segundos.\n",
        "carrossel.txt": "Uma ideia por cartão.",
      }),
    );
    await expect(wiki).toContainText("2 Fontes pendentes");

    await wiki.getByRole("button", "Sincronizar").tap();

    // O estado chega em tempo real: o botão diz que há uma em curso, e o fim aparece sem recarregar.
    await expect(wiki.getByRole("button", "Sincronização em curso")).toBeDisabled();
    await expect(wiki.getByRole("status").filter({ hasText: "Sincronização" })).toContainText(
      "Sincronização concluída: versão 1",
      { timeout: 30_000 },
    );
    await expect(wiki.getByRole("list", "Relatório da Sincronização")).toContainText(
      "Páginas criadas: carrossel.txt, Ganchos",
    );
    await expect(wiki).toContainText("versão 1, sincronizada em");
    await expect(wiki).toContainText("nada pendente");
    await expect(wiki.getByRole("list", `Versões de ${nome}`)).toContainText("Versão 1");
    await expect(wiki.getByRole("button", "Nada a sincronizar")).toBeDisabled();
  });

  test('a tela da Articuladora mostra "Sincronizar a Wiki" como Habilidade do Shearim, só para leitura', {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    await app.open("/agentes");
    const sophya = screen
      .getByRole("list", "Agentes do Workspace")
      .getByRole("listitem")
      .filter({ hasText: "Articuladora" });
    await sophya.getByRole("button", "Editar").tap();

    const habilidades = sophya.getByRole("group").filter({ hasText: "Habilidades" });
    await expect(habilidades).toContainText("Sincronizar a Wiki");
    await expect(habilidades).toContainText("do Shearim");
    const doShearim = habilidades.getByRole("checkbox", { disabled: true });
    await expect(doShearim).toHaveCount(1);
    await expect(doShearim).toBeChecked();
  });
});
