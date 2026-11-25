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
  const name = `Licao${Date.now() % 1_000_000}`;
  await chamar(app, "POST", "/api/agents", {
    name,
    description: "Aprende.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const agents = await chamar<{ id: string; name: string }[]>(app, "GET", "/api/agents");
  const agent = agents.find((a) => a.name === name)!;
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return name;
}

describe("Memória do Agente", () => {
  test('a correção vira "guardou na Memória de <Agente>", aparece na tela do Agente, e o Admin apaga o Agente', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    const licao = `Não abrir issue sem label ${Date.now()}.`;
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} não abra issue sem label [lição: ${licao}]`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    await expect(origem.getByRole("status").filter({ hasText: "na Memória" })).toHaveText(
      `guardou na Memória de ${agente}: ${licao}`,
      { timeout: 30_000 },
    );

    await screen.getByRole("button", agente).tap();
    const tela = screen.getByRole("complementary", `Agente ${agente}`);
    const memoria = tela.getByRole("list", "Itens da Memória do Agente");
    await expect(memoria.getByRole("listitem").filter({ hasText: licao })).toContainText(
      `de Pessoa Dev: “${pergunta}”`,
    );

    await tela.getByRole("button", "Apagar Agente").tap();
    await tela.getByRole("button", "Apagar").tap();

    await expect(tela).toContainText("Este Agente foi apagado.");
    await expect(origem.getByRole("status").filter({ hasText: "na Memória" })).toHaveCount(0);
  });
});
