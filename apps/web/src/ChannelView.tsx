import type { AgentDto, ChannelDto, ExecutionDto, MeDto, MemberSummaryDto, MessageDto } from "@shearim/contracts";
import { type FormEvent, Fragment, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import { useServerEvents } from "./live";
import { downLabel, upLabel, useReading } from "./reading";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

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

/** `m:ss` desde `since`, contando na hora (o `since` vem do servidor). */
function elapsed(since: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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

interface Props {
  channel: ChannelDto;
  me: MeDto;
  /** O Canal mudou por uma ação desta tela (entrar, adicionar alguém). */
  onChanged(channel: ChannelDto): void;
}

export function ChannelView({ channel, me, onChanged }: Props) {
  const joined = channel.participants.some((p) => p.kind === "member" && p.id === me.id);
  return (
    <main className="channel">
      <ChannelHeader channel={channel} joined={joined} onChanged={onChanged} />
      <Conversation
        conversationId={channel.id}
        label={`#${channel.name}`}
        me={me}
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
 * A leitura (não-lidas, linha "Novas", avisos flutuantes, a tela que não rola sozinha) fica em `useReading`.
 */
export function Conversation({
  conversationId,
  label,
  me,
  onSent,
}: {
  conversationId: string;
  label: string;
  me: MeDto;
  onSent?(): void;
}) {
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [executions, setExecutions] = useState<Record<string, ExecutionDto>>({});
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const count = (messages?.length ?? 0) + Object.keys(executions).length;
  const reading = useReading({ conversationId, me, listRef, messages, contentKey: count });
  const { loaded } = reading;

  // A lista do servidor manda; o que chegou pelo WebSocket depois dela fica no fim.
  const load = useCallback(() => {
    Promise.all([
      api.messages(conversationId),
      api.executions(conversationId),
      api.conversationUnread(conversationId),
    ]).then(
      ([list, running, unread]) => {
        setLoadError(false);
        setMessages((prev) => append(list, prev ?? []));
        setExecutions(Object.fromEntries(running.map((e) => [e.id, e])));
        loaded(unread.messageIds);
      },
      () => setLoadError(true),
    );
  }, [conversationId, loaded]);

  useEffect(load, [load]);

  useServerEvents((event) => {
    // Cada (re)conexão começa com `ready`: recarrega o que pode ter passado enquanto ela não estava aberta.
    if (event.type === "ready") load();
    if (event.type === "message.created" && event.message.channelId === conversationId) {
      reading.arrived(event.message);
      setMessages((prev) => append(prev, [event.message]));
    }
    if (event.type === "execution.updated" && event.execution.channelId === conversationId) {
      setExecutions((prev) => upsertExecution(prev, event.execution));
    }
  });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(false);
    try {
      const msg = await api.send(conversationId, { body: draft });
      onSent?.();
      reading.sent(); // quem envia vai para o fim
      setMessages((prev) => append(prev, [msg]));
      setDraft("");
    } catch {
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

  // Mensagens de pessoas em ordem de tempo; as respostas ancoradas ficam sob a origem.
  const replies = new Map<string, MessageDto[]>();
  for (const m of messages ?? []) {
    if (m.originMessageId) replies.set(m.originMessageId, [...(replies.get(m.originMessageId) ?? []), m]);
  }
  const ids = new Set(messages?.map((m) => m.id));
  const top = messages?.filter((m) => !m.originMessageId || !ids.has(m.originMessageId)) ?? [];
  const pending = new Map<string, ExecutionDto[]>();
  for (const e of Object.values(executions)) {
    pending.set(e.originMessageId, [...(pending.get(e.originMessageId) ?? []), e]);
  }
  const now = useNow(Object.values(executions).some((e) => e.state === "queued" || e.state === "running"));
  const find = (id: string) => messages?.find((m) => m.id === id);
  const { up, down } = reading.pills;
  const newLine = (
    <li className="new-divider" data-divider>
      <hr aria-label="Novas" />
      <span aria-hidden="true">Novas</span>
    </li>
  );

  return (
    <>
      <div className="stream">
        <ol
          ref={listRef}
          className="messages"
          aria-label={`Mensagens de ${label}`}
          aria-busy={(messages === null || reading.divider === undefined) && !loadError}
          onScroll={reading.onScroll}
        >
          {loadError && <li className="notice">Não foi possível carregar as mensagens. Recarregue a página.</li>}
          {messages?.length === 0 && <li className="notice">Nenhuma mensagem ainda. Diga oi!</li>}
          {top.map((m) => {
            const answers = replies.get(m.id) ?? [];
            const running = pending.get(m.id) ?? [];
            return (
              <Fragment key={m.id}>
                {reading.divider === m.id && newLine}
                <li className="message-group">
                  <MessageRow message={m} flash={reading.flashId === m.id} />
                  {(answers.length > 0 || running.length > 0) && (
                    <ul className="anchored" aria-label={`Respostas a ${m.author.displayName}`}>
                      {answers.map((r) => (
                        <Fragment key={r.id}>
                          {reading.divider === r.id && newLine}
                          <li>
                            <MessageRow message={r} flash={reading.flashId === r.id} />
                          </li>
                        </Fragment>
                      ))}
                      {running.map((e) => (
                        <li key={e.id}>
                          <Progress execution={e} now={now} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
        {up.length > 0 && (
          <button type="button" className="pill up" onClick={() => reading.jump(up[up.length - 1]!.id)}>
            {upLabel(up, me, find)}
          </button>
        )}
        {down.length > 0 && (
          <button type="button" className="pill down" onClick={() => reading.jump(down[0]!.id)}>
            {downLabel(down)}
          </button>
        )}
      </div>
      <form className="composer" onSubmit={send}>
        {sendError && (
          <p className="error" role="alert">
            A mensagem não foi enviada. Tente de novo.
          </p>
        )}
        <textarea
          aria-label={`Mensagem para ${label}`}
          placeholder={`Mensagem para ${label}`}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          Enviar
        </button>
      </form>
    </>
  );
}

function MessageRow({ message: m, flash }: { message: MessageDto; flash?: boolean }) {
  const agent = m.author.kind === "agent";
  return (
    <article
      className={agent ? "message agent" : "message"}
      aria-label={`Mensagem de ${m.author.displayName}`}
      data-message-id={m.id}
      data-flash={flash ? "true" : undefined}
    >
      <Avatar name={m.author.displayName} agent={agent} photo={m.author.kind === "agent" ? m.author.photo : null} />
      <div>
        <div className="meta">
          <strong>{m.author.displayName}</strong>
          <time dateTime={m.createdAt}>{time.format(new Date(m.createdAt))}</time>
        </div>
        <p className="body">{m.body}</p>
      </div>
    </article>
  );
}

/**
 * O Andamento no lugar onde a resposta vai entrar: a bolha "escrevendo · 0:05", a falha com o
 * motivo, ou "Agentes não agem". ("Tentar de novo" e o push são do #24.)
 */
function Progress({ execution: e, now }: { execution: ExecutionDto; now: number }) {
  const name = e.agent.displayName;
  if (e.state === "failed") {
    return (
      <div className="message agent">
        <Avatar name={name} agent photo={e.agent.photo} />
        <div className="failcard">
          <strong>{name}</strong>
          <p className="why">
            {name} não respondeu: {e.reason ?? "erro desconhecido"}.
          </p>
        </div>
      </div>
    );
  }
  if (e.state === "not_acting") {
    return <p className="blocked">Agentes não agem: {e.reason}</p>;
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
          <span className="dots">escrevendo</span>
          {retry} · {elapsed(e.since, now)}
        </p>
      </div>
    </div>
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
