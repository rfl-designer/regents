import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** O que a Messages API falsa do `serve.ts` responde, devagar (uns 5 s), a toda chamada. */
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

/** Grava a Chave e põe no #geral cinco Agentes de nome único. Devolve os nomes. */
async function cincoAgentesNoGeral(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  const sufixo = Date.now() % 1_000_000;
  const nomes = ["Ana", "Bia", "Caio", "Davi", "Eva"].map((n) => `${n}${sufixo}`);
  for (const name of nomes) {
    const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name,
      description: "Ajuda.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  }
  return nomes;
}

describe("concorrência", () => {
  test('acima do teto da Chave (4), o quinto Agente fica "esperando a vez" e responde depois', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const nomes = await cincoAgentesNoGeral(app);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `${nomes.map((n) => `@${n}`).join(" ")} qual o prazo? ${Date.now()}`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    // Quatro saem pela Chave ao mesmo tempo; o quinto espera a vez dele.
    const esperando = origem.getByRole("status", `${nomes[4]} esperando a vez`);
    await expect(esperando).toBeVisible({ timeout: 20_000 });
    await expect(esperando).toHaveText(`${nomes[4]} · esperando a vez`);
    const respostas = origem.getByRole("list", "Respostas a Pessoa Dev");
    for (const nome of nomes) {
      await expect(respostas.getByRole("article", `Mensagem de ${nome}`)).toContainText(RESPOSTA, {
        timeout: 30_000,
      });
    }
    await expect(esperando).toHaveCount(0);
  });
});
