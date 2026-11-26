import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { zip } from "../../apps/server/test/fakes/zip";

/** Grava o `.zip` de uma skill de nome único com um script e uma referência, e devolve o caminho. */
function skillZip(name: string): string {
  const dir = fileURLToPath(new URL("../.e2e/skills/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const path = `${dir}${name}.zip`;
  const skillMd = `---\nname: ${name}\ndescription: Use quando pedirem um carrossel.\n---\n\n# Carrossel\n`;
  writeFileSync(
    path,
    zip({
      [`${name}/SKILL.md`]: skillMd,
      [`${name}/scripts/gerar.py`]: "print('slide')\n",
      [`${name}/referencia.md`]: "# Referência\n",
    }),
  );
  return path;
}

/** Grava a pasta de uma skill de nome único com um script e uma referência, e devolve o caminho. */
function skillFolder(name: string): string {
  const dir = fileURLToPath(new URL(`../.e2e/skills/${name}/`, import.meta.url));
  mkdirSync(`${dir}scripts`, { recursive: true });
  writeFileSync(
    `${dir}SKILL.md`,
    `---\nname: ${name}\ndescription: Use quando pedirem um carrossel.\n---\n\n# Carrossel\n`,
  );
  writeFileSync(`${dir}scripts/gerar.py`, "print('slide')\n");
  writeFileSync(`${dir}referencia.md`, "# Referência\n");
  return dir;
}

describe("importar SKILL.md", () => {
  test("o Admin importa o .zip de uma skill e vê a Habilidade importada e os arquivos que ficaram de fora", async ({
    app,
    screen,
  }) => {
    const name = `carrossel-${Date.now() % 1_000_000}`;
    await app.open("/");
    await screen.getByRole("button", "Habilidades").tap();

    const form = screen.getByRole("form", "Importar SKILL.md");
    await form.getByLabel("Arquivo SKILL.md ou .zip").setInputFiles(skillZip(name));
    await form.getByRole("button", "Importar").tap();

    await expect(form.getByRole("status")).toContainText(`Habilidade ${name} importada.`);
    await expect(form.getByRole("list", "Arquivos ignorados").getByRole("listitem")).toHaveText([
      "referencia.md",
      "scripts/gerar.py",
    ]);
    const item = screen.getByRole("list", "Habilidades").getByRole("listitem").filter({ hasText: name });
    await expect(item).toContainText("importada");
  });

  test("o Admin escolhe a pasta de uma skill e vê a Habilidade importada e os arquivos que ficaram de fora", async ({
    app,
    screen,
  }) => {
    const name = `pasta-${Date.now() % 1_000_000}`;
    await app.open("/");
    await screen.getByRole("button", "Habilidades").tap();

    const form = screen.getByRole("form", "Importar SKILL.md");
    await form.getByLabel("Pasta com o SKILL.md").setInputFiles(skillFolder(name));
    await form.getByRole("button", "Importar").tap();

    await expect(form.getByRole("status")).toContainText(`Habilidade ${name} importada.`);
    await expect(form.getByRole("list", "Arquivos ignorados").getByRole("listitem")).toHaveText([
      "referencia.md",
      "scripts/gerar.py",
    ]);
  });
});
