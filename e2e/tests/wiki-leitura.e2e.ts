import { describe, test } from "@e2e-dev/web";
import type { WikiDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, jsonBody, newPerson } from "../support/people";

/**
 * Um Membro navega pela Wiki (#82): a seção "Wikis" da barra lateral, o índice, os links entre as
 * páginas (o quebrado marcado), as Fontes da página e "sincronizando…" em tempo real. A Pessoa Dev
 * (Admin) monta a Wiki pela API; quem lê é o Bruno, no navegador.
 */

/** A Pessoa Dev sobe a Fonte e sincroniza; espera a versão sair (ou não). */
async function sincronizar(baseUrl: string, wiki: WikiDto, arquivo: string, texto: string, esperar = true) {
  const form = new FormData();
  form.append("files", new File([texto], arquivo));
  await as(baseUrl)(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  await as(baseUrl)(`/api/wikis/${wiki.id}/sync`, { method: "POST" });
  if (!esperar) return;
  for (let i = 0; i < 100; i++) {
    const lista: WikiDto[] = await as(baseUrl)("/api/wiki-settings");
    if (lista.find((w) => w.id === wiki.id)?.lastSync?.state === "done") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("a Sincronização não terminou");
}

describe("Leitura da Wiki", () => {
  test("o Membro abre a Wiki pela barra lateral, segue um link e vê as Fontes da página", {
    timeout: 90_000,
  }, async ({ app, screen }) => {
    await as(app.baseUrl)("/api/workspace-key", jsonBody("PUT", { apiKey: "sk-ant-e2e" }));
    const nome = `Curso Lido ${Date.now()}`;
    const wiki: WikiDto = await as(app.baseUrl)(
      "/api/wikis",
      jsonBody("POST", { name: nome, description: "O curso transcrito, aula por aula." }),
    );
    await sincronizar(
      app.baseUrl,
      wiki,
      "ganchos.md",
      "# Ganchos\n\nO gancho vem nos 3 primeiros segundos. Veja também [[legendas|as legendas]].\n",
    );

    const bruno = newPerson("Bruno");
    await addMember(app.baseUrl, bruno);
    await app.open(`/dev/como/${bruno.id}?nome=Bruno`);

    const barra = screen.getByRole("navigation", "Conversas");
    await barra.getByRole("list", "Wikis").getByRole("button", nome).tap();

    // Abrir a Wiki mostra o índice, com a data da última Sincronização.
    const leitura = screen.getByRole("main", `Wiki ${nome}`);
    await expect(leitura.getByRole("heading", nome)).toBeVisible();
    await expect(leitura.getByRole("status")).toContainText("sincronizada em");
    const indice = leitura.getByRole("article", "Índice");
    await expect(indice).toBeVisible();

    // O link do índice leva à página; o link para uma página que não existe fica marcado.
    await indice.getByRole("link", "Ganchos").tap();
    const pagina = leitura.getByRole("article", "Ganchos");
    await expect(pagina).toContainText("O gancho vem nos 3 primeiros segundos.");
    await expect(pagina).toContainText("as legendas (página que não existe)");
    await expect(pagina.getByRole("link", "as legendas")).toHaveCount(0);
    await expect(leitura.getByRole("region", "Fontes da página")).toContainText("ganchos.md");

    // Uma Sincronização nova: "sincronizando…" chega sem recarregar, e a versão nova no fim.
    await sincronizar(app.baseUrl, wiki, "legendas.md", "# Legendas\n\nLegenda sempre ligada.\n", false);
    await expect(leitura.getByRole("status")).toContainText("sincronizando…");
    await expect(leitura.getByRole("status")).toContainText("sincronizada em", { timeout: 30_000 });
    await expect(pagina.getByRole("link", "as legendas")).toBeVisible();

    // Uma página que não existe diz isso.
    await app.open(`/wiki/${wiki.id}/nao-existe`);
    await expect(screen.getByRole("alert")).toContainText(`Essa página não existe na Wiki ${nome}.`);
  });
});
