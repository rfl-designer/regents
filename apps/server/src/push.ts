import type https from "node:https";
import {
  conversationPath,
  type DeviceDto,
  type MessageDto,
  type PushKeyDto,
  type PushSubscriptionInput,
} from "@shearim/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "./clock";
import { type Db, schema } from "./db/client";
import type { EventHub } from "./events";
import type { TailnetUser } from "./join-requests";
import type { Member } from "./members";
import { type Conversation, participantsOf } from "./participation";
import type { Presence } from "./presence";
import { generateVapidKeys, type OutgoingPush, type VapidKeys, webPushSender } from "./push-sender";

type Env = { Variables: { who: TailnetUser; member: Member } };

const { vapidKeys, devices, pushSubscriptions, pushStreaks, channels } = schema;

/** TTL de todo push: 24 h (Spec, módulo 12). O padrão do `web-push` seria 4 semanas. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Tamanho do trecho da mensagem no corpo da notificação. */
export const EXCERPT_MAX = 140;

export interface PushConfig {
  /** O `sub` do VAPID: `mailto:` com domínio real (a Apple recusa `localhost`). */
  contact: string;
  /** Só nos testes: o agente que aceita o certificado do coletor de push. */
  agent?: https.Agent;
}

/**
 * Push (Spec, módulo 12): o par VAPID, as inscrições por aparelho, os pushes de Menção e de DM
 * (#31) e os aparelhos do Membro, com "parou em", remoção e `devices.updated` (#33). Fica para
 * depois, com o seam indicado:
 * - resposta de Agente, falha e Thread seguida (#32): chamam `notify` com outra `urgency`. Na
 *   Thread seguida, quem avisar é `followersOf(db, message.threadRootId)` (`threads.ts`); quem
 *   passa a seguir por esta mensagem já está gravado quando `messageCreated` roda;
 * - os pushes do Admin e da Conta (#28, #34, #35): `notify`, como os da Instalação (#38).
 */
export function createPush(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  presence: Presence;
  config: PushConfig;
  /** O total de não-lidas do Membro: o `app_badge` (o `setAppBadge` da página é do #32). */
  badgeOf: (memberId: string) => Promise<number>;
}) {
  const { db, clock, events, presence } = deps;
  const { badgeOf } = deps;
  const send = webPushSender(deps.config);

  // ---------- o par VAPID ----------

  let keys: Promise<VapidKeys> | undefined;
  /** O par VAPID: gerado na primeira vez (a primeira subida) e daí em diante sempre o mesmo. */
  function vapid() {
    keys ??= (async () => {
      const generated = generateVapidKeys();
      await db
        .insert(vapidKeys)
        .values({ id: 1, ...generated, createdAt: clock.now() })
        .onConflictDoNothing();
      const [row] = await db.select().from(vapidKeys).where(eq(vapidKeys.id, 1));
      return { publicKey: row!.publicKey, privateKey: row!.privateKey };
    })();
    keys.catch(() => {
      keys = undefined;
    });
    return keys;
  }

  // ---------- os aparelhos ----------

  /** Os aparelhos do Membro, na ordem em que foram ligados, com o estado do push de cada um. */
  async function devicesOf(memberId: string): Promise<DeviceDto[]> {
    const rows = await db
      .select({ d: devices, endpoint: pushSubscriptions.endpoint })
      .from(devices)
      .leftJoin(
        pushSubscriptions,
        and(eq(pushSubscriptions.memberId, devices.memberId), eq(pushSubscriptions.deviceId, devices.id)),
      )
      .where(eq(devices.memberId, memberId))
      .orderBy(asc(devices.createdAt), asc(devices.id));
    return rows.map(({ d, endpoint }) => ({
      id: d.id,
      label: d.label,
      pushing: endpoint !== null,
      pushStoppedAt: d.pushStoppedAt?.toISOString() ?? null,
      lastPushAt: d.lastPushAt?.toISOString() ?? null,
    }));
  }

  /** Avisa as conexões do Membro que os aparelhos dele mudaram (as faixas de push parado). */
  async function announceDevices(memberId: string) {
    events.publish({ members: [memberId] }, { type: "devices.updated", devices: await devicesOf(memberId) });
  }

  // ---------- a fila de envio ----------

  // Um envio de cada vez, na ordem em que as mensagens foram gravadas: assim o "3 novas" de uma
  // rajada sai em ordem e a última notificação é a da última mensagem. Quem grava não espera.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(work: () => Promise<void>) {
    chain = chain.then(work).catch((err) => console.error("shearim: o push falhou", err));
  }

  /** Manda um push a todo aparelho com push ligado do Membro. */
  async function deliver(memberId: string, push: OutgoingPush) {
    const subscriptions = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.memberId, memberId));
    if (subscriptions.length === 0) return;
    const key = await vapid();
    for (const s of subscriptions) {
      const result = await send(key, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, push);
      const device = and(eq(devices.memberId, s.memberId), eq(devices.id, s.deviceId));
      if (result.kind === "delivered") {
        await db.update(devices).set({ lastPushAt: clock.now() }).where(device);
      } else if (result.kind === "gone") {
        // A inscrição morreu: some, e o aparelho fica com "parou em DD/MM", à vista nas faixas.
        await db.transaction(async (tx) => {
          await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
          await tx.update(devices).set({ pushStoppedAt: clock.now() }).where(device);
        });
        await announceDevices(s.memberId);
      } else {
        console.error(`shearim: o push service recusou um push (${result.detail})`);
      }
    }
  }

  /**
   * Os pushes de uma mensagem nova: a quem ela menciona e, numa DM, a todo participante. Nunca a
   * quem escreveu, e nunca a quem está com a conversa aberta e visível em algum aparelho.
   * Chame depois de gravar e anunciar.
   */
  function messageCreated(message: MessageDto, conversation: Conversation) {
    // Quem está vendo a conversa no instante em que a mensagem chega (o envio sai depois, na fila).
    const watching = presence.watchersOf(conversation.id);
    enqueue(async () => {
      const authorId = message.author.kind === "member" ? message.author.id : undefined;
      const participants = (await participantsOf(db, [conversation.id])).get(conversation.id) ?? [];
      const people = participants.filter((p) => p.kind === "member");
      const isDm = conversation.kind === "dm" || conversation.kind === "group";
      const recipients = new Set(message.mentions.filter((m) => m.kind === "member").map((m) => m.id));
      if (isDm) for (const p of people) recipients.add(p.id);
      if (authorId) recipients.delete(authorId);
      if (recipients.size === 0) return;

      const [row] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, conversation.id));
      const author = message.author.displayName;
      for (const recipientId of recipients) {
        // Quem já está vendo a conversa, em qualquer aparelho, não precisa ser avisado.
        if (watching.has(recipientId)) continue;
        // Quantas desta conversa ele recebeu desde a última vez que a abriu, esta inclusive.
        const [streak] = await db
          .insert(pushStreaks)
          .values({ memberId: recipientId, conversationId: conversation.id, count: 1 })
          .onConflictDoUpdate({
            target: [pushStreaks.memberId, pushStreaks.conversationId],
            set: { count: sql`${pushStreaks.count} + 1` },
          })
          .returning({ count: pushStreaks.count });
        const n = streak!.count;
        const othersThan = (...ids: (string | undefined)[]) =>
          people
            .filter((p) => !ids.includes(p.id))
            .map((p) => p.displayName)
            .join(", ");
        const text = excerpt(message.body);
        const notification =
          n === 1
            ? {
                title:
                  conversation.kind === "dm"
                    ? author
                    : conversation.kind === "group"
                      ? `${author} em DM com ${othersThan(recipientId, authorId)}`
                      : `#${row?.name} · ${author}`,
                body: text,
              }
            : {
                // A notificação nova toma o lugar da anterior (mesma `tag`): ela conta por todas.
                title:
                  conversation.kind === "dm"
                    ? `${n} novas de ${author}`
                    : conversation.kind === "group"
                      ? `${n} novas em DM com ${othersThan(recipientId)}`
                      : `${n} novas em #${row?.name}`,
                body: `${author}: ${text}`,
              };
        await deliverToConversation(recipientId, conversation.id, notification);
      }
    });
  }

  /** O push de uma conversa, com `tag` e `Topic` dela (substitui o anterior) e `Urgency: high`. */
  async function deliverToConversation(
    memberId: string,
    conversationId: string,
    notification: { title: string; body: string },
  ) {
    const subscriptions = await db
      .select({ origin: pushSubscriptions.origin })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.memberId, memberId))
      .limit(1);
    if (subscriptions.length === 0) return;
    const badge = await badgeOf(memberId);
    // Um `navigate` por aparelho seria o certo se o PWA tivesse duas origens; tem uma só.
    const navigate = new URL(conversationPath(conversationId), subscriptions[0]!.origin).href;
    await deliver(memberId, {
      payload: {
        web_push: 8030,
        notification: { ...notification, navigate, tag: conversationId, lang: "pt-BR" },
        app_badge: badge,
      },
      ttl: PUSH_TTL_SECONDS,
      urgency: "high",
      topic: conversationId.replaceAll("-", ""),
    });
  }

  /**
   * Um push que não é de conversa (os do Admin sobre a Instalação; depois, os da Conta): leva a
   * `path` do PWA, com `tag` e `Topic` próprios (o novo substitui o anterior do mesmo assunto).
   */
  function notify(
    memberId: string,
    n: { title: string; body: string; path: string; tag: string; urgency: "high" | "normal" },
  ) {
    enqueue(async () => {
      const [subscription] = await db
        .select({ origin: pushSubscriptions.origin })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.memberId, memberId))
        .limit(1);
      if (!subscription) return;
      await deliver(memberId, {
        payload: {
          web_push: 8030,
          notification: {
            title: n.title,
            body: n.body,
            navigate: new URL(n.path, subscription.origin).href,
            tag: n.tag,
            lang: "pt-BR",
          },
          app_badge: await badgeOf(memberId),
        },
        ttl: PUSH_TTL_SECONDS,
        urgency: n.urgency,
        topic: n.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
      });
    });
  }

  /** Abriu a conversa: as próximas notificações dela recomeçam do "1". */
  function conversationOpened(memberId: string, conversationId: string) {
    enqueue(async () => {
      await db
        .delete(pushStreaks)
        .where(and(eq(pushStreaks.memberId, memberId), eq(pushStreaks.conversationId, conversationId)));
    });
  }

  // ---------- rotas ----------

  const routes = new Hono<Env>();

  /** Os aparelhos do Membro: a lista de Notificações e a base das faixas de push parado. */
  routes.get("/devices", async (c) => c.json(await devicesOf(c.get("member").id)));

  /** Remove um aparelho que o Membro não usa mais: some da lista, com a inscrição dele. */
  routes.delete("/devices/:deviceId", async (c) => {
    const me = c.get("member");
    const deviceId = c.req.param("deviceId");
    if (!UUID.test(deviceId)) return c.json({ error: "not_found" }, 404);
    const removed = await db.transaction(async (tx) => {
      await tx
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.memberId, me.id), eq(pushSubscriptions.deviceId, deviceId)));
      return tx
        .delete(devices)
        .where(and(eq(devices.memberId, me.id), eq(devices.id, deviceId)))
        .returning({ id: devices.id });
    });
    if (removed.length === 0) return c.json({ error: "not_found" }, 404);
    await announceDevices(me.id);
    return c.body(null, 204);
  });

  routes.get("/push/key", async (c) => c.json({ publicKey: (await vapid()).publicKey } satisfies PushKeyDto));

  /** A inscrição deste aparelho. Uma nova troca a anterior; o mesmo endpoint em outro aparelho muda de dono. */
  routes.put("/push/subscriptions/:deviceId", async (c) => {
    const me = c.get("member");
    const deviceId = c.req.param("deviceId");
    if (!UUID.test(deviceId)) return c.json({ error: "invalid_input", message: "Aparelho inválido." }, 400);
    const input = (await c.req.json().catch(() => null)) as Partial<PushSubscriptionInput> | null;
    const endpoint = typeof input?.endpoint === "string" ? input.endpoint : "";
    const { p256dh, auth } = input?.keys ?? {};
    if (!isHttps(endpoint) || typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
      return c.json({ error: "invalid_input", message: "Inscrição de push inválida." }, 400);
    }
    const now = clock.now();
    const origin = originOf(c.req.raw);
    const previousOwners = await db.transaction(async (tx) => {
      // De quem era este navegador, se de outra pessoa: o aparelho dela fica sem push.
      const previous = await tx
        .select({ memberId: pushSubscriptions.memberId })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));
      await tx
        .insert(devices)
        .values({ memberId: me.id, id: deviceId, label: c.get("who").device ?? null, createdAt: now })
        .onConflictDoUpdate({ target: [devices.memberId, devices.id], set: { pushStoppedAt: null } });
      await tx
        .delete(pushSubscriptions)
        .where(
          sql`${pushSubscriptions.endpoint} = ${endpoint} or (${pushSubscriptions.memberId} = ${me.id} and ${pushSubscriptions.deviceId} = ${deviceId})`,
        );
      await tx
        .insert(pushSubscriptions)
        .values({ endpoint, memberId: me.id, deviceId, p256dh, auth, origin, createdAt: now });
      return previous.map((p) => p.memberId).filter((id) => id !== me.id);
    });
    for (const memberId of new Set([me.id, ...previousOwners])) await announceDevices(memberId);
    return c.body(null, 204);
  });

  return {
    routes,
    messageCreated,
    conversationOpened,
    notify,
    /** Garante o par VAPID (o `main.ts` chama na subida). */
    ensureKeys: async () => {
      await vapid();
    },
    /** Espera o que já está na fila de envio (para encerrar sem cortar um push no meio). */
    idle: () => chain,
  };
}

export type Push = ReturnType<typeof createPush>;

/** O texto da mensagem numa linha, com cerca de 140 caracteres. */
function excerpt(body: string) {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isHttps(url: string) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A origem que o PWA usa (é para onde a notificação leva). Atrás do Serve, a requisição chega em
 * `http://app:3000`, e o Serve diz a de fora em `X-Forwarded-Proto`/`X-Forwarded-Host`.
 */
function originOf(req: Request) {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
