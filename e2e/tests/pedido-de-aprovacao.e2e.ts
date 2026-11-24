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

describe("Pedido de aprovação", () => {
  test("o cartão aparece sob a mensagem com o resumo exato; o autor aprova e a mensagem sai como do Agente", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
    const agente = `Arauto${Date.now() % 1_000_000}`;
    const criado = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name: agente,
      description: "Avisa o time.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "PUT", `/api/agents/${criado.id}/tools/postar_mensagem`);
    const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
    await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: criado.id });

    await app.open("/");
    await screen.getByRole("button", /^# geral/).tap();
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pedido = `@${agente} [postar] avisa que a reunião mudou ${Date.now()}`;
    await screen.getByRole("textbox", "Mensagem para #geral").fill(pedido);
    await screen.getByRole("button", "Enviar").tap();

    const grupo = mensagens.getByRole("listitem").filter({ hasText: pedido });
    const cartao = grupo.getByRole("group", `Pedido de aprovação de ${agente}`);
    await expect(cartao).toContainText("Postar em #geral: “Aviso: a reunião mudou.”", { timeout: 30_000 });
    await expect(cartao).toContainText("pede a sua aprovação");
    await expect(grupo).toContainText("esperando aprovação de");

    await cartao.getByRole("button", "Aprovar").tap();
    await expect(cartao).toContainText("mensagem postada em #geral", { timeout: 30_000 });
    await expect(cartao.getByRole("button", "Aprovar")).toHaveCount(0);
    await expect(mensagens.getByRole("listitem").filter({ hasText: "Aviso: a reunião mudou." }).first()).toContainText(
      agente,
    );
    // A continuação termina a resposta, ancorada sob a mensagem.
    await expect(grupo).toContainText("Oi! Tudo certo por aqui", { timeout: 30_000 });
  });
});
