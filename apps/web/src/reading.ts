import type { MeDto, MessageDto } from "@shearim/contracts";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";

/** "Perto do fim": a tela acompanha o fim só quando a pessoa já está nele (Spec, Leitura). */
const NEAR_END_PX = 60;
/** Quanto de uma mensagem precisa entrar na área visível para contar como vista. */
const SEEN_MARGIN_PX = 4;
/** A linha "Novas" fica a esta distância do topo quando a conversa abre. */
const DIVIDER_TOP_PX = 8;
/** Junta as marcas de leitura antes de mandar; e, se falhar, tenta de novo depois disto. */
const FLUSH_MS = 150;
const RETRY_MS = 3_000;
/** Quanto dura o piscar da mensagem para onde o aviso levou. */
const FLASH_MS = 1_600;

export interface Pills {
  /** Não-lidas acima da área visível, na ordem de exibição. */
  up: MessageDto[];
  /** Não-lidas abaixo. */
  down: MessageDto[];
}

const NO_PILLS: Pills = { up: [], down: [] };
const sameIds = (a: MessageDto[], b: MessageDto[]) => a.length === b.length && a.every((m, i) => m.id === b[i]!.id);

/**
 * A leitura de uma conversa aberta (Spec, módulo 14, "Leitura"; protótipo resposta-ancorada A):
 *
 * - marca como lida cada mensagem que aparece na tela (com a aba visível) e manda ao servidor;
 * - abre na primeira não-lida, com a linha "Novas" antes dela, ou no fim se não há;
 * - a tela nunca rola sozinha, exceto para acompanhar o fim quando a pessoa já está nele:
 *   fora do fim, o primeiro elemento visível fica onde estava quando algo entra acima;
 * - diz quais não-lidas estão fora da tela, acima e abaixo, para os avisos flutuantes;
 * - `jump` leva até uma mensagem e a faz piscar.
 *
 * As mensagens são os elementos com `data-message-id` dentro de `listRef`, na ordem de exibição.
 */
export function useReading(opts: {
  conversationId: string;
  me: MeDto;
  listRef: RefObject<HTMLElement | null>;
  messages: MessageDto[] | null;
  /** Muda quando algo na lista muda de tamanho (mensagens, Andamento). */
  contentKey: number;
}) {
  const { conversationId, me, listRef, messages, contentKey } = opts;
  const unread = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const atEnd = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  /**
   * Um salto em curso (o toque no aviso): até ele assentar, a lista que muda (o Andamento de
   * outra mensagem, um Desfecho) mantém a mensagem do salto no meio, em vez de cortar o salto.
   */
  const jumping = useRef<{ id: string; until: number } | null>(null);
  const opened = useRef(false);
  const byId = useRef(new Map<string, MessageDto>());
  /** A primeira não-lida de quando a conversa abriu: `undefined` até as não-lidas chegarem. */
  const [divider, setDivider] = useState<string | null | undefined>(undefined);
  const [pills, setPills] = useState<Pills>(NO_PILLS);
  const [flashId, setFlashId] = useState<string | null>(null);

  byId.current = new Map(messages?.map((m) => [m.id, m]));

  const flush = useCallback(() => {
    flushTimer.current = undefined;
    const ids = [...pending.current];
    if (ids.length === 0) return;
    pending.current.clear();
    api.markRead(conversationId, ids).catch(() => {
      // O servidor ainda as tem como não-lidas: tenta de novo, sem voltar o aviso na tela.
      for (const id of ids) pending.current.add(id);
      flushTimer.current ??= setTimeout(flush, RETRY_MS);
    });
  }, [conversationId]);

  useEffect(
    () => () => {
      clearTimeout(flushTimer.current);
      flush();
    },
    [flush],
  );

  /** Mede a lista: marca o que está na tela, guarda a âncora e calcula os avisos. */
  const scan = useCallback(() => {
    const list = listRef.current;
    if (!list || !opened.current) return;
    const box = list.getBoundingClientRect();
    const visible = document.visibilityState === "visible";
    let first: { id: string; offset: number } | null = null;
    const up: MessageDto[] = [];
    const down: MessageDto[] = [];
    let seen = false;
    for (const el of list.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = el.dataset.messageId!;
      const r = el.getBoundingClientRect();
      if (!first && r.bottom > box.top + 1) first = { id, offset: r.top - box.top };
      if (!unread.current.has(id)) continue;
      const m = byId.current.get(id);
      if (r.bottom <= box.top + SEEN_MARGIN_PX) m && up.push(m);
      else if (r.top >= box.bottom - SEEN_MARGIN_PX) m && down.push(m);
      else if (visible) {
        unread.current.delete(id);
        pending.current.add(id);
        seen = true;
      }
    }
    anchor.current = first;
    if (seen) flushTimer.current ??= setTimeout(flush, FLUSH_MS);
    setPills((prev) => (sameIds(prev.up, up) && sameIds(prev.down, down) ? prev : { up, down }));
  }, [listRef, flush]);

  // Abrir: na linha "Novas" (a primeira não-lida, que pode ser uma resposta ancorada lá em cima), ou no fim.
  // Depois disso, quando a lista muda: acompanha o fim, ou mantém o que estava à vista no lugar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `contentKey` é o gatilho de propósito.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || messages === null || divider === undefined) return;
    if (!opened.current) {
      opened.current = true;
      const line = list.querySelector<HTMLElement>("[data-divider]");
      if (line) {
        list.scrollTop += line.getBoundingClientRect().top - list.getBoundingClientRect().top - DIVIDER_TOP_PX;
        atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_END_PX;
      } else {
        list.scrollTop = list.scrollHeight;
        atEnd.current = true;
      }
    } else if (jumping.current && Date.now() < jumping.current.until) {
      list.querySelector<HTMLElement>(`[data-message-id="${jumping.current.id}"]`)?.scrollIntoView({ block: "center" });
    } else if (atEnd.current) {
      list.scrollTop = list.scrollHeight;
    } else if (anchor.current) {
      const el = list.querySelector<HTMLElement>(`[data-message-id="${anchor.current.id}"]`);
      if (el) {
        const offset = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += offset - anchor.current.offset;
      }
    }
    scan();
  }, [contentKey, messages === null, divider, scan, listRef]);

  useEffect(() => {
    const again = () => scan();
    document.addEventListener("visibilitychange", again);
    window.addEventListener("resize", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("resize", again);
    };
  }, [scan]);

  const loaded = useCallback(
    (ids: string[]) => {
      unread.current = new Set(ids.filter((id) => !pending.current.has(id)));
      setDivider((prev) => (prev === undefined ? (ids[0] ?? null) : prev));
      if (opened.current) scan();
    },
    [scan],
  );

  useEffect(() => {
    if (!flashId) return;
    const id = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flashId]);

  return {
    divider,
    pills,
    flashId,
    /** As não-lidas do servidor, na ordem de exibição. A primeira vez define onde a conversa abre. */
    loaded,
    /** Mensagem nova na conversa: a de outra pessoa ou de um Agente ainda não foi vista. */
    arrived(message: MessageDto) {
      if (message.author.kind === "member" && message.author.id === me.id) return;
      unread.current.add(message.id);
    },
    /** Quem envia vai para o fim. */
    sent() {
      atEnd.current = true;
    },
    onScroll() {
      const list = listRef.current;
      if (list) atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_END_PX;
      scan();
    },
    /** Leva até a mensagem (no meio da tela) e a faz piscar. */
    jump(id: string) {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!el) return;
      atEnd.current = false;
      jumping.current = { id, until: Date.now() + FLASH_MS };
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlashId(null);
      requestAnimationFrame(() => setFlashId(id));
    },
  };
}

/** O texto do aviso de cima: "↑ Faro respondeu Juliana", "↑ 2 respostas acima" ou "↑ 3 novas acima". */
export function upLabel(up: MessageDto[], me: MeDto, find: (id: string) => MessageDto | undefined) {
  const replies = up.filter((m) => m.originMessageId);
  if (up.length === 1 && replies.length === 1) {
    const reply = replies[0]!;
    const origin = find(reply.originMessageId!);
    const to =
      origin?.author.kind === "member" && origin.author.id === me.id ? "você" : (origin?.author.displayName ?? "");
    return `↑ ${reply.author.displayName} respondeu ${to}`;
  }
  return replies.length === up.length ? `↑ ${up.length} respostas acima` : `↑ ${up.length} novas acima`;
}

/** O texto do aviso de baixo: "↓ 1 nova abaixo" ou "↓ n novas abaixo". */
export function downLabel(down: MessageDto[]) {
  return `↓ ${down.length} ${down.length === 1 ? "nova" : "novas"} abaixo`;
}
