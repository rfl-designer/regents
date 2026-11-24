import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** O que a Messages API falsa do `serve.ts` responde quando não falha. */
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

/** Grava a Chave, cria um Agente de nome único e o põe no #geral. */
async function agenteNoGeral(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const name = `Cofre${Date.now() % 1_000_000}`;
  const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
    name,
    description: "Finanças.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return { name, id: agent.id };
}

/**
 * Guarda em `<html data-incidente>` o texto da faixa "Incidente da Chave" quando ela aparece. O
 * incidente é do Workspace inteiro e o banco é da execução: um teste em paralelo que tem uma
 * resposta pela Chave logo depois da recusa encerra o incidente, e a faixa pode sumir antes de o
 * teste olhar. O que se confere é que ela apareceu. Roda antes do PWA.
 */
function registraFaixaDoIncidente() {
  new MutationObserver(() => {
    const faixa = document.querySelector('section[aria-label="Incidente da Chave"]');
    if (faixa) document.documentElement.setAttribute("data-incidente", faixa.textContent ?? "");
  }).observe(document, { childList: true, subtree: true });
}

describe("Chave e orçamentos", () => {
  test("o Admin põe o orçamento no formulário do Agente; estourado, vê a faixa, e o Agente não age pela Chave", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const { name: agente, id } = await agenteNoGeral(app);
    await app.open("/");
    await screen.getByRole("button", "Agentes").tap();
    const item = screen
      .getByRole("list", "Agentes do Workspace")
      .getByRole("listitem")
      .filter({ hasText: `@${agente.toLowerCase()}` });
    await expect(item).toContainText("Gasto na Chave este mês");
    await expect(item).toContainText("sem orçamento");

    await item.getByRole("button", "Editar").tap();
    await item.getByRole("textbox", "Orçamento mensal na Chave").fill("0");
    await item.getByRole("button", "Salvar").tap();

    await expect(item).toContainText("estourado: não usa a Chave até o mês virar");
    const faixa = screen.getByRole("region", "Orçamento estourado");
    await expect(faixa).toContainText(`${agente} estourou o orçamento do mês na Chave`);

    // Sem Conta ligada, a Pessoa Dev vê "Agentes não agem" com o motivo.
    await expect(faixa.getByRole("button", "Ver Agentes")).toBeVisible();
    await screen.getByRole("button", /^# geral/).tap();
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} quanto sobrou? ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();
    await expect(mensagens.getByRole("listitem").filter({ hasText: pergunta })).toContainText(
      `Agentes não agem: você não ligou uma Conta e ${agente} estourou o orçamento do mês na Chave`,
      { timeout: 30_000 },
    );

    // Sem teto de novo: a faixa some.
    await chamar(app, "PATCH", `/api/agents/${id}`, { monthlyBudgetUsd: null });
    await expect(screen.getByRole("region", "Orçamento estourado")).toBeHidden();
  });

  test("a Chave recusada abre a faixa do incidente para o Admin, que some na primeira resposta pela Chave", {
    timeout: 120_000,
  }, async ({ app, screen, browser }) => {
    const { name: agente } = await agenteNoGeral(app);
    await browser.addInitScript(registraFaixaDoIncidente);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");

    const recusada = `@${agente} pode pagar? [chave recusada] ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(recusada);
    await screen.getByRole("button", "Enviar").tap();
    await expect(
      mensagens.getByRole("listitem").filter({ hasText: recusada }).getByRole("group", `Falha de ${agente}`),
    ).toContainText(`${agente} não respondeu: a Chave do Workspace foi recusada pela Anthropic.`, { timeout: 30_000 });
    await expect(browser.locator("html")).toHaveAttribute("data-incidente", /A Anthropic recusou a Chave do Workspace/);

    const depois = `@${agente} e agora? ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(depois);
    await screen.getByRole("button", "Enviar").tap();
    await expect(mensagens.getByRole("listitem").filter({ hasText: depois })).toContainText(RESPOSTA, {
      timeout: 20_000,
    });
    await expect(screen.getByRole("region", "Incidente da Chave")).toBeHidden();
  });
});
