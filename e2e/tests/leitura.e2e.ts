import { describe, test } from "@e2e-dev/web";
import type { AgentDto, ChannelDto, MessageDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, type DevPerson, newPerson } from "../support/people";

/**
 * Quanto esperar a resposta do Agente. A fila de execuções é uma só e serial (#42 traz o
 * paralelismo): no e2e, ela espera as respostas dos outros testes.
 */
const RESPOSTA_MS = 60_000;

/** Quantas mensagens o Bruno manda para a origem sumir lá em cima. */
const ENCHIMENTO = 30;

type Api = ReturnType<typeof as>;
const post = (api: Api, path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Um Canal novo da Pessoa Dev (Admin), com um Agente de nome único e o Bruno dentro.
 * Cada teste usa o seu: o banco é da execução inteira.
 */
async function canalComFaroEBruno(baseUrl: string) {
  const eu = as(baseUrl);
  await eu("/api/workspace-key", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-ant-e2e" }),
  });
  const n = `${Date.now() % 1_000_000}${Math.floor(Math.random() * 100)}`;
  const agente: AgentDto = await post(eu, "/api/agents", {
    name: `Faro${n}`,
    description: "Comercial.",
    model: "claude-haiku-5-5",
  });
  const canal: ChannelDto = await post(eu, "/api/channels", { name: `leitura-${n}`, kind: "public" });
  await post(eu, `/api/channels/${canal.id}/agents`, { agentId: agente.id });
  const bruno: DevPerson = newPerson("Bruno");
  await addMember(baseUrl, bruno);
  await post(as(baseUrl, bruno), `/api/channels/${canal.id}/join`, {});
  return { canal, agente: agente.name, bruno, api: { eu, bruno: as(baseUrl, bruno) } };
}

/** O Bruno enche a conversa, uma mensagem por vez; devolve o texto da última. */
async function encher(api: Api, canalId: string) {
  let ultima = "";
  for (let i = 1; i <= ENCHIMENTO; i++) {
    ultima = `conversa paralela ${i} · ${Date.now()}`;
    await post(api, `/api/conversations/${canalId}/messages`, { body: ultima });
  }
  return ultima;
}

type Box = { x: number; y: number; width: number; height: number } | null;
/** Se o item está inteiro dentro da área visível da lista. */
const dentro = (item: Box, lista: Box) =>
  !!item && !!lista && item.y >= lista.y - 1 && item.y + item.height <= lista.y + lista.height + 1;

describe("leitura", () => {
  test("o aviso flutuante de uma resposta que chegou lá em cima leva até ela, que pisca", async ({ app, screen }) => {
    const { canal, agente, bruno, api } = await canalComFaroEBruno(app.baseUrl);
    await app.open("/");
    await screen.getByRole("button", `# ${canal.name}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal.name}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    await post(api.bruno, `/api/conversations/${canal.id}/messages`, { body: `@${agente} qual o prazo?` });
    await mensagens.getByText(await encher(api.bruno, canal.id)).waitFor();
    const aviso = screen.getByRole("button", `↑ ${agente} respondeu ${bruno.name}`);
    await aviso.waitFor({ timeout: RESPOSTA_MS });

    await aviso.tap();

    const resposta = mensagens.getByRole("article", `Mensagem de ${agente}`);
    await expect(resposta).toHaveAttribute("data-flash", "true");
    await expect.poll(async () => dentro(await resposta.boundingBox(), await mensagens.boundingBox())).toBe(true);
    await expect(aviso).toBeHidden();
  });

  test("a conversa abre na primeira não-lida, a resposta ancorada lá em cima, com a linha Novas", async ({
    app,
    screen,
  }) => {
    const { canal, agente, api } = await canalComFaroEBruno(app.baseUrl);
    const pergunta: MessageDto = await post(api.eu, `/api/conversations/${canal.id}/messages`, {
      body: `@${agente} e a proposta?`,
    });
    await encher(api.bruno, canal.id);
    await expect
      .poll(
        async () =>
          ((await api.eu(`/api/conversations/${canal.id}/messages`)) as MessageDto[]).some(
            (m) => m.originMessageId === pergunta.id,
          ),
        { timeout: RESPOSTA_MS },
      )
      .toBe(true);
    await app.open("/");
    await screen.getByRole("button", `# ${canal.name}`).waitFor();

    await screen.getByRole("button", `# ${canal.name}`).tap();

    const mensagens = screen.getByRole("list", `Mensagens de #${canal.name}`);
    const novas = mensagens.getByRole("separator", "Novas");
    const resposta = mensagens.getByRole("article", `Mensagem de ${agente}`);
    await expect(novas).toBeVisible();
    await expect.poll(async () => dentro(await novas.boundingBox(), await mensagens.boundingBox())).toBe(true);
    await expect.poll(async () => dentro(await resposta.boundingBox(), await mensagens.boundingBox())).toBe(true);
    await expect(screen.getByRole("button", /^↓ \d+ novas abaixo$/)).toBeVisible();
  });

  test("o aviso de novas abaixo leva à primeira delas", async ({ app, screen }) => {
    const { canal, api } = await canalComFaroEBruno(app.baseUrl);
    await post(api.eu, `/api/conversations/${canal.id}/messages`, { body: "começo da conversa" });
    await encher(api.bruno, canal.id);
    await app.open("/");
    await screen.getByRole("button", `# ${canal.name}`).tap();
    const mensagens = screen.getByRole("list", `Mensagens de #${canal.name}`);
    const abaixo = screen.getByRole("button", /^↓ \d+ novas abaixo$/);
    await abaixo.waitFor();
    const antes = await abaixo.textContent();

    await abaixo.tap();

    // As que entraram na tela saíram da conta: o aviso diminui (ou some, se acabaram).
    await expect.poll(async () => ((await abaixo.isVisible()) ? await abaixo.textContent() : "")).not.toBe(antes);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
  });
});
