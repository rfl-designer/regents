import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { emulateNetwork, network, socketsOpened } from "../support/network";
import { ensureAdmin, newPerson } from "../support/people";

const SEM_INTERNET = "Você está sem internet";
const RECONECTANDO = "Reconectando…";
const SEM_CONEXAO = "Sem conexão com o Shearim";

describe("conexão", () => {
  describe("com a conversa aberta", () => {
    test('mostra "Você está sem internet" quando o aparelho fica offline', async ({ app, browser, screen }) => {
      await emulateNetwork(browser);
      await app.open("/");
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");

      await network(browser, "offline");

      await expect(screen.getByText(SEM_INTERNET)).toBeVisible();
    });

    test('a internet volta e mostra "Reconectando…" enquanto o WebSocket não abre', async ({
      app,
      browser,
      screen,
    }) => {
      await emulateNetwork(browser);
      await app.open("/");
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
      await network(browser, "offline");
      await screen.getByText(SEM_INTERNET).waitFor();

      await network(browser, "socket-down");

      await expect(screen.getByText(RECONECTANDO)).toBeVisible();
    });

    test('"Reconectando…" some quando o WebSocket volta', async ({ app, browser, screen }) => {
      await emulateNetwork(browser);
      await app.open("/");
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
      await network(browser, "socket-down");
      await screen.getByText(RECONECTANDO).waitFor();

      await network(browser, "online");

      await expect(screen.getByText(RECONECTANDO)).toBeHidden();
    });

    test('mostra "Sem conexão com o Shearim", com a dica do Tailscale, quando o servidor não responde', async ({
      app,
      browser,
      screen,
    }) => {
      await emulateNetwork(browser);
      await app.open("/");
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");

      await network(browser, "server-down");

      await expect(screen.getByText(SEM_CONEXAO)).toBeVisible();
      await expect(screen.getByText("Tailscale", { exact: false })).toBeVisible();
    });

    test('"Sem conexão com o Shearim" some sozinha quando o servidor volta', async ({ app, browser, screen }) => {
      await emulateNetwork(browser);
      await app.open("/");
      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
      await network(browser, "server-down");
      await screen.getByText(SEM_CONEXAO).waitFor();

      await network(browser, "online");

      await expect(screen.getByText(SEM_CONEXAO)).toBeHidden();
    });
  });

  describe("ao abrir o Shearim", () => {
    test('com o servidor fora, mostra "Sem conexão com o Shearim"', async ({ app, browser, screen }) => {
      await emulateNetwork(browser, "server-down");

      await app.open("/");

      await expect(screen.getByRole("heading", SEM_CONEXAO)).toBeVisible();
    });

    test("com o servidor fora, entra sozinho na conversa quando ele volta", async ({ app, browser, screen }) => {
      await emulateNetwork(browser, "server-down");
      await app.open("/");
      await screen.getByRole("heading", SEM_CONEXAO).waitFor();

      await network(browser, "online");

      await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    });

    test('sem internet, mostra "Você está sem internet"', async ({ app, browser, screen }) => {
      await emulateNetwork(browser, "offline");

      await app.open("/");

      await expect(screen.getByRole("heading", SEM_INTERNET)).toBeVisible();
    });
  });

  test("no Pedido de entrada, não abre o WebSocket de eventos (só Membro abre)", async ({ app, browser, screen }) => {
    // A Instalação já tem Admin: quem chega agora é só visitante.
    await ensureAdmin(app.baseUrl);
    const visitante = newPerson("Visitante");
    await emulateNetwork(browser);

    await app.open(`/dev/como/${visitante.id}?nome=${visitante.name}`);
    await screen.getByRole("button", "Pedir para entrar").waitFor();
    await new Promise((r) => setTimeout(r, 2_500));

    expect(await socketsOpened(browser)).toBe(0);
    await expect(screen.getByRole("button", "Pedir para entrar")).toBeVisible();
  });
});
