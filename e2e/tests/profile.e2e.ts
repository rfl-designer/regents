import { describe, test } from "@e2e-dev/web";
import type { ChannelDto, MeDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, newPerson } from "../support/people";

describe("perfil e Menção", () => {
  test('o nome editado no perfil passa a aparecer em "Você está como"', async ({ app, screen }) => {
    const zelia = newPerson("Zélia");
    await addMember(app.baseUrl, zelia);
    await app.open(`/dev/como/${zelia.id}?nome=${zelia.name}`);
    await screen.getByText("Você está como Zélia").waitFor();
    await screen.getByRole("button", "Você está como Zélia", { exact: false }).tap();
    await screen.getByRole("form", "Meu perfil").waitFor();

    await screen.getByRole("textbox", "Nome").fill("Zélia Andrade");
    await screen.getByRole("button", "Salvar").tap();
    await screen.getByText("Salvo.").waitFor();

    await expect(screen.getByText("Você está como Zélia Andrade")).toBeVisible();
  });

  test("a mensagem que menciona a pessoa aparece destacada para ela", async ({ app, screen }) => {
    const otavio = newPerson("Otávio");
    const bruno = newPerson("Bruno");
    const doOtavio: MeDto = await addMember(app.baseUrl, otavio);
    await addMember(app.baseUrl, bruno);
    await app.open(`/dev/como/${otavio.id}?nome=${otavio.name}`);
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    const channels: ChannelDto[] = await as(app.baseUrl, bruno)("/api/channels");
    const geral = channels.find((c) => c.name === "geral")!;
    const body = `@${doOtavio.handle} pode revisar? ${Date.now()}`;

    await as(app.baseUrl, bruno)(`/api/channels/${geral.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const mensagem = screen.getByRole("listitem").filter({ hasText: body });
    await mensagem.waitFor();

    await expect(mensagem.getByText("menciona você")).toBeVisible();
  });
});
