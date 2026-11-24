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

describe("Ferramentas dos Agentes", () => {
  test('o Admin concede "listar Agentes" na tela do Agente, e a resposta pela Chave vem com o resultado dela', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
    const agente = `Guia${Date.now() % 1_000_000}`;
    const criado = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name: agente,
      description: "Indica quem atende cada coisa.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
    await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: criado.id });

    await app.open("/");
    await screen.getByRole("button", "Agentes").tap();
    const item = screen
      .getByRole("list", "Agentes do Workspace")
      .getByRole("listitem")
      .filter({ hasText: `@${agente.toLowerCase()}` });
    await item.getByRole("button", "Editar").tap();
    const ferramentas = item.getByRole("group", `Ferramentas de ${agente}`);
    await expect(ferramentas).toContainText("leitura");
    const listar = ferramentas.getByRole("checkbox", /listar Agentes/);
    await expect(listar).not.toBeChecked();
    await listar.tap();
    await expect(listar).toBeChecked();

    await screen.getByRole("button", /^# geral/).tap();
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} [listar agentes] quem cuida de contratos? ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    // A primeira linha do resultado de "listar Agentes" é a Articuladora (o nome dela pode mudar).
    await expect(mensagens.getByRole("listitem").filter({ hasText: pergunta })).toContainText(
      /Pela Ferramenta: - .+, a Articuladora/,
      { timeout: 30_000 },
    );
  });
});
