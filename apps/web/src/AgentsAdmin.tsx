import { AGENT_MODELS, type AgentDto, type AgentModel, type WorkspaceKeyDto } from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { ApiFailure, api } from "./api";

const MODEL_LABEL: Record<AgentModel, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function messageOf(err: unknown, fallback: string) {
  const body = err instanceof ApiFailure ? err.body : null;
  return body && "message" in body ? body.message : fallback;
}

/** Só para o Admin: a Chave do Workspace. Ela é gravada daqui e nunca mais aparece. */
export function WorkspaceKeySettings() {
  const [status, setStatus] = useState<WorkspaceKeyDto | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  useEffect(() => {
    api.workspaceKey().then(setStatus, () => setState({ kind: "error", message: "Não foi possível carregar." }));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setState({ kind: "saving" });
    try {
      setStatus(await api.setWorkspaceKey(draft));
      setDraft("");
      setState({ kind: "saved" });
    } catch (err) {
      setState({ kind: "error", message: messageOf(err, "A Chave não foi gravada. Tente de novo.") });
    }
  }

  return (
    <main className="settings">
      <h1 className="channel-name">Chave do Workspace</h1>
      <p className="hint">
        Uma chave da API da Anthropic, opcional. Paga as respostas dos Agentes para quem não tem Conta ligada. Fica
        guardada cifrada e não volta a aparecer aqui.
      </p>
      <form className="settings-row" onSubmit={save} aria-label="Chave do Workspace">
        <p className="hint" role="status">
          {status === null
            ? "Carregando…"
            : status.configured
              ? `Chave gravada${status.updatedAt ? ` em ${dateTime.format(new Date(status.updatedAt))}` : ""}.`
              : "Nenhuma Chave gravada."}
        </p>
        <input
          type="password"
          aria-label="Chave da API"
          placeholder={status?.configured ? "Colar uma Chave nova" : "sk-ant-…"}
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={state.kind === "saving" || !draft.trim()}>
            Gravar Chave
          </button>
          {state.kind === "saved" && <span className="hint">Gravada.</span>}
          {state.kind === "error" && (
            <span className="error" role="alert">
              {state.message}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}

/** Só para o Admin: os Agentes do Workspace e o formulário de Agente novo. */
export function AgentsSettings() {
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api.agents().then(setAgents, () => setLoadError(true));
  }, []);

  return (
    <main className="settings">
      <h1 className="channel-name">Agentes</h1>
      <p className="hint">
        Todo Membro vê o nome, a foto e a descrição de um Agente. As instruções dizem como ele age e só o Admin as vê.
        Para chamar um Agente num Canal, escreva @ e o identificador dele (o mesmo espaço de nomes das pessoas).
      </p>
      {loadError && <p className="notice">Não foi possível carregar os Agentes. Recarregue a página.</p>}
      <ul className="agent-list" aria-label="Agentes do Workspace">
        {agents?.map((a) => (
          <AgentItem
            key={a.id}
            agent={a}
            onChanged={(changed) => setAgents((list) => list?.map((x) => (x.id === changed.id ? changed : x)) ?? null)}
          />
        ))}
      </ul>
      <NewAgent onCreated={(a) => setAgents((list) => [...(list ?? []), a])} />
    </main>
  );
}

/**
 * Um Agente da lista, com "Editar". A Articuladora (`builtin`) muda só o nome, a foto e o modelo:
 * a descrição e as instruções dela são do Shearim.
 */
function AgentItem({ agent: a, onChanged }: { agent: AgentDto; onChanged(agent: AgentDto): void }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="message">
      <Avatar name={a.name} agent photo={a.photo} />
      <div>
        <div className="meta">
          <strong>{a.name}</strong>
          <span className="handle">@{a.handle}</span>
          <span className="hint">{MODEL_LABEL[a.model] ?? a.model}</span>
          {a.builtin && <span className="tag">Articuladora</span>}
          <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
            {editing ? "Fechar" : "Editar"}
          </button>
        </div>
        <p className="body">{a.description || "Sem descrição."}</p>
        {editing && (
          <EditAgent
            agent={a}
            onSaved={(changed) => {
              onChanged(changed);
              setEditing(false);
            }}
          />
        )}
      </div>
    </li>
  );
}

function EditAgent({ agent, onSaved }: { agent: AgentDto; onSaved(agent: AgentDto): void }) {
  const [name, setName] = useState(agent.name);
  const [photo, setPhoto] = useState<string | null>(agent.photo);
  const [description, setDescription] = useState(agent.description);
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [model, setModel] = useState<AgentModel>(agent.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const own = agent.builtin ? {} : { description, instructions };
      onSaved(await api.updateAgent(agent.id, { name, photo, model, ...own }));
    } catch (err) {
      setError(messageOf(err, "O Agente não foi salvo. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label={`Editar ${agent.name}`}>
      <input aria-label="Nome do Agente" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="hint">
        Foto{" "}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => readPhoto(e.target.files?.[0], setPhoto)}
        />
      </label>
      {agent.builtin ? (
        <p className="hint">
          A descrição, as instruções e o jeito de decidir quem responde da Articuladora são do Shearim.
        </p>
      ) : (
        <>
          <input aria-label="Descrição pública" value={description} onChange={(e) => setDescription(e.target.value)} />
          <textarea
            aria-label="Instruções do Agente"
            rows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </>
      )}
      <label className="hint">
        Modelo{" "}
        <select aria-label="Modelo" value={model} onChange={(e) => setModel(e.target.value as AgentModel)}>
          {AGENT_MODELS.map((m) => (
            <option key={m} value={m}>
              {MODEL_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          Salvar
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/** Lê a foto escolhida como `data:` URL (sem arquivo, fica sem foto). */
function readPhoto(file: File | undefined, set: (photo: string | null) => void) {
  if (!file) return set(null);
  const reader = new FileReader();
  reader.onload = () => set(typeof reader.result === "string" ? reader.result : null);
  reader.readAsDataURL(file);
}

function NewAgent({ onCreated }: { onCreated(agent: AgentDto): void }) {
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState<AgentModel>("claude-sonnet-5-5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createAgent({ name, photo, description, instructions, model }));
      setName("");
      setPhoto(null);
      setDescription("");
      setInstructions("");
    } catch (err) {
      setError(messageOf(err, "O Agente não foi criado. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label="Agente novo">
      <h2>Agente novo</h2>
      <input aria-label="Nome do Agente" placeholder="Faro" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="hint">
        Foto{" "}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => readPhoto(e.target.files?.[0], setPhoto)}
        />
      </label>
      <input
        aria-label="Descrição pública"
        placeholder="Para que ele serve (todos veem)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        aria-label="Instruções do Agente"
        placeholder="Como ele age (só o Admin vê)"
        rows={4}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <label className="hint">
        Modelo{" "}
        <select aria-label="Modelo" value={model} onChange={(e) => setModel(e.target.value as AgentModel)}>
          {AGENT_MODELS.map((m) => (
            <option key={m} value={m}>
              {MODEL_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          Criar Agente
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
