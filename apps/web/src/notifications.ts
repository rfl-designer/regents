import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * Push neste aparelho (Spec, módulo 12): a permissão, a inscrição no push service e a entrega
 * dela ao servidor. O aparelho é um id que o PWA gera uma vez e guarda; a inscrição vai em
 * `PUT /api/push/subscriptions/:aparelho`.
 */

const DEVICE_KEY = "shearim.device";
const ONBOARDING_KEY = "shearim.notifications.onboarding";

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** O id deste aparelho (PWA ou navegador), gerado na primeira vez. */
export function deviceId() {
  const store = storage();
  let id = store?.getItem(DEVICE_KEY) ?? null;
  if (!id) {
    id = crypto.randomUUID();
    store?.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Se este navegador tem o que o push precisa (no iPhone, só o PWA da tela de início). */
export function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

/** A chave VAPID vem em base64url; o `subscribe` quer os bytes. */
function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Inscreve (ou reaproveita a inscrição de) este aparelho e entrega ao servidor. */
async function subscribe() {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
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

/**
 * A cada abertura, com a permissão já dada, confere a inscrição e entrega de novo: o iOS não
 * avisa quando ela muda (não há `pushsubscriptionchange`). Falha aqui vai para o console; a
 * faixa de "este aparelho está sem push" é do #33.
 */
export async function refreshPushSubscription() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    await subscribe();
  } catch (err) {
    console.error("shearim: não consegui renovar a inscrição de push deste aparelho", err);
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

export type OnboardingState =
  | { kind: "hidden" }
  | { kind: "offer" }
  | { kind: "working" }
  | { kind: "on" }
  | { kind: "blocked" }
  | { kind: "failed"; detail: string };

/**
 * O onboarding da primeira abertura (história 100): "Ligar notificações" pede a permissão no
 * próprio toque (o iOS e o Firefox exigem o gesto) e pode ser pulado. Some depois de pulado ou
 * ligado, neste aparelho.
 */
export function useNotificationsOnboarding() {
  const [state, setState] = useState<OnboardingState>(() => {
    if (!pushSupported() || storage()?.getItem(ONBOARDING_KEY)) return { kind: "hidden" };
    // Já negada também oferece: o toque mostra que está bloqueada e onde liberar (falha à vista).
    return Notification.permission === "granted" ? { kind: "hidden" } : { kind: "offer" };
  });

  useEffect(() => {
    void refreshPushSubscription();
  }, []);

  const skip = useCallback(() => {
    storage()?.setItem(ONBOARDING_KEY, "skipped");
    setState({ kind: "hidden" });
  }, []);

  const enable = useCallback(async () => {
    setState({ kind: "working" });
    // Nada de `await` antes daqui: a permissão tem que sair dentro do gesto.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState({ kind: "blocked" });
      return;
    }
    try {
      await subscribe();
      storage()?.setItem(ONBOARDING_KEY, "on");
      setState({ kind: "on" });
    } catch (err) {
      setState({ kind: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return { state, enable, skip };
}
