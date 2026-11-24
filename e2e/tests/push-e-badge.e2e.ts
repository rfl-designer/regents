import { describe, test } from "@e2e-dev/web";
import type { DmDto, UnreadDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, ensureAdmin, jsonBody, newPerson } from "../support/people";

/**
 * No lugar do badge do sistema (o Chromium do e2e não mostra ícone): o PWA chama
 * `navigator.setAppBadge`/`clearAppBadge`, e o teste lê o último valor em `<html data-badge>`.
 * Roda antes do PWA.
 */
function badgeDoSistema() {
  const show = (n: number) => document.documentElement.setAttribute("data-badge", String(n));
  Object.defineProperty(navigator, "setAppBadge", { value: async (n = 0) => show(n), configurable: true });
  Object.defineProperty(navigator, "clearAppBadge", { value: async () => show(0), configurable: true });
}

describe("badge do ícone", () => {
  test("ao abrir e a cada mudança, o badge mostra o total de não-lidas das minhas conversas", async ({
    app,
    screen,
    browser,
  }) => {
    await ensureAdmin(app.baseUrl);
    // Quem olha é uma pessoa nova, que não participa de nenhuma conversa: as não-lidas dela só
    // mudam por este teste (os outros testes da execução escrevem em paralelo nas conversas da
    // Pessoa Dev, e o badge dela anda sozinho). Nomes únicos: o banco é da execução inteira.
    const lia = newPerson(`Lia${Date.now() % 1_000_000}`);
    const rosa = newPerson(`Rosa${Date.now() % 1_000_000}`);
    const eu = await addMember(app.baseUrl, lia);
    await addMember(app.baseUrl, rosa);
    await browser.addInitScript(badgeDoSistema);
    const html = browser.locator("html");

    await app.open(`/dev/como/${lia.id}?nome=${lia.name}`);
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    const { total }: UnreadDto = await as(app.baseUrl, lia)("/api/unread");
    if (total !== 0) throw new Error(`a Lia deveria começar sem não-lidas, tem ${total}`);
    await expect(html).toHaveAttribute("data-badge", "0");

    // Duas mensagens numa DM que não está aberta: o badge sobe junto.
    const dm: DmDto = await as(app.baseUrl, rosa)("/api/dms", jsonBody("POST", { memberIds: [eu.id] }));
    for (const body of ["oi", "tem um minuto?"]) {
      await as(app.baseUrl, rosa)(`/api/conversations/${dm.id}/messages`, jsonBody("POST", { body }));
    }
    await expect(html).toHaveAttribute("data-badge", "2");

    // Abrir a DM lê as duas: o badge volta.
    await screen.getByRole("list", "DMs").getByRole("button", rosa.name).tap();
    await expect(screen.getByText("tem um minuto?")).toBeVisible();
    await expect(html).toHaveAttribute("data-badge", "0");
  });
});

type Box = { x: number; y: number; width: number; height: number } | null;
/** Se o item está inteiro dentro da área visível da lista. */
const dentro = (item: Box, lista: Box) =>
  !!item && !!lista && item.y >= lista.y - 1 && item.y + item.height <= lista.y + lista.height + 1;

describe("tocar no push", () => {
  test("o push que leva a uma mensagem (o da falha) abre a conversa nela, no meio da tela, piscando", async ({
    app,
    screen,
    browser,
  }) => {
    await ensureAdmin(app.baseUrl);
    const eu = as(app.baseUrl);
    const bruno = newPerson("Bruno");
    await addMember(app.baseUrl, bruno);
    const n = `${Date.now() % 1_000_000}${Math.floor(Math.random() * 100)}`;
    const canal = await eu("/api/channels", jsonBody("POST", { name: `push-${n}`, kind: "public" }));
    await as(app.baseUrl, bruno)(`/api/channels/${canal.id}/join`, { method: "POST" });
    const alvo = await eu(`/api/conversations/${canal.id}/messages`, jsonBody("POST", { body: `a mensagem ${n}` }));
    const ids: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const m = await as(app.baseUrl, bruno)(
        `/api/conversations/${canal.id}/messages`,
        jsonBody("POST", { body: `conversa paralela ${i}` }),
      );
      ids.push(m.id);
    }
    // Tudo lido: sem o salto, a conversa abriria no fim, com a mensagem lá em cima.
    await eu(`/api/conversations/${canal.id}/reads`, jsonBody("POST", { messageIds: ids }));

    await app.open(`/c/${canal.id}?m=${alvo.id}`);

    const mensagens = screen.getByRole("list", `Mensagens de #${canal.name}`);
    await expect(mensagens).toHaveAttribute("aria-busy", "false");
    const linha = browser.locator(`[data-message-id="${alvo.id}"]`);
    await expect(linha).toHaveAttribute("data-flash", "true");
    await expect.poll(async () => dentro(await linha.boundingBox(), await mensagens.boundingBox())).toBe(true);
  });
});
