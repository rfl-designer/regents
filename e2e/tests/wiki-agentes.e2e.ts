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

describe("Wiki ligada a Agentes", () => {
  test("a tela do Agente mostra as Wikis ao lado das Ferramentas e das Habilidades; o Admin liga uma, e ela continua ligada depois de recarregar", {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    const sufixo = Date.now() % 1_000_000;
    const agente = `Faro${sufixo}`;
    const wiki = `Financeiro ${sufixo}`;
    await chamar(app, "POST", "/api/agents", {
      name: agente,
      description: "Finanças.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "POST", "/api/wikis", { name: wiki, description: "O caixa e as metas." });

    const abrir = async () => {
      await app.open("/agentes");
      const item = screen
        .getByRole("list", "Agentes do Workspace")
        .getByRole("listitem")
        .filter({ hasText: `@${agente.toLowerCase()}` });
      await item.getByRole("button", "Editar").tap();
      return item.getByRole("group", `Wikis de ${agente}`);
    };

    const wikis = await abrir();
    await expect(wikis).toContainText("O caixa e as metas.");
    const caixa = wikis.getByRole("checkbox", wiki);
    await expect(caixa).not.toBeChecked();
    await caixa.tap();
    await expect(caixa).toBeChecked();

    const deNovo = (await abrir()).getByRole("checkbox", wiki);
    await expect(deNovo).toBeChecked();
    await deNovo.tap();
    await expect(deNovo).not.toBeChecked();
  });
});
