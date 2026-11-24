import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { FAKE_LOGIN_CODE } from "../../apps/server/test/fake-claude";
import { addMember, newPerson } from "../support/people";

/**
 * "Minha Conta" (Spec, módulo 8; histórias 36, 38 e 40). O `fake-claude` do `serve.ts` entra numa
 * conta cujo login vence em 4 dias: a validade (3 dias antes) cai amanhã, então a Conta já liga em
 * destaque e com o selo no menu pessoal.
 */
describe("Minha Conta", () => {
  test("liga a Conta pela tela, mostra a validade em destaque com o selo, e desistir de ligar de novo não muda nada", async ({
    app,
    screen,
  }) => {
    const rita = newPerson("Rita");
    await addMember(app.baseUrl, rita);
    await app.open(`/dev/como/${rita.id}?nome=${rita.name}`);
    await screen.getByRole("button", "Minha Conta").tap();
    const minhaConta = screen.getByRole("main").filter({ hasText: "Minha Conta" });
    await minhaConta.getByRole("button", "Ligar minha Conta do Claude").tap();

    await screen.getByRole("textbox", "Cole aqui o código", { exact: false }).fill(FAKE_LOGIN_CODE);
    await screen.getByRole("button", "Ligar", { exact: true }).tap();

    const estado = screen.getByRole("region", "Estado da Conta");
    await expect(estado.getByText("Ligada", { exact: true })).toBeVisible();
    await expect(estado.getByText(/^vale até \d{2}\/\d{2}$/)).toBeVisible();
    await expect(estado).toHaveAttribute("data-expiring", "true");
    await expect(screen.getByText("Ligue de novo para não interromper", { exact: false })).toBeVisible();
    await expect(screen.getByRole("img", "A sua Conta do Claude vence em breve")).toBeVisible();

    // "Ligar de novo" e desistir no meio: a Conta segue Ligada, com a mesma validade.
    await screen.getByRole("button", "Ligar de novo").tap();
    await screen.getByRole("button", "Cancelar").tap();
    await expect(estado.getByText("Ligada", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "Ligar de novo")).toBeVisible();
  });
});
