import type { AgentDto, ChannelDto, DmDto, MeDto, MemberSummaryDto, UnreadDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, api } from "./api";
import { dmTitle } from "./DmView";

interface Props {
  me: MeDto;
  channels: ChannelDto[];
  dms: DmDto[];
  /** As não-lidas do Membro (`null` enquanto carrega). */
  unread: UnreadDto | null;
  /** A conversa aberta (Canal ou DM: os ids não se repetem entre os dois). */
  selectedId: string | null;
  isAdmin: boolean;
  /** Qual tela do Admin está aberta, se alguma. */
  adminView: AdminView | null;
  onOpen(id: string): void;
  onCreated(channel: ChannelDto): void;
  /** Uma DM foi aberta (nova ou a que já existia). */
  onDmOpened(dm: DmDto): void;
  onOpenAdmin(view: AdminView): void;
}

export type AdminView = "context" | "settings" | "agents" | "key" | "installation";

const ADMIN_LINKS: [AdminView, string][] = [
  ["context", "Contexto do Workspace"],
  ["settings", "Instruções dos Canais"],
  ["agents", "Agentes"],
  ["key", "Chave do Workspace"],
  ["installation", "Instalação"],
];

/** A lista de conversas: os Canais que o Membro vê e, numa seção à parte, as DMs dele. */
export function Sidebar(props: Props) {
  const [creating, setCreating] = useState(false);
  const count = (id: string, dm: boolean) => {
    const u = props.unread?.conversations.find((c) => c.conversationId === id);
    return u && <UnreadCount count={u.count} highlight={dm || u.mentions > 0} />;
  };
  const [openingDm, setOpeningDm] = useState(false);

  return (
    <nav className="sidebar" aria-label="Conversas">
      <h2>Canais</h2>
      <ul>
        {props.channels.map((c) => (
          <li key={c.id} className="conversation-item">
            <button
              type="button"
              className="conversation"
              aria-current={c.id === props.selectedId ? "page" : undefined}
              onClick={() => props.onOpen(c.id)}
            >
              # {c.name}
              {c.kind === "private" && (
                <>
                  {" "}
                  <span className="tag">privado</span>
                </>
              )}
            </button>
            {count(c.id, false)}
          </li>
        ))}
      </ul>
      {creating ? (
        <NewChannel
          onCancel={() => setCreating(false)}
          onCreated={(channel) => {
            setCreating(false);
            props.onCreated(channel);
          }}
        />
      ) : (
        <button type="button" className="link" onClick={() => setCreating(true)}>
          + Novo Canal
        </button>
      )}
      <h2>Mensagens diretas</h2>
      <ul aria-label="DMs">
        {props.dms.map((d) => (
          <li key={d.id} className="conversation-item">
            <button
              type="button"
              className="conversation"
              aria-current={d.id === props.selectedId ? "page" : undefined}
              onClick={() => props.onOpen(d.id)}
            >
              {dmTitle(d, props.me)}
            </button>
            {count(d.id, true)}
          </li>
        ))}
      </ul>
      {openingDm ? (
        <NewDm
          me={props.me}
          onCancel={() => setOpeningDm(false)}
          onOpened={(dm) => {
            setOpeningDm(false);
            props.onDmOpened(dm);
          }}
        />
      ) : (
        <button type="button" className="link" onClick={() => setOpeningDm(true)}>
          + Nova DM
        </button>
      )}
      {props.isAdmin &&
        ADMIN_LINKS.map(([view, label]) => (
          <button
            key={view}
            type="button"
            className="link"
            aria-current={props.adminView === view ? "page" : undefined}
            onClick={() => props.onOpenAdmin(view)}
          >
            {label}
          </button>
        ))}
    </nav>
  );
}

/**
 * Quantas não-lidas há na conversa. Fica fora do botão, para o nome dele continuar sendo o da
 * conversa; destacada quando há Menção ao Membro ou é DM.
 */
function UnreadCount({ count, highlight }: { count: number; highlight: boolean }) {
  if (count === 0) return null;
  return (
    <span className={highlight ? "unread-count highlight" : "unread-count"}>
      {count}
      <span className="sr-only">{count === 1 ? " não-lida" : " não-lidas"}</span>
    </span>
  );
}

function NewChannel({ onCancel, onCreated }: { onCancel(): void; onCreated(channel: ChannelDto): void }) {
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createChannel({ name, kind: isPrivate ? "private" : "public" }));
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setError(body && "message" in body ? body.message : "Não foi possível criar o Canal. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-channel" onSubmit={submit} aria-label="Novo Canal">
      <input
        aria-label="Nome do Canal"
        placeholder="nome-do-canal"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label>
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Privado: só quem
        participa vê
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          Criar
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * Escolher com quem conversar: uma pessoa abre uma DM; várias, uma DM em grupo.
 * Um Agente abre na hora a DM com ele (só você e ele).
 */
function NewDm({ me, onCancel, onOpened }: { me: MeDto; onCancel(): void; onOpened(dm: DmDto): void }) {
  const [members, setMembers] = useState<MemberSummaryDto[] | null>(null);
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.members().then(
      (list) => setMembers(list.filter((m) => m.id !== me.id)),
      () => setError("Não foi possível carregar os Membros. Tente de novo."),
    );
  }, [me.id]);

  useEffect(() => {
    api.agents().then(setAgents, () => setError("Não foi possível carregar os Agentes. Tente de novo."));
  }, []);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function open(request: () => Promise<DmDto>) {
    setBusy(true);
    setError(null);
    try {
      onOpened(await request());
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setError(body && "message" in body ? body.message : "Não foi possível abrir a DM. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen.size === 0 || busy) return;
    await open(() => api.openDm([...chosen]));
  }

  return (
    <form className="new-channel" onSubmit={submit} aria-label="Nova DM">
      {members?.length === 0 && <p className="hint">Ainda não há outras pessoas no Workspace.</p>}
      {members?.map((m) => (
        <label key={m.id}>
          <input type="checkbox" checked={chosen.has(m.id)} onChange={() => toggle(m.id)} /> {m.displayName}
        </label>
      ))}
      {agents && agents.length > 0 && <p className="hint">Ou converse com um Agente:</p>}
      {agents && agents.length > 0 && (
        <ul className="dm-agents" aria-label="Conversar com um Agente">
          {agents.map((a) => (
            <li key={a.id}>
              <button type="button" className="link" disabled={busy} onClick={() => open(() => api.openAgentDm(a.id))}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy || chosen.size === 0}>
          {chosen.size > 1 ? "Abrir DM em grupo" : "Abrir DM"}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
