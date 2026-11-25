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

/** Grava a Chave, cria um Agente de nome único e o põe no #geral. */
async function agenteNoGeral(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const name = `Memo${Date.now() % 1_000_000}`;
  const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
    name,
    description: "Lembra.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return name;
}

describe("Memória da Conversa", () => {
  test('depois da resposta, o Andamento mostra "guardou na Memória" e o item aparece na lista Memória do Canal', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    const fato = `O preço sobe em janeiro ${Date.now()}.`;
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} avisa os clientes [lembrar: ${fato}]`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    await expect(origem.getByRole("status").filter({ hasText: "guardou na Memória" })).toHaveText(
      `guardou na Memória: ${fato}`,
      { timeout: 30_000 },
    );
    await screen.getByRole("button", "Memória").tap();
    const lista = screen.getByRole("complementary", "Memória de #geral");
    await expect(lista.getByRole("listitem").filter({ hasText: fato })).toContainText(`de Pessoa Dev: “${pergunta}”`);
  });
});
