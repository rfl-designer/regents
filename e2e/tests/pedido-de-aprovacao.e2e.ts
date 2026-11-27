import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { addMember, as, type DevPerson, jsonBody, newPerson } from "../support/people";

/** O prazo do Pedido no e2e (`REGENTS_APPROVAL_TTL_H` em `e2e.config.ts`): 45 s. */
const PRAZO_MS = 45_000;

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

/** Grava a Chave e cria um Agente de nome único com "postar mensagem", no #geral. */
async function arautoNoGeral(app: { baseUrl: string }) {
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
  return { agente, geralId: geral!.id };
}

/** Uma pessoa nova no Workspace, no #geral. */
async function noGeral(app: { baseUrl: string }, geralId: string, nome: string) {
  const pessoa = newPerson(`${nome}${Date.now() % 1_000_000}`);
  await addMember(app.baseUrl, pessoa);
  await as(app.baseUrl, pessoa)(`/api/channels/${geralId}/join`, { method: "POST" });
  return pessoa;
}

/** Abre o #geral na tela como essa pessoa. */
async function abrirComo(
  app: { open(path: string): Promise<void> },
  screen: Parameters<Parameters<typeof test>[2]>[0]["screen"],
  pessoa: DevPerson,
) {
  await app.open(`/dev/como/${pessoa.id}?nome=${pessoa.name}`);
  await screen.getByRole("button", /^# geral/).tap();
  const mensagens = screen.getByRole("list", "Mensagens de #geral");
  await expect(mensagens).toHaveAttribute("aria-busy", "false");
  return mensagens;
}

describe("Pedido de aprovação, visto pelos outros", () => {
  test("outro participante vê o cartão sem os botões e acompanha o estado mudar", { timeout: 120_000 }, async ({
    app,
    screen,
  }) => {
    const { agente, geralId } = await arautoNoGeral(app);
    const rosa = await noGeral(app, geralId, "Rosa");
    const lia = await noGeral(app, geralId, "Lia");
    const mensagens = await abrirComo(app, screen, lia);

    // A Rosa pede; a Lia só olha.
    const pedido = `@${agente} [postar] avisa que a reunião mudou ${Date.now()}`;
    const origem = await as(app.baseUrl, rosa)(
      `/api/conversations/${geralId}/messages`,
      jsonBody("POST", { body: pedido }),
    );
    const grupo = mensagens.getByRole("listitem").filter({ hasText: pedido });
    const cartao = grupo.getByRole("group", `Pedido de aprovação de ${agente}`);
    await expect(cartao).toContainText("Postar em #geral: “Aviso: a reunião mudou.”", { timeout: 30_000 });
    await expect(cartao).toContainText(`esperando a aprovação de ${rosa.name}`);
    await expect(cartao.getByRole("button", "Aprovar")).toHaveCount(0);
    await expect(cartao.getByRole("button", "Recusar")).toHaveCount(0);

    const [aprovacao] = (await as(app.baseUrl, rosa)(`/api/conversations/${geralId}/approvals`)).filter(
      (a: { originMessageId: string }) => a.originMessageId === origem.id,
    );
    await as(app.baseUrl, rosa)(`/api/conversations/${geralId}/approvals/${aprovacao.id}/approve`, { method: "POST" });
    await expect(cartao).toContainText(`aprovado por ${rosa.name}: mensagem postada em #geral`, { timeout: 30_000 });
    await expect(grupo).toContainText("Oi! Tudo certo por aqui", { timeout: 30_000 });
  });

  test("um Pedido expirado aparece como expirado para todos", { timeout: 180_000 }, async ({ app, screen }) => {
    const { agente, geralId } = await arautoNoGeral(app);
    const rosa = await noGeral(app, geralId, "Rosa");
    const lia = await noGeral(app, geralId, "Lia");
    let mensagens = await abrirComo(app, screen, lia);

    const pedido = `@${agente} [postar] avisa que a reunião mudou ${Date.now()}`;
    await as(app.baseUrl, rosa)(`/api/conversations/${geralId}/messages`, jsonBody("POST", { body: pedido }));
    let grupo = mensagens.getByRole("listitem").filter({ hasText: pedido });
    let cartao = grupo.getByRole("group", `Pedido de aprovação de ${agente}`);
    await expect(cartao).toContainText(`esperando a aprovação de ${rosa.name}`, { timeout: 30_000 });

    // Ninguém decide: passado o prazo, a Lia vê o Pedido expirar, e a resposta termina ali.
    await expect(cartao).toContainText("a aprovação expirou", { timeout: PRAZO_MS + 30_000 });
    await expect(grupo).toContainText("cancelada: a aprovação expirou");

    // A autora também o vê expirado, sem os botões.
    mensagens = await abrirComo(app, screen, rosa);
    grupo = mensagens.getByRole("listitem").filter({ hasText: pedido });
    cartao = grupo.getByRole("group", `Pedido de aprovação de ${agente}`);
    await expect(cartao).toContainText("a aprovação expirou");
    await expect(cartao.getByRole("button", "Aprovar")).toHaveCount(0);
    await expect(grupo).not.toContainText("Oi! Tudo certo por aqui");
  });
});
