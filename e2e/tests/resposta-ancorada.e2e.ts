import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** O que a Messages API falsa do `serve.ts` responde, devagar, a toda chamada. */
const RESPOSTA = "Oi! Tudo certo por aqui: o prazo é sexta-feira.";

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

/** Grava a Chave, cria um Agente de nome único e o põe no #geral. Devolve o nome. */
async function agenteNoGeral(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const name = `Faro${Date.now() % 1_000_000}`;
  const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
    name,
    description: "Comercial.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return name;
}

describe("resposta ancorada", () => {
  test("enquanto o texto chega, a bolha escrevendo fica no lugar da resposta", async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} qual o prazo? ${Date.now()}`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    await mensagens.getByText(pergunta).waitFor();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    const bolha = origem.getByRole("status", `${agente} escrevendo`);
    await expect(bolha).toContainText(/escrevendo.* · \d:\d\d/);
  });

  test("a resposta do Agente aparece ancorada sob a mensagem de origem", async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} e a proposta? ${Date.now()}`;
    const depois = `Enquanto isso, outra coisa ${Date.now()}`;
    const composer = screen.getByRole("textbox", "Mensagem para #geral");

    await composer.fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    await mensagens.getByText(pergunta).waitFor();
    await composer.fill(depois);
    await screen.getByRole("button", "Enviar").tap();
    await mensagens.getByText(depois).waitFor();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    const respostas = origem.getByRole("list", "Respostas a Pessoa Dev");
    // A fila de execuções é uma só e serial (#42 traz o paralelismo): no e2e, a resposta espera as dos outros testes.
    await expect(respostas.getByRole("article", `Mensagem de ${agente}`)).toContainText(RESPOSTA, {
      timeout: 60_000,
    });
    await expect(mensagens.getByRole("listitem").filter({ hasText: depois })).not.toContainText(RESPOSTA);
  });
});
