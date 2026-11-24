import {
  type AgentDto,
  type ChannelDto,
  type ExecutionDto,
  type MeDto,
  type MemberSummaryDto,
  type MessageDto,
  mentionPattern,
  normalizeHandle,
  OPEN_STATES,
  type OutcomeDto,
  type YourAccountDto,
} from "@shearim/contracts";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import { hourMinute, weekdayShort } from "./format";
import { useServerEvents } from "./live";
import { downLabel, upLabel, useReading } from "./reading";

/** "15:45" hoje; "qui., 15:45" em outro dia (Spec, história 78). */
function untilLabel(iso: string, now = new Date()) {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? hourMinute(at) : `${weekdayShort(at)}, ${hourMinute(at)}`;
}

/** O que a Conta do próprio autor explica ("sua Conta no limite até 18:00"). Só ele recebe `yourAccount`. */
function accountNote(account: YourAccountDto | null) {
  if (account?.state === "limited") return `sua Conta no limite até ${untilLabel(account.until)}`;
  if (account?.state === "needs_relink") return "sua Conta precisa ser ligada de novo";
  if (account?.state === "not_linked") return "você não ligou uma Conta";
  return null;
}

/** Junta o que se tem com o que chegou, sem repetir: a mensagem enviada chega pelo 201 e pelo WebSocket. */
function append(prev: MessageDto[] | null, arrived: MessageDto[]) {
  const have = new Set(prev?.map((m) => m.id));
  return [...(prev ?? []), ...arrived.filter((m) => !have.has(m.id))];
}

/** O Andamento que ainda aparece: o que virou resposta sai (a resposta toma o lugar dele). */
function upsertExecution(prev: Record<string, ExecutionDto>, e: ExecutionDto) {
  const next = { ...prev };
  if (e.state === "done") delete next[e.id];
  else next[e.id] = e;
  return next;
}

/** `m:ss` de uma duração em milissegundos (nunca negativa). */
function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** `m:ss` desde `since`, contando na hora (o `since` vem do servidor). */
const elapsed = (since: string, now: number) => mmss(now - new Date(since).getTime());

/** Um relógio que bate a cada segundo enquanto há cronômetro na tela. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/** O texto com o `@` de quem está vendo em destaque (o mesmo `@nome` que o servidor reconhece). */
function highlightMe(body: string, handle: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(mentionPattern())) {
    if (normalizeHandle(match[1]!) !== handle) continue;
    parts.push(body.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>);
    last = match.index + match[0].length;
  }
  parts.push(body.slice(last));
  return parts;
}

interface Props {
  channel: ChannelDto;
  me: MeDto;
  /** O Canal mudou por uma ação desta tela (entrar, adicionar alguém). */
  onChanged(channel: ChannelDto): void;
  /** A mensagem para onde a notificação levou (vem para o meio da tela e pisca). */
  focus?: string;
}

export function ChannelView({ channel, me, onChanged, focus }: Props) {
  const joined = channel.participants.some((p) => p.kind === "member" && p.id === me.id);
  return (
    <main className="channel">
      <ChannelHeader channel={channel} joined={joined} onChanged={onChanged} />
      <Conversation
        conversationId={channel.id}
        label={`#${channel.name}`}
        me={me}
        focus={focus}
        // Escrever num Canal público é entrar nele; o `channel.updated` também chega, mas a tela não espera.
        onSent={() => {
          if (!joined) api.channel(channel.id).then(onChanged, () => {});
        }}
      />
    </main>
  );
}

/**
 * As mensagens e o campo de escrever de uma conversa qualquer (Canal ou DM), pelo id dela.
 * `label` é como a conversa se chama nos rótulos ("#vendas", "Bruno").
 * O fluxo principal fica na lista; cada Thread abre num painel ao lado (no celular, por cima),
 * com a resposta ancorada, o Desfecho e o Andamento funcionando lá dentro.
 * A leitura (não-lidas, linha "Novas", avisos flutuantes, a tela que não rola sozinha) fica em
 * `useReading`, uma para o fluxo principal e outra para a Thread aberta.
 */
export function Conversation({
  conversationId,
  label,
  me,
  onSent,
  focus,
}: {
  conversationId: string;
  label: string;
  /** Quem está vendo: a mensagem que o menciona aparece destacada. */
  me: MeDto;
  onSent?(): void;
  /**
   * A mensagem para onde a notificação levou (a da falha, com "Tentar de novo"): quando ela
   * chega, vem para o meio da tela e pisca; numa Thread, a Thread abre.
   */
  focus?: string;
}) {
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [executions, setExecutions] = useState<Record<string, ExecutionDto>>({});
  /** O Desfecho de cada mensagem que recebeu um, pela mensagem. */
  const [outcomes, setOutcomes] = useState<Record<string, OutcomeDto>>({});
  /** As Threads desta conversa que quem vê segue, pela raiz. */
  const [followed, setFollowed] = useState<ReadonlySet<string>>(new Set());
  /** A raiz da Thread aberta no painel. */
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const main = messages?.filter((m) => !m.threadRootId) ?? null;
  const count = (messages?.length ?? 0) + Object.keys(executions).length;
  const reading = useReading({ conversationId, me, listRef, messages: main, contentKey: count });
  const { loaded } = reading;

  // A lista do servidor manda; o que chegou pelo WebSocket depois dela fica no fim.
  const load = useCallback(() => {
    Promise.all([
      api.messages(conversationId),
      api.executions(conversationId),
      api.conversationUnread(conversationId),
      api.outcomes(conversationId),
      api.followedThreads(),
    ]).then(
      ([list, running, unread, decided, threads]) => {
        setLoadError(false);
        setMessages((prev) => append(list, prev ?? []));
        setExecutions(Object.fromEntries(running.map((e) => [e.id, e])));
        setOutcomes(Object.fromEntries(decided.map((o) => [o.messageId, o])));
        setFollowed(
          new Set(threads.filter((th) => th.conversationId === conversationId).map((th) => th.rootMessageId)),
        );
        // As não-lidas de Thread são do painel dela; o fluxo principal abre na primeira dele.
        const inThreads = new Set(list.filter((m) => m.threadRootId).map((m) => m.id));
        loaded(unread.messageIds.filter((id) => !inThreads.has(id)));
      },
      () => setLoadError(true),
    );
  }, [conversationId, loaded]);

  useEffect(load, [load]);

  // Uma vez por foco pedido, depois de a conversa abrir (o salto vem depois da linha "Novas").
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focus || focused.current === focus || reading.divider === undefined) return;
    const target = messages?.find((m) => m.id === focus);
    if (!target) return;
    focused.current = focus;
    if (target.threadRootId) setOpenThread(target.threadRootId);
    else reading.jump(focus);
  }, [focus, messages, reading]);

  useServerEvents((event) => {
    // Cada (re)conexão começa com `ready`: recarrega o que pode ter passado enquanto ela não estava aberta.
    if (event.type === "ready") load();
    if (event.type === "message.created" && event.message.channelId === conversationId) {
      if (!event.message.threadRootId) reading.arrived(event.message);
      setMessages((prev) => append(prev, [event.message]));
    }
    if (event.type === "execution.updated" && event.execution.channelId === conversationId) {
      setExecutions((prev) => upsertExecution(prev, event.execution));
    }
    // Quem escreveu foi removido: as mensagens dele ganham a marca.
    if (event.type === "member.removed") {
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.author.kind === "member" && m.author.id === event.memberId
              ? { ...m, author: { ...m.author, leftWorkspace: true } }
              : m,
          ) ?? null,
      );
    }
    if (event.type === "outcome.created" && event.outcome.channelId === conversationId) {
      const { outcome } = event;
      setOutcomes((prev) => ({ ...prev, [outcome.messageId]: outcome }));
    }
    if (event.type === "thread.followed" && event.thread.conversationId === conversationId) {
      const root = event.thread.rootMessageId;
      setFollowed((prev) => new Set([...prev, root]));
    }
    // Quem escreveu trocou o nome ou a foto: as mensagens dele já mostram o novo.
    if (event.type === "member.updated") {
      const { id, displayName, profilePicUrl } = event.member;
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.author.kind === "member" && m.author.id === id
              ? { ...m, author: { ...m.author, displayName, profilePicUrl } }
              : m,
          ) ?? null,
      );
    }
  });

  async function send(body: string, threadRootId: string | null) {
    const msg = await api.send(conversationId, { body, threadRootId });
    onSent?.();
    setMessages((prev) => append(prev, [msg]));
  }

  // As respostas ancoradas ficam sob a origem (no fluxo principal ou na Thread dela).
  const replies = new Map<string, MessageDto[]>();
  const threadSize = new Map<string, number>();
  for (const m of messages ?? []) {
    if (m.originMessageId) replies.set(m.originMessageId, [...(replies.get(m.originMessageId) ?? []), m]);
    if (m.threadRootId) threadSize.set(m.threadRootId, (threadSize.get(m.threadRootId) ?? 0) + 1);
  }
  // O roteamento em curso fica sob a mensagem ("Sophya decidindo"); o resto, no lugar da resposta.
  const pending = new Map<string, ExecutionDto[]>();
  const deciding = new Map<string, ExecutionDto>();
  for (const e of Object.values(executions)) {
    // O roteamento que espera na fila mostra "⏸ na fila", e o que espera a vez, "esperando a vez":
    // não "decidindo".
    if (e.kind === "route" && !e.held && !e.waitingTurn && (e.state === "queued" || e.state === "running")) {
      deciding.set(e.originMessageId, e);
    } else pending.set(e.originMessageId, [...(pending.get(e.originMessageId) ?? []), e]);
  }
  const now = useNow(Object.values(executions).some((e) => OPEN_STATES.includes(e.state)));
  const ctx: GroupContext = {
    me,
    conversationId,
    replies,
    pending,
    deciding,
    outcomes,
    now,
    showExecution: (e) => setExecutions((prev) => upsertExecution(prev, e)),
    find: (id) => messages?.find((m) => m.id === id),
  };
  const root = openThread ? messages?.find((m) => m.id === openThread) : undefined;

  return (
    <div className="conversation-view">
      <div className="main-flow">
        <Stream
          listRef={listRef}
          label={`Mensagens de ${label}`}
          busy={(messages === null || reading.divider === undefined) && !loadError}
          reading={reading}
          ctx={ctx}
        >
          {loadError && <li className="notice">Não foi possível carregar as mensagens. Recarregue a página.</li>}
          {main?.length === 0 && <li className="notice">Nenhuma mensagem ainda. Diga oi!</li>}
          <MessageGroups
            items={main ?? []}
            ctx={ctx}
            reading={reading}
            thread={{ size: threadSize, open: setOpenThread }}
          />
        </Stream>
        <Composer
          label={`Mensagem para ${label}`}
          onSend={async (body) => {
            await send(body, null);
            reading.sent(); // quem envia vai para o fim
          }}
        />
      </div>
      {root && messages && (
        <ThreadPanel
          key={root.id}
          root={root}
          messages={messages}
          ctx={ctx}
          following={followed.has(root.id)}
          onSend={(body) => send(body, root.id)}
          onClose={() => setOpenThread(null)}
        />
      )}
    </div>
  );
}

/** O que os grupos de mensagem precisam saber da conversa (o mesmo no fluxo principal e na Thread). */
interface GroupContext {
  me: MeDto;
  conversationId: string;
  /** As respostas ancoradas, pela mensagem de origem. */
  replies: Map<string, MessageDto[]>;
  /** O Andamento no lugar da resposta, pela mensagem de origem. */
  pending: Map<string, ExecutionDto[]>;
  /** O roteamento em curso, pela mensagem de origem. */
  deciding: Map<string, ExecutionDto>;
  outcomes: Record<string, OutcomeDto>;
  now: number;
  showExecution(e: ExecutionDto): void;
  find(id: string): MessageDto | undefined;
}

type Reading = ReturnType<typeof useReading>;

/** A lista rolável, com os avisos flutuantes de não-lidas por cima. */
function Stream({
  listRef,
  label,
  busy,
  reading,
  ctx,
  children,
}: {
  listRef: RefObject<HTMLOListElement | null>;
  label: string;
  busy: boolean;
  reading: Reading;
  ctx: GroupContext;
  children: ReactNode;
}) {
  const { up, down } = reading.pills;
  return (
    <div className="stream">
      <ol ref={listRef} className="messages" aria-label={label} aria-busy={busy} onScroll={reading.onScroll}>
        {children}
      </ol>
      {up.length > 0 && (
        <button type="button" className="pill up" onClick={() => reading.jump(up[up.length - 1]!.id)}>
          {upLabel(up, ctx.me, ctx.find)}
        </button>
      )}
      {down.length > 0 && (
        <button type="button" className="pill down" onClick={() => reading.jump(down[0]!.id)}>
          {downLabel(down)}
        </button>
      )}
    </div>
  );
}

const NEW_LINE = (
  <li className="new-divider" data-divider>
    <hr aria-label="Novas" />
    <span aria-hidden="true">Novas</span>
  </li>
);

/**
 * Cada mensagem de pessoa com o Desfecho e, logo abaixo, as respostas ancoradas e o Andamento.
 * No fluxo principal (`thread`), o resumo da Thread que pendura na mensagem, ou o convite a abrir uma.
 */
function MessageGroups({
  items,
  ctx,
  reading,
  thread,
}: {
  items: MessageDto[];
  ctx: GroupContext;
  reading: Reading;
  thread?: { size: Map<string, number>; open(rootId: string): void };
}) {
  const { me, conversationId, replies, pending, deciding, outcomes, now, showExecution } = ctx;
  const ids = new Set(items.map((m) => m.id));
  const top = items.filter((m) => !m.originMessageId || !ids.has(m.originMessageId));
  return top.map((m) => {
    const answers = (replies.get(m.id) ?? []).filter((r) => ids.has(r.id));
    const running = pending.get(m.id) ?? [];
    const mine = m.author.kind === "member" && m.author.id === me.id;
    const cancellable = mine && running.some((e) => OPEN_STATES.includes(e.state));
    const cancel = () => api.cancelMessage(conversationId, m.id).then((list) => list.forEach(showExecution));
    // "⚠ pela Chave do Workspace" fica sob a mensagem; o autor vê também o porquê, enquanto a
    // resposta sai (no Andamento) e depois dela (na própria resposta).
    const byKey = running.find((e) => e.payer === "key");
    const paidAnswer = answers.find((r) => r.payer === "key");
    const paid =
      byKey || paidAnswer
        ? { note: accountNote(byKey?.yourAccount ?? answers.find((r) => r.yourAccount)?.yourAccount ?? null) }
        : undefined;
    const threadLink = (id: string, always: boolean) =>
      thread && (always || (thread.size.get(id) ?? 0) > 0) ? (
        <ThreadLink size={thread.size.get(id) ?? 0} onOpen={() => thread.open(id)} />
      ) : null;
    return (
      <Fragment key={m.id}>
        {reading.divider === m.id && NEW_LINE}
        <li className="message-group">
          <MessageRow
            message={m}
            me={me}
            flash={reading.flashId === m.id}
            outcome={outcomes[m.id]}
            deciding={deciding.get(m.id)}
            paid={paid}
            now={now}
            onCancel={mine && !cancellable ? cancel : undefined}
          />
          {(answers.length > 0 || running.length > 0) && (
            <ul className="anchored" aria-label={`Respostas a ${m.author.displayName}`}>
              {answers.map((r) => (
                <Fragment key={r.id}>
                  {reading.divider === r.id && NEW_LINE}
                  <li>
                    <MessageRow message={r} me={me} flash={reading.flashId === r.id} />
                    {threadLink(r.id, false)}
                  </li>
                </Fragment>
              ))}
              {running.map((e) => (
                <li key={e.id}>
                  <Progress
                    execution={e}
                    now={now}
                    onRetry={mine ? () => api.retryExecution(conversationId, e.id).then(showExecution) : undefined}
                  />
                </li>
              ))}
              {cancellable && (
                <li>
                  <CancelButton onCancel={cancel} />
                </li>
              )}
            </ul>
          )}
          {threadLink(m.id, true)}
        </li>
      </Fragment>
    );
  });
}

/** Sob a mensagem do fluxo principal: "3 respostas" abre a Thread; sem Thread, "Responder na Thread". */
function ThreadLink({ size, onOpen }: { size: number; onOpen(): void }) {
  return (
    <p className={size > 0 ? "thread-link has-thread" : "thread-link"}>
      <button type="button" className="link" onClick={onOpen}>
        {size === 0 ? "Responder na Thread" : size === 1 ? "1 resposta" : `${size} respostas`}
      </button>
    </p>
  );
}

/**
 * O painel da Thread: a raiz, as mensagens da Thread com as respostas ancoradas, o Desfecho e o
 * Andamento, e o campo de responder. A leitura dele é à parte: o que aparece aqui é marcado aqui.
 */
function ThreadPanel({
  root,
  messages,
  ctx,
  following,
  onSend,
  onClose,
}: {
  root: MessageDto;
  messages: MessageDto[];
  ctx: GroupContext;
  following: boolean;
  onSend(body: string): Promise<void>;
  onClose(): void;
}) {
  const { me, conversationId } = ctx;
  const listRef = useRef<HTMLOListElement>(null);
  const items = messages.filter((m) => m.threadRootId === root.id);
  const reading = useReading({
    conversationId,
    me,
    listRef,
    messages: items,
    contentKey: items.length + [...ctx.pending.values()].flat().length,
  });
  const { loaded } = reading;
  const inThread = useRef(new Set<string>());
  inThread.current = new Set(items.map((m) => m.id));

  // As não-lidas desta Thread: abre na primeira, com a linha "Novas".
  useEffect(() => {
    api.conversationUnread(conversationId).then(
      (unread) => loaded(unread.messageIds.filter((id) => inThread.current.has(id))),
      () => loaded([]),
    );
  }, [conversationId, loaded]);

  useServerEvents((event) => {
    if (event.type === "message.created" && event.message.threadRootId === root.id) reading.arrived(event.message);
  });

  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong>
        {following && <span className="muted">Você segue esta Thread</span>}
        <button type="button" className="link" onClick={onClose}>
          Fechar
        </button>
      </header>
      <Stream
        listRef={listRef}
        label="Mensagens da Thread"
        busy={reading.divider === undefined}
        reading={reading}
        ctx={ctx}
      >
        <li className="thread-root">
          <MessageRow message={root} me={me} outcome={ctx.outcomes[root.id]} now={ctx.now} />
        </li>
        <MessageGroups items={items} ctx={ctx} reading={reading} />
      </Stream>
      <Composer
        label="Responder na Thread"
        onSend={async (body) => {
          await onSend(body);
          reading.sent();
        }}
      />
    </aside>
  );
}

/** O campo de escrever: Enter envia, Shift+Enter quebra a linha. */
function Composer({ label, onSend }: { label: string; onSend(body: string): Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    const body = draft;
    setSending(true);
    setSendError(false);
    // O campo esvazia na hora (a mensagem pode chegar pelo WebSocket antes da resposta do envio);
    // se o envio falhar, o texto volta.
    setDraft("");
    try {
      await onSend(body);
    } catch {
      setDraft((now) => now || body);
      setSendError(true);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <form className="composer" onSubmit={send}>
      {sendError && (
        <p className="error" role="alert">
          A mensagem não foi enviada. Tente de novo.
        </p>
      )}
      <textarea
        aria-label={label}
        placeholder={label}
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={sending || !draft.trim()}>
        Enviar
      </button>
    </form>
  );
}

/** "Faro", "Faro e Prisma", "Faro, Prisma e Lince". */
function joinNames(names: string[]) {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

function MessageRow({
  message: m,
  me,
  flash,
  outcome,
  deciding,
  paid,
  now = 0,
  onCancel,
}: {
  message: MessageDto;
  me: MeDto;
  flash?: boolean;
  /** O Desfecho da Articuladora a esta mensagem (só a de pessoa, num Canal com outros Agentes). */
  outcome?: OutcomeDto;
  /** O roteamento em curso: "Sophya decidindo quem responde · 0:03". */
  deciding?: ExecutionDto;
  /** Alguma resposta saiu (ou está saindo) pela Chave do Workspace; `note` só para o autor. */
  paid?: { note: string | null };
  now?: number;
  /** Quem escreveu cancela enquanto a Articuladora decide. */
  onCancel?(): Promise<void>;
}) {
  const agent = m.author.kind === "agent";
  const mentionsMe = m.mentions.some((x) => x.kind === "member" && x.id === me.id);
  const className = ["message", agent && "agent", mentionsMe && "mentions-me"].filter(Boolean).join(" ");
  return (
    <article
      className={className}
      aria-label={`Mensagem de ${m.author.displayName}`}
      data-message-id={m.id}
      data-flash={flash ? "true" : undefined}
    >
      <Avatar
        name={m.author.displayName}
        agent={agent}
        photo={m.author.kind === "agent" ? m.author.photo : m.author.profilePicUrl}
      />
      <div>
        <div className="meta">
          <strong>{m.author.displayName}</strong>
          {m.author.kind === "member" && m.author.leftWorkspace && (
            <span className="left-workspace">saiu do Workspace</span>
          )}
          <time dateTime={m.createdAt}>{hourMinute(m.createdAt)}</time>
          {outcome?.decision === "none" && <NoneMark outcome={outcome} />}
          {mentionsMe && <span className="mention-tag">menciona você</span>}
        </div>
        <p className="body">{mentionsMe ? highlightMe(m.body, me.handle) : m.body}</p>
        {deciding && (
          <p className="micro" role="status" aria-label={`${deciding.agent.displayName} decidindo quem responde`}>
            <span className="spin" aria-hidden="true" />
            {deciding.agent.displayName} decidindo quem responde · {elapsed(deciding.since, now)}
          </p>
        )}
        {deciding && onCancel && <CancelButton onCancel={onCancel} />}
        {paid && <p className="paid">⚠ pela Chave do Workspace{paid.note && ` · ${paid.note}`}</p>}
        {outcome?.decision === "delegate" && <DelegationLine outcome={outcome} />}
      </div>
    </article>
  );
}

/**
 * "Nenhum Agente precisa agir": só um `⌀` discreto ao lado da hora. O motivo aparece ao passar o
 * mouse (`title`) ou ao tocar.
 */
function NoneMark({ outcome }: { outcome: OutcomeDto }) {
  const [open, setOpen] = useState(false);
  const text = `${outcome.by.displayName}: nenhum Agente precisa agir. ${outcome.reason}`;
  return (
    <>
      <button
        type="button"
        className="nil"
        title={text}
        aria-label={text}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⌀
      </button>
      {open && (
        <span className="micro" role="note">
          {text}
        </span>
      )}
    </>
  );
}

/** "↳ Sophya passou para Faro e Prisma": o motivo e o que cada um cobre, ao passar o mouse ou tocar. */
function DelegationLine({ outcome }: { outcome: OutcomeDto }) {
  const [open, setOpen] = useState(false);
  const line = `↳ ${outcome.by.displayName} passou para ${joinNames(outcome.delegates.map((d) => d.agent.displayName))}`;
  const detail = [outcome.reason, ...outcome.delegates.map((d) => `${d.agent.displayName}: ${d.cover}`)];
  return (
    <div className="delegation">
      <button
        type="button"
        className="micro link-quiet"
        title={detail.join("\n")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {line}
      </button>
      {open && (
        <ul className="micro delegation-detail" aria-label="Por que e o que cada um cobre">
          {detail.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * O Andamento no lugar onde a resposta vai entrar: a bolha "escrevendo · 0:05" (com "2ª tentativa"
 * e "tentando de novo (n/m)"), "esperando a vez", a espera da nova tentativa automática, o cartão
 * de falha com "Tentar de novo" (só para quem escreveu: `onRetry`), "Agentes não agem" e o
 * cancelamento.
 */
function Progress({ execution: e, now, onRetry }: { execution: ExecutionDto; now: number; onRetry?(): Promise<void> }) {
  const name = e.agent.displayName;
  if (e.state === "failed") {
    return (
      <div className="message agent">
        <Avatar name={name} agent photo={e.agent.photo} />
        <fieldset className="failcard" aria-label={`Falha de ${name}`}>
          <strong>{name}</strong>
          <p className="why">
            {name} não respondeu: {e.reason ?? "erro desconhecido"}.
          </p>
          {onRetry && <RetryButton onRetry={onRetry} />}
        </fieldset>
      </div>
    );
  }
  if (e.state === "not_acting") {
    const mine = accountNote(e.yourAccount);
    return <p className="blocked">Agentes não agem: {mine ? `${mine} e ${e.reason}` : e.reason}</p>;
  }
  if (e.state === "queued" && e.held) {
    // Todos veem a fila; só o autor vê até quando (a Conta dele).
    const until =
      e.yourAccount?.state === "limited"
        ? ` até ${untilLabel(e.yourAccount.until)}`
        : e.yourAccount?.state === "needs_relink"
          ? " até você ligar sua Conta de novo"
          : "";
    return (
      <p className="queued" role="status">
        ⏸ na fila{until}
      </p>
    );
  }
  if (e.state === "cancelled") {
    // Sem motivo, foi quem escreveu; com motivo, o Shearim (ex.: quem escreveu saiu do Workspace).
    return <p className="cancelled">{e.reason ? `cancelada: ${e.reason}` : "cancelada por quem escreveu"}</p>;
  }
  if (e.waitingTurn) {
    // Pronta, mas o Agente ainda responde a outra mensagem ou o teto de quem paga está cheio.
    return (
      <p className="queued" role="status" aria-label={`${name} esperando a vez`}>
        {name} · esperando a vez
      </p>
    );
  }
  if (e.state === "retrying") {
    const wait = mmss(e.retryAt ? new Date(e.retryAt).getTime() - now : 0);
    return (
      <div className="message agent" role="status" aria-label={`${name} vai tentar de novo`}>
        <Avatar name={name} agent photo={e.agent.photo} />
        <div>
          <div className="meta">
            <strong>{name}</strong>
          </div>
          <p className="writing">
            {name} não respondeu: {e.reason}. 2ª tentativa em {wait}
          </p>
        </div>
      </div>
    );
  }
  const retry = e.attempt > 1 ? ` (${e.attempt}ª tentativa)` : "";
  return (
    <div className="message agent" role="status" aria-label={`${name} escrevendo`}>
      <Avatar name={name} agent photo={e.agent.photo} />
      <div>
        <div className="meta">
          <strong>{name}</strong>
        </div>
        <p className="writing">
          {e.apiRetry ? (
            `tentando de novo (${e.apiRetry.attempt}/${e.apiRetry.max})`
          ) : (
            <span className="dots">escrevendo</span>
          )}
          {retry} · {elapsed(e.since, now)}
        </p>
      </div>
    </div>
  );
}

/** Um botão que espera a chamada e mostra o erro dela, sem travar a tela. */
function useAction(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function act() {
    setBusy(true);
    setFailed(false);
    try {
      await run();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return { busy, failed, act };
}

function RetryButton({ onRetry }: { onRetry(): Promise<void> }) {
  const { busy, failed, act } = useAction(onRetry);
  return (
    <div className="failcard-actions">
      <button type="button" className="primary" disabled={busy} onClick={act}>
        Tentar de novo
      </button>
      {failed && <span className="error">Não deu certo. Tente de novo.</span>}
    </div>
  );
}

function CancelButton({ onCancel }: { onCancel(): Promise<void> }) {
  const { busy, failed, act } = useAction(onCancel);
  return (
    <p className="cancel">
      <button type="button" className="link" disabled={busy} onClick={act}>
        Cancelar
      </button>
      {failed && <span className="error">Não deu para cancelar.</span>}
    </p>
  );
}

function ChannelHeader({ channel, joined, onChanged }: Omit<Props, "me"> & { joined: boolean }) {
  const [adding, setAdding] = useState<"person" | "agent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = channel.participants.map((p) => p.displayName).join(", ");
  const toggle = (what: "person" | "agent") => setAdding((v) => (v === what ? null : what));

  async function act(run: () => Promise<ChannelDto>) {
    setError(null);
    try {
      onChanged(await run());
      setAdding(null);
    } catch {
      setError("Não deu certo. Tente de novo.");
    }
  }

  return (
    <header className="channel-header">
      <div className="row">
        <h1 className="channel-name">
          # {channel.name}
          {channel.kind === "private" && (
            <>
              {" "}
              <span className="tag">privado</span>
            </>
          )}
        </h1>
        <span className="hint" title={names}>
          {channel.participants.length === 1 ? "1 participante" : `${channel.participants.length} participantes`}
        </span>
        {joined ? (
          <>
            <button type="button" className="link" onClick={() => toggle("person")}>
              Adicionar pessoa
            </button>
            <button type="button" className="link" onClick={() => toggle("agent")}>
              Adicionar Agente
            </button>
          </>
        ) : (
          channel.kind === "public" && (
            <button type="button" className="link" onClick={() => act(() => api.joinChannel(channel.id))}>
              Entrar no Canal
            </button>
          )
        )}
      </div>
      {channel.instructions && (
        <p className="instructions">
          <strong>Instruções do Canal:</strong> {channel.instructions}
        </p>
      )}
      {adding === "person" && (
        <AddPerson
          channel={channel}
          onAdd={(memberId) => act(() => api.addParticipant(channel.id, memberId))}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === "agent" && (
        <AddAgent
          channel={channel}
          onAdd={(agentId) => act(() => api.addAgent(channel.id, agentId))}
          onCancel={() => setAdding(null)}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}

function AddPerson({
  channel,
  onAdd,
  onCancel,
}: {
  channel: ChannelDto;
  onAdd(memberId: string): void;
  onCancel(): void;
}) {
  const [members, setMembers] = useState<MemberSummaryDto[] | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    api.members().then(setMembers, () => setMembers([]));
  }, []);

  const inside = new Set(channel.participants.filter((p) => p.kind === "member").map((p) => p.id));
  const outside = members?.filter((m) => !inside.has(m.id)) ?? [];

  if (members && outside.length === 0) {
    return (
      <p className="hint">
        Todos os Membros já participam.{" "}
        <button type="button" className="link" onClick={onCancel}>
          Fechar
        </button>
      </p>
    );
  }
  return (
    <form
      className="row"
      aria-label={`Adicionar pessoa a #${channel.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) onAdd(choice);
      }}
    >
      <select aria-label="Pessoa" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Escolha uma pessoa…</option>
        {outside.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!choice}>
        Adicionar
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancelar
      </button>
    </form>
  );
}

function AddAgent({
  channel,
  onAdd,
  onCancel,
}: {
  channel: ChannelDto;
  onAdd(agentId: string): void;
  onCancel(): void;
}) {
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    api.agents().then(setAgents, () => setAgents([]));
  }, []);

  const inside = new Set(channel.participants.filter((p) => p.kind === "agent").map((p) => p.id));
  const outside = agents?.filter((a) => !inside.has(a.id)) ?? [];

  if (agents && outside.length === 0) {
    return (
      <p className="hint">
        {agents.length === 0 ? "O Workspace ainda não tem Agentes." : "Todos os Agentes já estão no Canal."}{" "}
        <button type="button" className="link" onClick={onCancel}>
          Fechar
        </button>
      </p>
    );
  }
  return (
    <form
      className="row"
      aria-label={`Adicionar Agente a #${channel.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) onAdd(choice);
      }}
    >
      <select aria-label="Agente" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Escolha um Agente…</option>
        {outside.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.description ? ` · ${a.description}` : ""}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!choice}>
        Adicionar
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancelar
      </button>
    </form>
  );
}
