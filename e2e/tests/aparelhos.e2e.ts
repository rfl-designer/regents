import { test as base, describe } from "@e2e-dev/web";
import type { DmDto, MeDto, PushSubscriptionInput } from "@regents/contracts";
import { expect } from "e2e";
import { addMember, as, type DevPerson, jsonBody, newPerson } from "../support/people";
import { type FakePushService, startFakePushService } from "../support/push-service";

/**
 * Aparelhos e push parado (#33): o passo do iPhone para a tela de início, as faixas de push
 * parado e a lista de aparelhos em Notificações. O "parou" sai de um `410` de verdade, do push
 * service falso (`support/push-service.ts`), quando chega uma DM.
 */

/** "DD/MM" de hoje, como a tela mostra (o fuso do e2e é o de São Paulo). */
const hoje = () =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }).format(
    new Date(),
  );

/** A aba do Safari no iPhone, fora da tela de início: sem push (só o app da tela de início tem). */
function safariDoIphone() {
  Object.defineProperty(Navigator.prototype, "userAgent", {
    get: () =>
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  });
  Object.defineProperty(Navigator.prototype, "platform", { get: () => "iPhone" });
  delete (window as { PushManager?: unknown }).PushManager;
  delete (window as { Notification?: unknown }).Notification;
}

/**
 * O push service do navegador, falso: a permissão sai no gesto e cada `subscribe` devolve a
 * próxima inscrição da lista (a de verdade troca de endpoint depois de um `unsubscribe`).
 * Lembra entre recargas o que já entregou, como o navegador lembraria.
 */
function pushDoNavegador(arg: unknown) {
  const subscriptions = arg as PushSubscriptionInput[];
  const KEY = "e2e.push";
  // A página intermediária do redirecionamento (`/dev/como`) não tem armazenamento.
  try {
    localStorage.length;
  } catch {
    return;
  }
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{"permission":"default","used":0,"current":null}') as {
    permission: NotificationPermission;
    used: number;
    current: number | null;
  };
  const save = () => localStorage.setItem(KEY, JSON.stringify(saved));
  Object.defineProperty(Notification, "permission", { get: () => saved.permission });
  Notification.requestPermission = async () => {
    saved.permission = "granted";
    save();
    return saved.permission;
  };
  const wrap = (i: number) => {
    const s = subscriptions[i]!;
    return {
      endpoint: s.endpoint,
      toJSON: () => s,
      unsubscribe: async () => {
        saved.current = null;
        save();
        return true;
      },
    } as unknown as PushSubscription;
  };
  PushManager.prototype.subscribe = async () => {
    saved.current = saved.used++;
    save();
    return wrap(saved.current);
  };
  PushManager.prototype.getSubscription = async () => (saved.current === null ? null : wrap(saved.current));
}

/** Este navegador já teve o push ligado como o aparelho `deviceId`, e depois a permissão foi negada. */
function permissaoNegadaDepois(deviceId: string) {
  try {
    localStorage.length;
  } catch {
    return;
  }
  localStorage.setItem("shearim.device", deviceId);
  localStorage.setItem("shearim.notifications.onboarding", "on");
  Object.defineProperty(Notification, "permission", { get: () => "denied" });
}

/** Uma pessoa nova, Membro, com o navegador como ela. */
async function entrarComo(app: { baseUrl: string; open(path: string): Promise<unknown> }, name: string) {
  const person = newPerson(name);
  const me: MeDto = await addMember(app.baseUrl, person);
  await app.open(`/dev/como/${person.id}?nome=${name}`);
  return { person, me };
}

/** Bruno escreve numa DM com a pessoa: o push dela sai para todos os aparelhos. */
async function dmPara(baseUrl: string, me: MeDto) {
  const bruno: DevPerson = newPerson("Bruno");
  await addMember(baseUrl, bruno);
  const dm: DmDto = await as(baseUrl, bruno)("/api/dms", jsonBody("POST", { memberIds: [me.id] }));
  await as(baseUrl, bruno)(`/api/conversations/${dm.id}/messages`, jsonBody("POST", { body: `oi ${Date.now()}` }));
}

/** Cada teste com o seu push service falso (os testes rodam ao mesmo tempo). */
const test = base.extend<{ push: FakePushService }>({
  // biome-ignore lint/correctness/noEmptyPattern: o runner lê as fixtures pela desestruturação
  push: async ({}, use) => {
    const service = await startFakePushService();
    await use(service);
    await service.stop();
  },
});

describe("aparelhos e push parado", () => {
  test('no Safari do iPhone, aparece o passo "Adicionar à Tela de Início", que pode ser pulado', async ({
    app,
    screen,
    browser,
  }) => {
    await browser.addInitScript(safariDoIphone);
    await app.open("/");
    const passo = screen.getByRole("region", "Adicionar à Tela de Início");
    await passo.waitFor();
    await expect(passo).toContainText("Compartilhar");
    await expect(screen.getByRole("region", "Ligar notificações")).toBeHidden();

    await passo.getByRole("button", "Pular").tap();
    await browser.reload();
    await screen.getByText("Você está como", { exact: false }).waitFor();

    await expect(screen.getByRole("region", "Adicionar à Tela de Início")).toBeHidden();
  });

  test('quando outro aparelho para de receber, aparece "O push parou no … em DD/MM"', async ({ app, screen, push }) => {
    const { person, me } = await entrarComo(app, "Ana");
    await as(app.baseUrl, person)(`/api/push/subscriptions/${crypto.randomUUID()}`, jsonBody("PUT", push.dead()));
    await screen.getByText("Você está como Ana").waitFor();

    await dmPara(app.baseUrl, me);

    const faixa = screen.getByRole("region", "Push parado em outro aparelho");
    await expect(faixa).toContainText(`O push parou no navegador de dev em ${hoje()}`, { timeout: 15_000 });
  });

  test("remover em Notificações o aparelho que parou tira ele da lista e some com a faixa", async ({
    app,
    screen,
    push,
  }) => {
    const { person, me } = await entrarComo(app, "Beatriz");
    await as(app.baseUrl, person)(`/api/push/subscriptions/${crypto.randomUUID()}`, jsonBody("PUT", push.dead()));
    await dmPara(app.baseUrl, me);
    const faixa = screen.getByRole("region", "Push parado em outro aparelho");
    await faixa.getByRole("button", "Ver aparelhos").tap({ timeout: 15_000 });
    const aparelhos = screen.getByRole("list", "Meus aparelhos");
    const parado = aparelhos.getByRole("listitem").filter({ hasText: `Parou em ${hoje()}` });
    await parado.waitFor();

    await parado.getByRole("button", "Remover").tap();
    await screen.getByText("Nenhum aparelho recebe push ainda.").waitFor();

    await expect(aparelhos.getByRole("listitem")).toHaveCount(0);
    await expect(screen.getByRole("region", "Push parado em outro aparelho")).toBeHidden();
  });

  test('este aparelho sem push mostra "Notificações desligadas neste aparelho", e "Ligar" religa', async ({
    app,
    screen,
    browser,
    push,
  }) => {
    await browser.addInitScript(pushDoNavegador, [push.dead(), push.alive()] as never);
    const { me } = await entrarComo(app, "Carla");
    await screen.getByRole("region", "Ligar notificações").getByRole("button", "Ligar notificações").tap();
    await screen.getByText("Notificações ligadas neste aparelho.").waitFor();
    await dmPara(app.baseUrl, me);
    const faixa = screen.getByRole("region", "Notificações deste aparelho");
    await expect(faixa).toContainText("Notificações desligadas neste aparelho", { timeout: 15_000 });

    await faixa.getByRole("button", "Ligar").tap();
    await faixa.waitFor({ state: "hidden" });

    // A inscrição morta foi trocada por uma nova: o próximo push chega nela.
    await dmPara(app.baseUrl, me);
    await expect.poll(() => push.hits.some((url) => url.includes("/viva/")), { timeout: 15_000 }).toBe(true);
    await expect(screen.getByRole("region", "Notificações deste aparelho")).toBeHidden();
  });

  test("ao abrir de novo, o app troca sozinho a inscrição que morreu e a faixa some", async ({
    app,
    screen,
    browser,
    push,
  }) => {
    await browser.addInitScript(pushDoNavegador, [push.dead(), push.alive()] as never);
    const { me } = await entrarComo(app, "Elisa");
    await screen.getByRole("region", "Ligar notificações").getByRole("button", "Ligar notificações").tap();
    await screen.getByText("Notificações ligadas neste aparelho.").waitFor();
    await dmPara(app.baseUrl, me);
    await screen.getByRole("region", "Notificações deste aparelho").waitFor({ timeout: 15_000 });

    await browser.reload();
    await screen.getByText("Você está como Elisa").waitFor();

    await dmPara(app.baseUrl, me);
    await expect.poll(() => push.hits.some((url) => url.includes("/viva/")), { timeout: 15_000 }).toBe(true);
    await expect(screen.getByRole("region", "Notificações deste aparelho")).toBeHidden();
  });

  test("com a permissão negada neste aparelho, a faixa explica como reativar", async ({
    app,
    screen,
    browser,
    push,
  }) => {
    const { person } = await entrarComo(app, "Dora");
    const aparelho = crypto.randomUUID();
    await as(app.baseUrl, person)(`/api/push/subscriptions/${aparelho}`, jsonBody("PUT", push.alive()));
    await browser.addInitScript(permissaoNegadaDepois, aparelho);

    await app.open("/");

    const faixa = screen.getByRole("region", "Notificações deste aparelho");
    await expect(faixa).toContainText("As notificações estão bloqueadas neste aparelho.");
    await expect(faixa).toContainText("libere as notificações do Regents");
  });
});
