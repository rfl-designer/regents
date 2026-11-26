import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "@e2e-dev/web";
import type { WikiDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, jsonBody, newPerson } from "../support/people";

/**
 * A citação da Wiki na resposta (#85): a Pessoa Dev (Admin) sobe uma Fonte e sincroniza pela tela;
 * o Bruno pergunta em #marketing, abre a página pela citação da resposta e navega pelo índice. O
 * Agente lê e cita pela Messages API falsa (`[wiki: <Wiki>/<página>]`, em `serve.ts`).
 */

/** Arquivos de verdade numa pasta temporária, para o seletor de arquivos. */
function arquivos(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "shearim-citacao-"));
  return Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
}

describe("Citação da Wiki", () => {
  test("o Admin sincroniza uma Fonte, o Membro pergunta em #marketing, abre a página pela citação e navega pelo índice", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const eu = as(app.baseUrl);
    await eu("/api/workspace-key", jsonBody("PUT", { apiKey: "sk-ant-e2e" }));
    const n = Date.now() % 1_000_000;
    const nome = `Curso Citado ${n}`;

    // O Admin cria a Wiki, sobe a Fonte e sincroniza pela tela.
    await app.open("/wikis");
    await screen.getByRole("textbox", "Nome da Wiki").fill(nome);
    await screen.getByRole("textbox", "Descrição da Wiki").fill("O curso transcrito, aula por aula.");
    await screen.getByRole("button", "Criar").tap();
    const naAdministracao = screen.getByRole("listitem", `Wiki ${nome}`);
    await naAdministracao
      .getByLabel("Subir Fontes (.txt ou .md)")
      .setInputFiles(arquivos({ "ganchos.md": "# Ganchos\n\nO gancho vem nos 3 primeiros segundos.\n" }));
    await naAdministracao.getByRole("button", "Sincronizar").tap();
    await expect(naAdministracao.getByRole("status").filter({ hasText: "Sincronização" })).toContainText(
      "Sincronização concluída: versão 1",
      { timeout: 30_000 },
    );

    // O Social em #marketing, com a Wiki ligada ao Canal; o Bruno entra.
    const lista: WikiDto[] = await eu("/api/wiki-settings");
    const wiki = lista.find((w) => w.name === nome)!;
    const social = `Social${n}`;
    const agente = await eu(
      "/api/agents",
      jsonBody("POST", {
        name: social,
        description: "Cuida das redes.",
        instructions: "Responda curto.",
        model: "claude-haiku-5-5",
      }),
    );
    const canal = `marketing-${n}`;
    const marketing = await eu("/api/channels", jsonBody("POST", { name: canal, kind: "public" }));
    await eu(`/api/channels/${marketing.id}/agents`, jsonBody("POST", { agentId: agente.id }));
    await eu(`/api/wikis/${wiki.id}/channels/${marketing.id}`, { method: "PUT" });
    const bruno = newPerson("Bruno");
    await addMember(app.baseUrl, bruno);
    await as(app.baseUrl, bruno)(`/api/channels/${marketing.id}/join`, { method: "POST" });

    // O Bruno pergunta; a resposta cita a página, com o link.
    await app.open(`/dev/como/${bruno.id}?nome=Bruno`);
    await screen.getByRole("navigation", "Conversas").getByRole("button", `# ${canal}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    await screen
      .getByRole("textbox", `Mensagem para #${canal}`)
      .fill(`@${social} como abro um vídeo? [wiki: ${nome}/ganchos]`);
    await screen.getByRole("button", "Enviar").tap();

    const resposta = mensagens.getByRole("article", `Mensagem de ${social}`);
    await expect(resposta).toContainText("Segundo a Wiki: O gancho vem nos 3 primeiros segundos.", {
      timeout: 30_000,
    });
    const citacao = resposta.getByRole("link", `Wiki ${nome}: Ganchos`);
    await expect(citacao).toBeVisible();

    // A citação abre a página na versão lida; o índice leva de volta a ela.
    await citacao.tap();
    const leitura = screen.getByRole("main", `Wiki ${nome}`);
    await expect(leitura.getByRole("article", "Ganchos")).toContainText("O gancho vem nos 3 primeiros segundos.");
    await expect(leitura.getByRole("complementary", "Versão antiga")).toHaveCount(0);
    await leitura.getByRole("link", "Índice").tap();
    const indice = leitura.getByRole("article", "Índice");
    await expect(indice).toBeVisible();
    await indice.getByRole("link", "Ganchos").tap();
    await expect(leitura.getByRole("article", "Ganchos")).toBeVisible();
    await expect(leitura.getByRole("region", "Fontes da página")).toContainText("ganchos.md");

    // Uma Sincronização nova (versão 2): a página aberta pela citação fica na versão 1, com o aviso
    // e o link para a versão atual.
    const form = new FormData();
    form.append("files", new File(["# Legendas\n\nLegenda sempre ligada.\n"], "legendas.md"));
    await eu(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
    await eu(`/api/wikis/${wiki.id}/sync`, { method: "POST" });
    const aviso = leitura.getByRole("complementary", "Versão antiga");
    await expect(aviso).toContainText("Há uma versão mais nova desta Wiki (versão 2).", { timeout: 30_000 });
    await aviso.getByRole("link", "Ler na versão atual").tap();
    await expect(leitura.getByRole("article", "Ganchos")).toBeVisible();
    await expect(leitura.getByRole("complementary", "Versão antiga")).toHaveCount(0);
  });
});
