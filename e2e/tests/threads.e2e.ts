import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** O que a Messages API falsa do `serve.ts` responde a toda chamada de Agente. */
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

/**
 * Um Canal novo com dois Agentes de nome único, e a Chave gravada. A Messages API falsa delega
 * aos dois a mensagem com `[delegar]` e dá "nenhum" às outras.
 */
async function canalComDoisAgentes(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const sufixo = Date.now() % 1_000_000;
  const canal = await chamar<{ id: string; name: string }>(app, "POST", "/api/channels", {
    name: `thread-${sufixo}`,
    kind: "public",
  });
  const nomes = [`Faro${sufixo}`, `Prisma${sufixo}`];
  for (const name of nomes) {
    const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name,
      description: "Especialista.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "POST", `/api/channels/${canal.id}/agents`, { agentId: agent.id });
  }
  return { canal: canal.name, faro: nomes[0]!, prisma: nomes[1]! };
}

describe("Threads", () => {
  test("um Membro abre a Thread de uma mensagem e responde nela; o Desfecho e as respostas ficam no painel, fora do Canal", {
    timeout: 180_000,
  }, async ({ app, screen }) => {
    const { canal, faro, prisma } = await canalComDoisAgentes(app);
    await app.open("/");
    await screen.getByRole("button", `# ${canal}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const raiz = `Chegou a proposta da Acme ${Date.now()}`;
    await screen.getByRole("textbox", `Mensagem para #${canal}`).fill(raiz);
    await screen.getByRole("button", "Enviar").tap();
    const origem = mensagens.getByRole("listitem").filter({ hasText: raiz }).first();
    await origem.waitFor();

    await origem.getByRole("button", "Responder na Thread").tap();

    const painel = screen.getByRole("complementary", "Thread");
    await expect(painel.getByRole("article", "Mensagem de Pessoa Dev").first()).toContainText(raiz);
    const pergunta = `Qual desconto dá? [delegar] ${Date.now()}`;
    await painel.getByRole("textbox", "Responder na Thread").fill(pergunta);
    await painel.getByRole("button", "Enviar").tap();

    const naThread = painel
      .getByRole("list", "Mensagens da Thread")
      .getByRole("listitem")
      .filter({ hasText: pergunta });
    await expect(naThread.getByRole("button", `↳ Sophya passou para ${faro} e ${prisma}`)).toBeVisible({
      timeout: 20_000,
    });
    const respostas = naThread.getByRole("list", "Respostas a Pessoa Dev");
    // Os dois delegados respondem em paralelo (#42).
    await expect(respostas.getByRole("article", `Mensagem de ${faro}`)).toContainText(RESPOSTA, { timeout: 20_000 });
    await expect(respostas.getByRole("article", `Mensagem de ${prisma}`)).toContainText(RESPOSTA, {
      timeout: 20_000,
    });
    await expect(painel.getByText("Você segue esta Thread")).toBeVisible();

    // No Canal, só o resumo da Thread sob a raiz.
    await expect(mensagens.getByText(pergunta)).toHaveCount(0);
    await expect(origem.getByRole("button", "3 respostas")).toBeVisible();
    await painel.getByRole("button", "Fechar").tap();
    await expect(painel).toHaveCount(0);
    await origem.getByRole("button", "3 respostas").tap();
    await expect(screen.getByRole("complementary", "Thread").getByText(pergunta)).toBeVisible();
  });
});
