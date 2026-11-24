import type { AgentDto, ChannelDto, ExecutionDto, MeDto, MemberSummaryDto, MessageDto } from "@shearim/contracts";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import { useServerEvents } from "./live";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** "Perto do fim": a tela acompanha o fim só quando a pessoa já está nele (Spec, Leitura). */
const NEAR_END_PX = 60;

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
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [executions, setExecutions] = useState<Record<string, ExecutionDto>>({});
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);

  // A lista do servidor manda; o que chegou pelo WebSocket depois dela fica no fim.
  const load = useCallback(() => {
    Promise.all([api.messages(channel.id), api.executions(channel.id)]).then(
      ([list, running]) => {
        setLoadError(false);
        setMessages((prev) => append(list, prev ?? []));
        setExecutions(Object.fromEntries(running.map((e) => [e.id, e])));
      },
      () => setLoadError(true),
    );
  }, [channel.id]);

  useEffect(load, [load]);

  useServerEvents((event) => {
    // Cada (re)conexão começa com `ready`: recarrega o que pode ter passado enquanto ela não estava aberta.
    if (event.type === "ready") load();
    if (event.type === "message.created" && event.message.channelId === channel.id) {
      setMessages((prev) => append(prev, [event.message]));
    }
    if (event.type === "execution.updated" && event.execution.channelId === channel.id) {
      setExecutions((prev) => upsertExecution(prev, event.execution));
    }
  });

  // Acompanha o fim só para quem já está nele: uma resposta ancorada lá em cima não puxa a tela.
  const count = (messages?.length ?? 0) + Object.keys(executions).length;
  useEffect(() => {
    const list = listRef.current;
    if (count && list && atEnd.current) list.scrollTop = list.scrollHeight;
  }, [count]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(false);
    try {
      const msg = await api.send(channel.id, { body: draft });
      // Escrever num Canal público é entrar nele; o `channel.updated` também chega, mas a tela não espera.
      if (!joined) api.channel(channel.id).then(onChanged, () => {});
      atEnd.current = true; // quem envia vai para o fim
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

  return (
    <main className="channel">
      <ChannelHeader channel={channel} joined={joined} onChanged={onChanged} />
      <ol
        ref={listRef}
        className="messages"
        aria-label={`Mensagens de #${channel.name}`}
        aria-busy={messages === null && !loadError}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
        }}
      >
        {loadError && <li className="notice">Não foi possível carregar as mensagens. Recarregue a página.</li>}
        {messages?.length === 0 && <li className="notice">Nenhuma mensagem ainda. Diga oi!</li>}
        {top.map((m) => {
          const answers = replies.get(m.id) ?? [];
          const running = pending.get(m.id) ?? [];
          return (
            <li key={m.id} className="message-group">
              <MessageRow message={m} />
              {(answers.length > 0 || running.length > 0) && (
                <ul className="anchored" aria-label={`Respostas a ${m.author.displayName}`}>
                  {answers.map((r) => (
                    <li key={r.id}>
                      <MessageRow message={r} />
                    </li>
                  ))}
                  {running.map((e) => (
                    <li key={e.id}>
                      <Progress execution={e} now={now} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <form className="composer" onSubmit={send}>
        {sendError && (
          <p className="error" role="alert">
            A mensagem não foi enviada. Tente de novo.
          </p>
        )}
        <textarea
          aria-label={`Mensagem para #${channel.name}`}
          placeholder={`Mensagem para #${channel.name}`}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          Enviar
        </button>
      </form>
    </main>
  );
}

function MessageRow({ message: m }: { message: MessageDto }) {
  const agent = m.author.kind === "agent";
  return (
    <article className={agent ? "message agent" : "message"} aria-label={`Mensagem de ${m.author.displayName}`}>
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
