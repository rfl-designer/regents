import type { ChannelDto, MeDto, MemberSummaryDto, MessageDto } from "@shearim/contracts";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useServerEvents } from "./live";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Junta o que se tem com o que chegou, sem repetir: a mensagem enviada chega pelo 201 e pelo WebSocket. */
function append(prev: MessageDto[] | null, arrived: MessageDto[]) {
  const have = new Set(prev?.map((m) => m.id));
  return [...(prev ?? []), ...arrived.filter((m) => !have.has(m.id))];
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
 */
export function Conversation({
  conversationId,
  label,
  onSent,
}: {
  conversationId: string;
  label: string;
  onSent?(): void;
}) {
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A lista do servidor manda; o que chegou pelo WebSocket depois dela fica no fim.
  const load = useCallback(() => {
    api.messages(conversationId).then(
      (list) => {
        setLoadError(false);
        setMessages((prev) => append(list, prev ?? []));
      },
      () => setLoadError(true),
    );
  }, [conversationId]);

  useEffect(load, [load]);

  useServerEvents((event) => {
    // Cada (re)conexão começa com `ready`: recarrega o que pode ter passado enquanto ela não estava aberta.
    if (event.type === "ready") load();
    if (event.type === "message.created" && event.message.channelId === conversationId) {
      setMessages((prev) => append(prev, [event.message]));
    }
  });

  // Rola até o fim depois de carregar ou enviar (o fim acompanha quando já se está nele).
  const count = messages?.length ?? 0;
  useEffect(() => {
    if (count) endRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(false);
    try {
      const msg = await api.send(conversationId, { body: draft });
      onSent?.();
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

  return (
    <>
      <ol className="messages" aria-label={`Mensagens de ${label}`} aria-busy={messages === null && !loadError}>
        {loadError && <li className="notice">Não foi possível carregar as mensagens. Recarregue a página.</li>}
        {messages?.length === 0 && <li className="notice">Nenhuma mensagem ainda. Diga oi!</li>}
        {messages?.map((m) => (
          <li key={m.id} className="message">
            <div className="avatar" aria-hidden>
              {m.author.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="meta">
                <strong>{m.author.displayName}</strong>
                <time dateTime={m.createdAt}>{time.format(new Date(m.createdAt))}</time>
              </div>
              <p className="body">{m.body}</p>
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
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

function ChannelHeader({ channel, joined, onChanged }: Omit<Props, "me"> & { joined: boolean }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = channel.participants.map((p) => p.displayName).join(", ");

  async function act(run: () => Promise<ChannelDto>) {
    setError(null);
    try {
      onChanged(await run());
      setAdding(false);
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
          <button type="button" className="link" onClick={() => setAdding((v) => !v)}>
            Adicionar pessoa
          </button>
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
      {adding && (
        <AddPerson
          channel={channel}
          onAdd={(memberId) => act(() => api.addParticipant(channel.id, memberId))}
          onCancel={() => setAdding(false)}
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

  const inside = new Set(channel.participants.map((p) => p.id));
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
