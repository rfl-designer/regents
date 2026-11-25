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
  const name = `Memo${Date.now() % 1_000_000}`;
  const agent = await chamar<{ id: string }>(app, "POST", "/api/agents", {
    name,
    description: "Lembra.",
    instructions: "Responda curto.",
    model: "claude-haiku-5-5",
  });
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/channels/${geral!.id}/agents`, { agentId: agent.id });
  return name;
}

/** Guarda `fato` na Memória do #geral por uma troca com `agente`, pela API, e espera o item chegar. */
async function guardado(app: { baseUrl: string }, agente: string, fato: string) {
  const [geral] = await chamar<{ id: string }[]>(app, "GET", "/api/channels");
  await chamar(app, "POST", `/api/conversations/${geral!.id}/messages`, {
    body: `@${agente} anota [lembrar: ${fato}]`,
  });
  const prazo = Date.now() + 30_000;
  while (Date.now() < prazo) {
    const itens = await chamar<{ text: string }[]>(app, "GET", `/api/conversations/${geral!.id}/memory`);
    if (itens.some((i) => i.text === fato)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`o item "${fato}" não foi guardado`);
}

describe("Memória da Conversa", () => {
  test('depois da resposta, o Andamento mostra "guardou na Memória" e o item aparece na lista Memória da Conversa', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    const fato = `O preço sobe em janeiro ${Date.now()}.`;
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} avisa os clientes [lembrar: ${fato}]`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    await expect(origem.getByRole("status").filter({ hasText: "guardou na Memória" })).toHaveText(
      `guardou na Memória: ${fato}`,
      { timeout: 30_000 },
    );
    await screen.getByRole("button", "Memória").tap();
    const lista = screen.getByRole("complementary", "Memória de #geral");
    await expect(lista.getByRole("listitem").filter({ hasText: fato })).toContainText(`de Pessoa Dev: “${pergunta}”`);
  });

  test("Desfazer tira o item da lista Memória e o mostra em Arquivados", { timeout: 120_000 }, async ({
    app,
    screen,
  }) => {
    const agente = await agenteNoGeral(app);
    const fato = `O almoço do time é às 12h ${Date.now()}.`;
    await guardado(app, agente, fato);
    await app.open("/");
    await screen.getByRole("button", "Memória").tap();
    const lista = screen.getByRole("complementary", "Memória de #geral");
    const item = lista.getByRole("list", "Itens da Memória").getByRole("listitem").filter({ hasText: fato });
    await item.waitFor();

    await item.getByRole("button", "Desfazer").tap();

    const arquivados = lista.getByRole("region", "Arquivados");
    await expect(arquivados.getByRole("listitem").filter({ hasText: fato })).toContainText("desfeito");
    await expect(
      lista.getByRole("list", "Itens da Memória").getByRole("listitem").filter({ hasText: fato }),
    ).toHaveCount(0);
  });

  test("Corrigir põe a versão nova na lista Memória, e a anterior fica em Arquivados apontando para ela", {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    const marca = Date.now();
    const fato = `A reunião é na segunda ${marca}.`;
    const corrigido = `A reunião é na terça ${marca}.`;
    await guardado(app, agente, fato);
    await app.open("/");
    await screen.getByRole("button", "Memória").tap();
    const lista = screen.getByRole("complementary", "Memória de #geral");
    const ativos = lista.getByRole("list", "Itens da Memória");
    const item = ativos.getByRole("listitem").filter({ hasText: fato });
    await item.waitFor();

    await item.getByRole("button", "Corrigir").tap();
    await item.getByRole("textbox", "Versão corrigida").fill(corrigido);
    await item.getByRole("button", "Salvar").tap();

    await expect(ativos.getByRole("listitem").filter({ hasText: corrigido })).toHaveCount(1);
    const arquivados = lista.getByRole("region", "Arquivados");
    await expect(arquivados.getByRole("listitem").filter({ hasText: fato })).toContainText(
      `substituído por: ${corrigido}`,
    );
  });

  test('quando uma pessoa muda um fato guardado, o Andamento mostra "atualizou na Memória"', {
    timeout: 120_000,
  }, async ({ app, screen }) => {
    const agente = await agenteNoGeral(app);
    const marca = Date.now();
    const fato = `O reembolso sai pelo Flouz ${marca}.`;
    const novo = `O reembolso sai pelo Sankhya ${marca}.`;
    await guardado(app, agente, fato);
    await app.open("/");
    const mensagens = screen.getByRole("list", "Mensagens de #geral");
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const pergunta = `@${agente} agora sai pelo Sankhya [substituir: ${fato} => ${novo}]`;

    await screen.getByRole("textbox", "Mensagem para #geral").fill(pergunta);
    await screen.getByRole("button", "Enviar").tap();

    const origem = mensagens.getByRole("listitem").filter({ hasText: pergunta });
    await expect(origem.getByRole("status").filter({ hasText: "na Memória" })).toHaveText(
      `atualizou na Memória: ${novo}`,
      { timeout: 30_000 },
    );
  });
});
