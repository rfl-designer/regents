import { describe, test } from "@e2e-dev/web";
import type { DmDto } from "@shearim/contracts";
import { expect } from "e2e";
import { addMember, as, ensureAdmin, newPerson } from "../support/people";

describe("DMs", () => {
  test("uma DM aberta por outra pessoa aparece na hora em Mensagens diretas, fora dos Canais", async ({
    app,
    screen,
  }) => {
    const eu = await ensureAdmin(app.baseUrl);
    const fulana = newPerson("Fulana");
    await addMember(app.baseUrl, fulana);
    await app.open("/");
    await expect(screen.getByRole("list", "Mensagens de #geral")).toHaveAttribute("aria-busy", "false");
    const texto = `oi, só entre nós ${Date.now()}`;

    const dm: DmDto = await as(app.baseUrl, fulana)("/api/dms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberIds: [eu.id] }),
    });
    await as(app.baseUrl, fulana)(`/api/conversations/${dm.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: texto }),
    });

    await screen.getByRole("list", "DMs").getByRole("button", fulana.name).tap();
    await expect(screen.getByRole("heading", fulana.name)).toBeVisible();
    await expect(screen.getByText(texto)).toBeVisible();
  });
});
