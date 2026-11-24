import type { ChannelDto, MessageDto } from "@shearim/contracts";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function ChannelView({ channel }: { channel: ChannelDto }) {
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.messages(channel.id).then(setMessages, () => setLoadError(true));
  }, [channel.id]);

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
      const msg = await api.send(channel.id, { body: draft });
      setMessages((prev) => [...(prev ?? []), msg]);
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
    <main className="channel">
      <h1 className="channel-name"># {channel.name}</h1>
      <ol className="messages" aria-label={`Mensagens de #${channel.name}`}>
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
