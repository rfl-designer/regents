import type { DeviceDto } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useServerEvents } from "./live";

/**
 * Push neste aparelho (Spec, módulo 12): a permissão, a inscrição no push service e a entrega
 * dela ao servidor. O aparelho é um id que o PWA gera uma vez e guarda; a inscrição vai em
 * `PUT /api/push/subscriptions/:aparelho`. Os aparelhos do Membro (`GET /api/devices`, mais
 * `devices.updated`) são a lista de Notificações e a base das faixas de push parado (#33).
 */

const DEVICE_KEY = "shearim.device";
/** O que a pessoa decidiu neste aparelho: ligou, pulou o onboarding ou removeu o aparelho. */
const CHOICE_KEY = "shearim.notifications.onboarding";
const INSTALL_KEY = "shearim.install.skipped";

type Choice = "on" | "skipped" | "removed";

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

function savedChoice(): Choice | null {
  const v = storage()?.getItem(CHOICE_KEY);
  return v === "on" || v === "skipped" || v === "removed" ? v : null;
}

function saveChoice(choice: Choice) {
  try {
    storage()?.setItem(CHOICE_KEY, choice);
  } catch {
    // Sem armazenamento, a escolha vale só até recarregar.
  }
}

/** O id deste aparelho (PWA ou navegador), gerado na primeira vez. */
export function deviceId() {
  const store = storage();
  let id = store?.getItem(DEVICE_KEY) ?? null;
  if (!id) {
    id = crypto.randomUUID();
    try {
      store?.setItem(DEVICE_KEY, id);
    } catch {
      // Sem armazenamento, o aparelho ganha um id novo a cada abertura.
    }
  }
  return id;
}

/** Se este navegador tem o que o push precisa (no iPhone, só o PWA da tela de início). */
export function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

/** iPhone ou iPad numa aba do navegador, fora da tela de início: ali não há push (história 99). */
export function iosOutsideHomeScreen() {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

/** A chave VAPID vem em base64url; o `subscribe` quer os bytes. */
function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Inscreve (ou reaproveita a inscrição de) este aparelho e entrega ao servidor. Com `fresh`, a
 * inscrição que o navegador ainda guarda é dada como morta (o push service disse 404/410, ou o
 * servidor não a tem mais): sai uma nova, com outro endpoint.
 */
async function subscribe(opts: { fresh?: boolean } = {}) {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && opts.fresh) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  if (!subscription) {
    const { publicKey } = await api.pushKey();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
  }
  const json = subscription.toJSON();
  await api.putPushSubscription(deviceId(), {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  });
}

/** Uma renovação de cada vez: a conferência da abertura e um "Ligar" não podem se cruzar. */
let renewals: Promise<unknown> = Promise.resolve();

/**
 * Inscreve este aparelho e entrega ao servidor, decidindo pela lista do servidor no momento:
 * se ele diz que este aparelho parou, a inscrição guardada é trocada por uma nova.
 */
function renewSubscription(): Promise<DeviceDto[]> {
  const work = renewals.then(async () => {
    const before = await api.devices();
    const mine = before.find((d) => d.id === deviceId());
    await subscribe({ fresh: mine !== undefined && !mine.pushing });
    return api.devices();
  });
  renewals = work.catch(() => {});
  return work;
}

async function unsubscribeHere() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Sem service worker não há inscrição para desfazer.
  }
}

/** Fecha, neste aparelho, as notificações de uma conversa (a `tag` delas é o id da conversa). */
export async function closeNotificationsOf(conversationId: string) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    for (const n of (await registration?.getNotifications({ tag: conversationId })) ?? []) n.close();
  } catch {
    // Sem service worker (ou sem notificações) não há o que fechar.
  }
}

/** O resultado de "Ligar": ligadas, bloqueadas pelo navegador, ou o erro. */
export type EnableOutcome = { kind: "on" } | { kind: "blocked" } | { kind: "failed"; detail: string };

/** A faixa deste aparelho: sem push (com "Ligar") ou com a permissão negada (como reativar). */
export type ThisDeviceBanner = "off" | "blocked" | null;

const permissionNow = (): NotificationPermission | "unsupported" =>
  pushSupported() ? Notification.permission : "unsupported";

/**
 * O push deste aparelho e os aparelhos do Membro, para o onboarding, as faixas e a tela de
 * Notificações. A cada abertura confere a permissão e a inscrição e entrega de novo: o iOS não
 * avisa quando ela muda (não há `pushsubscriptionchange`), e uma inscrição que o servidor viu
 * morrer é trocada por outra.
 */
export function usePush(enabled: boolean) {
  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [permission, setPermission] = useState(permissionNow);
  const [choice, setChoice] = useState(savedChoice);
  /** A conferência da abertura terminou: antes disso, a lista pode estar para mudar. */
  const [checked, setChecked] = useState(false);
  const [working, setWorking] = useState(false);

  const reload = useCallback(async () => {
    try {
      setDevices(await api.devices());
    } catch (err) {
      console.error("shearim: não consegui carregar os aparelhos", err);
    }
  }, []);

  useServerEvents((event) => {
    if (event.type === "ready") void reload();
    if (event.type === "devices.updated") setDevices(event.devices);
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // A permissão de quando o app abriu: o que um "Ligar" der depois é com ele.
    const renew = pushSupported() && Notification.permission === "granted" && savedChoice() !== "removed";
    void (async () => {
      const list = await api.devices().catch(() => null);
      if (cancelled) return;
      if (list) setDevices(list);
      if (renew) {
        try {
          const after = await renewSubscription();
          if (!cancelled) setDevices(after);
        } catch (err) {
          // Sem o gesto, o iPhone pode recusar: a faixa deste aparelho oferece "Ligar".
          console.error("shearim: não consegui renovar a inscrição de push deste aparelho", err);
        }
      }
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const thisId = deviceId();
  const mine = devices?.find((d) => d.id === thisId);

  /** "Ligar": pede a permissão no próprio toque (o iOS e o Firefox exigem o gesto) e inscreve. */
  const enable = useCallback(async (): Promise<EnableOutcome> => {
    setWorking(true);
    try {
      // Nada de `await` antes daqui: a permissão tem que sair dentro do gesto.
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") return { kind: "blocked" };
      const after = await renewSubscription();
      saveChoice("on");
      setChoice("on");
      setDevices(after);
      return { kind: "on" };
    } catch (err) {
      return { kind: "failed", detail: err instanceof Error ? err.message : String(err) };
    } finally {
      setWorking(false);
    }
  }, []);

  /** Pular o onboarding neste aparelho. */
  const skip = useCallback(() => {
    saveChoice("skipped");
    setChoice("skipped");
  }, []);

  /** Remove um aparelho da lista. Se for este, desfaz a inscrição aqui e não a renova mais. */
  const remove = useCallback(
    async (id: string) => {
      await api.removeDevice(id);
      if (id === thisId) {
        saveChoice("removed");
        setChoice("removed");
        await unsubscribeHere();
      }
      await reload();
    },
    [thisId, reload],
  );

  const supported = permission !== "unsupported";
  /** Já teve o push ligado aqui: a pessoa ligou, ou o servidor conhece o aparelho. */
  const wasOn = choice === "on" || mine !== undefined;
  let thisDevice: ThisDeviceBanner = null;
  if (supported && checked && devices && wasOn && choice !== "removed" && !working) {
    if (permission === "denied") thisDevice = "blocked";
    else if (permission !== "granted" || !mine?.pushing) thisDevice = "off";
  }

  return {
    devices,
    thisDeviceId: thisId,
    supported,
    /** O onboarding da primeira abertura (história 100): nem ligado, nem pulado, nem conhecido. */
    offerOnboarding: supported && choice === null && permission !== "granted" && !mine,
    thisDevice,
    /** Outros aparelhos que pararam de receber (404/410): "O push parou no iPhone em 20/11". */
    othersStopped: (devices ?? []).filter((d) => d.id !== thisId && !d.pushing && d.pushStoppedAt !== null),
    working,
    enable,
    skip,
    remove,
  };
}

export type PushState = ReturnType<typeof usePush>;

/** O passo do iPhone para a tela de início (história 99): aparece até ser pulado. */
export function useInstallStep() {
  const [show, setShow] = useState(() => iosOutsideHomeScreen() && !storage()?.getItem(INSTALL_KEY));
  const skip = useCallback(() => {
    try {
      storage()?.setItem(INSTALL_KEY, "1");
    } catch {
      // Sem armazenamento, o passo volta na próxima abertura.
    }
    setShow(false);
  }, []);
  return { show, skip };
}

/** "20/11", no fuso do aparelho. */
export function dayMonth(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date(iso));
}

/** "20/11 às 14:05", no fuso do aparelho. */
export function dayMonthTime(iso: string) {
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return `${dayMonth(iso)} às ${time}`;
}

/** Como a tela chama um aparelho. */
export const deviceName = (d: DeviceDto) => d.label ?? "Aparelho sem nome";
