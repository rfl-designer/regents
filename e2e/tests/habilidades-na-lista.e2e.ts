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

describe("Habilidades na lista de Agentes", () => {
  test("a lista de Agentes mostra o nome e a descrição das Habilidades ativas de cada um, e não o corpo", {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    const sufixo = Date.now() % 1_000_000;
    const agente = `Social${sufixo}`;
    const habilidade = `Criar carrossel ${sufixo}`;
    const criado = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name: agente,
      description: "Redes sociais.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    const skill = await chamar<{ id: string }>(app, "POST", "/api/skills", {
      name: habilidade,
      description: "Use quando pedirem um carrossel.",
      body: "Uma ideia por slide.",
    });
    await chamar(app, "PUT", `/api/agents/${criado.id}/skills/${skill.id}`);
    const linha = `Redes sociais. · Sem Ferramentas · Habilidades: ${habilidade} (Use quando pedirem um carrossel.)`;

    // A lista que todo Membro vê ao abrir uma DM com um Agente.
    await app.open("/");
    await screen.getByRole("button", "+ Nova DM").tap();
    const naDm = screen.getByRole("list", "Conversar com um Agente").getByRole("listitem").filter({ hasText: agente });
    await expect(naDm).toContainText(linha);
    await expect(naDm).not.toContainText("Uma ideia por slide");

    // A tela de Agentes do Admin também.
    await screen.getByRole("button", "Agentes").tap();
    const naAdministracao = screen
      .getByRole("list", "Agentes do Workspace")
      .getByRole("listitem")
      .filter({ hasText: `@${agente.toLowerCase()}` });
    await expect(naAdministracao).toContainText(
      `Sem Ferramentas · Habilidades: ${habilidade} (Use quando pedirem um carrossel.)`,
    );
  });
});
