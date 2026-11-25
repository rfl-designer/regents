import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

/** O CRM falso que o `serve.ts` deste app subiu (o arquivo leva a porta do app). */
const crm = (app: { baseUrl: string }) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../.e2e/crm-${new URL(app.baseUrl).port}.json`), "utf8")) as {
    url: string;
    token: string;
  };

describe("Conector com a credencial de cada Membro", () => {
  test('sem a credencial, o Andamento mostra a Ferramenta indisponível com "Ligar CRM", e o Membro liga a dele em Meus Conectores', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const { url, token } = crm(app);
    const sufixo = Date.now() % 1_000_000;
    const nome = `CRM${sufixo}`;
    await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
    // O Admin adiciona no modo de cada Membro; o token dele vira a credencial dele.
    const conector = await chamar<{ id: string; tools: { id: string }[] }>(app, "POST", "/api/connectors", {
      name: nome,
      url,
      token,
      credential: "member",
    });
    const agente = `Vendas${sufixo}`;
    const criado = await chamar<{ id: string }>(app, "POST", "/api/agents", {
      name: agente,
      description: "Consulta o CRM.",
      instructions: "Responda curto.",
      model: "claude-haiku-5-5",
    });
    await chamar(app, "PUT", `/api/agents/${criado.id}/tools/${conector.tools[0]!.id}`);
    const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
    await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: criado.id });

    // Em Meus Conectores, ele vê a dele ligada e a desliga.
    await app.open("/");
    await screen.getByRole("button", "Meus Conectores").tap();
    const item = screen.getByRole("listitem", `Conector ${nome}`);
    await expect(item).toContainText("Ligado com a sua credencial.");
    await item.getByRole("button", "Desligar").tap();
    await expect(item).toContainText("Desligado");

    // Sem a credencial dele, a Ferramenta fica indisponível, e o Andamento dá o atalho.
    await screen.getByRole("button", "Voltar à conversa").tap();
    await screen.getByRole("button", /^# geral/).tap();
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    await screen.getByRole("textbox", "Mensagem para #geral").fill(`@${agente} [crm] a Acme é cliente? ${sufixo}`);
    await screen.getByRole("button", "Enviar").tap();
    await expect(
      screen.getByText(`buscar cliente falhou: indisponível: o autor não ligou o ${nome}`, { exact: false }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(screen.getByRole("link", `Ligar ${nome}`)).toHaveAttribute("href", "/perfil/conectores");

    // O atalho leva a Meus Conectores, onde ele cola o token e liga de novo.
    await app.open("/perfil/conectores");
    const deNovo = screen.getByRole("listitem", `Conector ${nome}`);
    await deNovo.getByLabel(`Seu token do ${nome}`).fill(token);
    await deNovo.getByRole("button", "Ligar com o token").tap();
    await expect(deNovo).toContainText("Ligado com a sua credencial.");
  });
});
