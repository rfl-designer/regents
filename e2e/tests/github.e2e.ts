import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Chama a API como a "Pessoa Dev" (a primeira a chegar, Admin), sem passar pela tela. */
async function chamar<T>(app: { baseUrl: string }, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Segue um redirecionamento do GitHub falso de volta ao Shearim, como o navegador do Admin. */
async function voltar(res: Response) {
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`o GitHub não redirecionou (${res.status})`);
  const volta = await fetch(location, { redirect: "manual" });
  if (!volta.headers.get("location")?.includes("github="))
    throw new Error(`o retorno falhou: ${volta.headers.get("location")}`);
}

/** Cria o GitHub App na organização `time` e o instala (alcança `time/site` e `time/infra`). */
async function ligarGitHub(app: { baseUrl: string }) {
  const { action, manifest } = await chamar<{ action: string; manifest: string }>(app, "POST", "/api/github/manifest", {
    origin: app.baseUrl,
    organization: "time",
  });
  await voltar(await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" }));
  const { url } = await chamar<{ url: string }>(app, "POST", "/api/github/installation");
  await voltar(await fetch(url, { redirect: "manual" }));
}

describe("Repositórios do GitHub por Agente", () => {
  test("na tela do Agente, o Admin restringe o Agente a um dos repositórios que a instalação alcança", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    await ligarGitHub(app);
    const agente = `Faro${Date.now() % 1_000_000}`;
    const criado = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name: agente,
      description: "Engenharia: o site.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "PUT", `/api/agents/${criado.id}/tools/github_ler_arquivo`);

    await app.open("/");
    await screen.getByRole("button", "Agentes").tap();
    const item = screen
      .getByRole("list", "Agentes do Workspace")
      .getByRole("listitem")
      .filter({ hasText: `@${agente.toLowerCase()}` });
    await expect(item).toContainText("acessa o GitHub com a credencial do Workspace");
    await item.getByRole("button", "Editar").tap();

    const repos = item.getByRole("group", `Repositórios do GitHub de ${agente}`);
    // Sem lista, o Agente alcança tudo o que a instalação alcança.
    await expect(repos.getByRole("radio", "Todos os que a instalação do GitHub alcança")).toBeChecked();
    await repos.getByRole("radio", "Só estes:").tap();
    await expect(repos.getByRole("checkbox", "time/infra")).not.toBeChecked();
    await repos.getByRole("checkbox", "time/site").tap();
    await repos.getByRole("button", "Salvar repositórios").tap();

    await expect(repos).toContainText("Salvo.");
    // A lista é configuração do Admin: a descrição do Agente não a repete.
    await expect(item).toContainText("acessa o GitHub com a credencial do Workspace");
    await expect(item).not.toContainText("só no repositório");
    const salvo = await chamar<{ repositories: string[] | null }>(app, "GET", `/api/agents/${criado.id}/github`);
    expect(salvo.repositories).toEqual(["time/site"]);
  });
});
