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

describe("Login dos Conectores", () => {
  test('em Meus Conectores, "Ligar pelo login" abre o login do servidor e volta com a credencial ligada', {
    timeout: 60_000,
  }, async ({ app, screen }) => {
    const { url, token } = crm(app);
    const nome = `Login${Date.now() % 1_000_000}`;
    const conector = await chamar<{ id: string }>(app, "POST", "/api/connectors", {
      name: nome,
      url,
      token,
      credential: "member",
    });
    // Desligada, para ligar de novo pelo login.
    await chamar(app, "DELETE", `/api/me/connectors/${conector.id}/credential`);

    await app.open("/perfil/conectores");
    const item = screen.getByRole("listitem", `Conector ${nome}`);
    await expect(item).toContainText("Desligado");
    await item.getByRole("button", "Ligar pelo login").tap();

    // O servidor de autorização falso aprova na hora e devolve o navegador ao endereço do app.
    await expect(screen.getByText("Login concluído: a sua credencial ficou ligada.")).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByRole("listitem", `Conector ${nome}`)).toContainText("Ligado com a sua credencial.");
  });
});
