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

/**
 * Um Canal novo com dois Agentes de nome único, e a Chave gravada. A Messages API falsa do
 * `serve.ts` delega aos dois a mensagem com `[delegar]` e dá "nenhum" às outras.
 */
async function canalComDoisAgentes(app: { baseUrl: string }) {
  await chamar(app, "PUT", "/api/workspace-key", { apiKey: "sk-ant-e2e" });
  const sufixo = Date.now() % 1_000_000;
  const canal = await chamar<{ id: string; name: string }>(app, "POST", "/api/channels", {
    name: `desfecho-${sufixo}`,
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

describe("Desfecho", () => {
  test("a delegação aparece como uma linha discreta sob a mensagem, com o motivo e as frases ao tocar", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const { canal, faro, prisma } = await canalComDoisAgentes(app);
    await app.open("/");
    await screen.getByRole("button", `# ${canal}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `Como fica a proposta? [delegar] ${Date.now()}`;

    await screen.getByRole("textbox", `Mensagem para #${canal}`).fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta }).first();
    const linha = origem.getByRole("button", `↳ Sophya passou para ${faro} e ${prisma}`);
    await expect(linha).toBeVisible({ timeout: 20_000 });
    await linha.tap();
    const detalhe = origem.getByRole("list", "Por que e o que cada um cobre");
    await expect(detalhe).toContainText("Cada um cobre uma parte.");
    await expect(detalhe).toContainText(`${faro}: A parte de @${faro.toLowerCase()}.`);
  });

  test("quando nenhum Agente precisa agir, só aparece um ⌀ ao lado da hora, com o motivo ao tocar", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const { canal } = await canalComDoisAgentes(app);
    await app.open("/");
    await screen.getByRole("button", `# ${canal}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const recado = `Bom dia, pessoal! ${Date.now()}`;

    await screen.getByRole("textbox", `Mensagem para #${canal}`).fill(recado);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: recado }).first();
    const marca = origem.getByRole("button", "Sophya: nenhum Agente precisa agir. É conversa entre pessoas.");
    await expect(marca).toHaveText("⌀", { timeout: 20_000 });
    await expect(origem.getByRole("list", `Respostas a Pessoa Dev`)).toHaveCount(0);
    await marca.tap();
    await expect(origem.getByText("Sophya: nenhum Agente precisa agir. É conversa entre pessoas.")).toBeVisible();
  });
});
