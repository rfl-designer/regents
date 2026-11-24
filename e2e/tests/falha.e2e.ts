import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { addMember, as, newPerson } from "../support/people";

/** O que a Messages API falsa do `serve.ts` responde quando não falha. */
const RESPOSTA = "Oi! Tudo certo por aqui: o prazo é sexta-feira.";
/** A falha passa pela nova tentativa automática, 10 s depois, antes do cartão. */
const ATE_O_CARTAO = 30_000;

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
  const name = `Prisma${Date.now() % 1_000_000}`;
  const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
    name,
    description: "Dados.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return { name, geralId: geral!.id };
}

describe("cartão de falha", () => {
  test('depois das duas tentativas, quem escreveu vê o motivo e "Tentar de novo"', { timeout: 180_000 }, async ({
    app,
    screen,
  }) => {
    const { name: agente } = await agenteNoGeral(app);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} quantos chamados? [falhe 2x] ${Date.now()}`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    await mensagens.getByText(pergunta).waitFor();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    const cartao = origem.getByRole("group", `Falha de ${agente}`);
    await expect(cartao).toContainText(
      `${agente} não respondeu: a Anthropic está sobrecarregada, nas duas tentativas.`,
      {
        timeout: ATE_O_CARTAO,
      },
    );
    await expect(cartao.getByRole("button", "Tentar de novo")).toBeVisible();
  });

  test('"Tentar de novo" refaz a resposta, que entra ancorada no lugar do cartão', { timeout: 180_000 }, async ({
    app,
    screen,
  }) => {
    const { name: agente } = await agenteNoGeral(app);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} e o relatório? [falhe 2x] ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    const cartao = origem.getByRole("group", `Falha de ${agente}`);
    await cartao.getByRole("button", "Tentar de novo").waitFor({ timeout: ATE_O_CARTAO });

    await cartao.getByRole("button", "Tentar de novo").tap();

    await expect(origem.getByRole("article", `Mensagem de ${agente}`)).toContainText(RESPOSTA, { timeout: 20_000 });
    await expect(cartao).toHaveCount(0);
  });

  test('quem não escreveu vê o cartão sem "Tentar de novo"', { timeout: 180_000 }, async ({ app, screen }) => {
    const { name: agente, geralId } = await agenteNoGeral(app);
    const bruno = newPerson("Bruno");
    await addMember(app.baseUrl, bruno);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} pergunta do Bruno [falhe 2x] ${Date.now()}`;

    await as(app.baseUrl, bruno)(`/api/channels/${geralId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: pergunta }),
    });

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    const cartao = origem.getByRole("group", `Falha de ${agente}`);
    await expect(cartao).toContainText("nas duas tentativas", { timeout: ATE_O_CARTAO });
    await expect(cartao.getByRole("button", "Tentar de novo")).toHaveCount(0);
  });
});
