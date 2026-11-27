import { describe, test } from "@e2e-dev/web";
import type { DeviceDto } from "@regents/contracts";
import { expect } from "e2e";
import { as } from "../support/people";

/**
 * No lugar do push service do navegador (o Chromium do e2e não fala com o FCM): a permissão é
 * concedida no gesto e o `subscribe` devolve uma inscrição de mentira, que o PWA entrega ao
 * servidor como entregaria a de verdade. Roda antes do PWA.
 */
function pushServiceFalso(endpoint: string) {
  let permission: NotificationPermission = "default";
  Object.defineProperty(Notification, "permission", { get: () => permission });
  Notification.requestPermission = async () => {
    permission = "granted";
    return permission;
  };
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "BPfalso", auth: "falso" } }),
    unsubscribe: async () => true,
  };
  let subscribed = false;
  PushManager.prototype.subscribe = async () => {
    subscribed = true;
    return subscription as unknown as PushSubscription;
  };
  PushManager.prototype.getSubscription = async () =>
    (subscribed ? subscription : null) as unknown as PushSubscription | null;
}

describe("notificações", () => {
  test('na primeira abertura aparece "Ligar notificações", que pode ser pulado', async ({ app, screen, browser }) => {
    await app.open("/");
    const onboarding = screen.getByRole("region", "Ligar notificações");
    await onboarding.waitFor();

    await onboarding.getByRole("button", "Pular").tap();
    await expect(onboarding).toBeHidden();
    await browser.reload();
    await screen.getByText("Você está como", { exact: false }).waitFor();

    await expect(screen.getByRole("region", "Ligar notificações")).toBeHidden();
  });

  test('"Ligar notificações" pede a permissão no toque e inscreve este aparelho', async ({ app, screen, browser }) => {
    const endpoint = `https://push.invalid/e2e/${Date.now()}`;
    await browser.addInitScript(pushServiceFalso, endpoint);
    await app.open("/");
    const onboarding = screen.getByRole("region", "Ligar notificações");
    await onboarding.waitFor();

    await onboarding.getByRole("button", "Ligar notificações").tap();
    await screen.getByText("Notificações ligadas neste aparelho.").waitFor();

    const aparelhos: DeviceDto[] = await as(app.baseUrl)("/api/devices");
    expect(aparelhos.some((d) => d.pushing)).toBe(true);
    await expect(screen.getByRole("button", "Ligar notificações")).toBeHidden();
  });

  test("com a permissão negada, o onboarding diz que as notificações estão bloqueadas", async ({ app, screen }) => {
    await app.open("/");
    const onboarding = screen.getByRole("region", "Ligar notificações");
    await onboarding.waitFor();

    // O Chromium do e2e nega toda permissão que o teste não concedeu.
    await onboarding.getByRole("button", "Ligar notificações").tap();

    await expect(onboarding.getByText("As notificações estão bloqueadas", { exact: false })).toBeVisible();
  });
});
