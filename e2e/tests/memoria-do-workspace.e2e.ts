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
 * Grava a Chave, cria um Agente de nome único no #geral (Canal público) e guarda `fato` na Memória
 * do #geral por uma troca com ele, pela API.
 */
async function guardadoNoGeral(app: { baseUrl: string }, fato: string) {
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
  await chamar(app, "POST", `/api/conversations/${geral!.id}/messages`, { body: `@${name} anota [lembrar: ${fato}]` });
  const prazo = Date.now() + 30_000;
  while (Date.now() < prazo) {
    const itens = await chamar<{ text: string }[]>(app, "GET", `/api/conversations/${geral!.id}/memory`);
    if (itens.some((i) => i.text === fato)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`o item "${fato}" não foi guardado`);
}

describe("Memória do Workspace", () => {
  test('"Promover ao Workspace" leva o item do #geral à Memória do Workspace, com a origem', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const fato = `O reembolso sai pelo Flouz ${Date.now()}.`;
    await guardadoNoGeral(app, fato);
    await app.open("/");
    await screen.getByRole("button", "Memória").tap();
    const lista = screen.getByRole("complementary", "Memória de #geral");
    const ativos = lista.getByRole("list", "Itens da Memória");
    const item = ativos.getByRole("listitem").filter({ hasText: fato });
    await item.waitFor();

    await item.getByRole("button", "Promover ao Workspace").tap();

    // Na lista do #geral: a versão do Workspace, marcada, e a da Conversa em Arquivados.
    await expect(item).toContainText("no Workspace");
    await expect(item.getByRole("button", "Promover ao Workspace")).toHaveCount(0);
    const arquivados = lista.getByRole("region", "Arquivados");
    await expect(arquivados.getByRole("listitem").filter({ hasText: fato })).toContainText("promovido ao Workspace");

    await screen.getByRole("button", "Memória do Workspace").tap();
    const doWorkspace = screen.getByRole("list", "Itens da Memória do Workspace");
    await expect(doWorkspace.getByRole("listitem").filter({ hasText: fato })).toContainText(`de Pessoa Dev: “@Memo`);
  });
});
