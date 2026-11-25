import {
  AGENT_MODELS,
  type AgentDto,
  type AgentGitHubDto,
  type AgentModel,
  type AgentToolDto,
  type ToolOrigin,
  type WorkspaceKeyDto,
} from "@shearim/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { agentToolsText } from "./agent-tools";
import { api, messageOf } from "./api";
import { dateTimeShort } from "./format";
import { INCIDENT_TEXT, usd } from "./KeyBanners";
import { useDropDeletedAgents, useServerEvents } from "./live";

const MODEL_LABEL: Record<AgentModel, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};

/** O orçamento no campo do formulário: vazio é sem teto. */
const budgetField = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
/** O campo do formulário para o orçamento: vazio é nulo (sem teto); `undefined` se não é um valor válido. */
function budgetInput(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
const BUDGET_INVALID = "O orçamento mensal é um valor em dólares, zero ou mais (vazio: sem teto).";

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
  useServerEvents((event) => {
    if (event.type === "key_incident.updated") setStatus((s) => s && { ...s, incident: event.incident });
  });

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
              ? `Chave gravada${status.updatedAt ? ` em ${dateTimeShort(status.updatedAt)}` : ""}.`
              : "Nenhuma Chave gravada."}
        </p>
        {status?.incident && (
          <p className="error" role="alert">
            {INCIDENT_TEXT[status.incident.kind].title}. {INCIDENT_TEXT[status.incident.kind].whatToDo} A faixa some na
            primeira resposta que a Chave pagar.
          </p>
        )}
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
  useDropDeletedAgents(setAgents);
  // O gasto na Chave anda a cada resposta que ela paga.
  useServerEvents((event) => {
    if (event.type !== "agent_budget.updated") return;
    const { agentId, monthlyBudgetUsd, keySpendUsd, overBudget } = event.budget;
    setAgents(
      (list) => list?.map((a) => (a.id === agentId ? { ...a, monthlyBudgetUsd, keySpendUsd, overBudget } : a)) ?? null,
    );
  });

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
 * Um Agente da lista, com "Editar". Da Articuladora (`builtin`), a descrição e as instruções são
 * do Shearim; o resto, inclusive a Memória ligada, o Admin muda.
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
        <p className="hint">{agentToolsText(a)}</p>
        <p className="hint">{a.memoryEnabled ? "Memória ligada" : "Memória desligada: não guarda nem lê"}</p>
        <p className={a.overBudget ? "error" : "hint"}>
          Gasto na Chave este mês: {usd.format(a.keySpendUsd ?? 0)}
          {a.monthlyBudgetUsd === null || a.monthlyBudgetUsd === undefined
            ? " · sem orçamento"
            : ` de ${usd.format(a.monthlyBudgetUsd)}${a.overBudget ? " · estourado: não usa a Chave até o mês virar" : ""}`}
        </p>
        {editing && (
          <>
            <EditAgent
              agent={a}
              onSaved={(changed) => {
                onChanged(changed);
                setEditing(false);
              }}
            />
            <AgentTools
              agent={a}
              onChanged={async () => {
                // As Ferramentas e a linha de alcance ("acessa CRM com…") como o servidor as diz.
                const fresh = (await api.agents().catch(() => [])).find((x) => x.id === a.id);
                if (fresh) onChanged(fresh);
              }}
            />
            <AgentGitHub agent={a} onChanged={(repos) => onChanged({ ...a, githubRepositories: repos })} />
          </>
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
  const [budget, setBudget] = useState(budgetField(agent.monthlyBudgetUsd));
  const [memoryEnabled, setMemoryEnabled] = useState(agent.memoryEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const monthlyBudgetUsd = budgetInput(budget);
    if (monthlyBudgetUsd === undefined) return setError(BUDGET_INVALID);
    setBusy(true);
    setError(null);
    try {
      const own = agent.builtin ? {} : { description, instructions };
      onSaved(await api.updateAgent(agent.id, { name, photo, model, monthlyBudgetUsd, memoryEnabled, ...own }));
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
      <BudgetField value={budget} onChange={setBudget} />
      <label className="hint">
        <input type="checkbox" checked={memoryEnabled} onChange={(e) => setMemoryEnabled(e.target.checked)} /> Memória
        ligada
        <br />
        <small>
          Desligada, o Agente não guarda nem lê a Memória. O que ele já guardou continua na conversa para os outros
          Agentes.
        </small>
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

const ORIGIN_LABEL: Record<Exclude<ToolOrigin, "connector">, string> = {
  workspace: "Do Workspace",
  web: "Da web",
  github: "Do GitHub",
};

/** O grupo de uma Ferramenta na tela do Agente: a origem, e cada Conector no seu. */
const groupOf = (t: AgentToolDto) => (t.connector ? `connector:${t.connector.id}` : t.origin);
function groupLabel(t: AgentToolDto) {
  if (!t.connector) return ORIGIN_LABEL[t.origin as Exclude<ToolOrigin, "connector">];
  const whose = t.connector.credential === "member" ? "credencial de cada Membro" : "credencial do Workspace";
  return `Do Conector ${t.connector.name} (${whose})`;
}

/**
 * As Ferramentas do Agente, agrupadas por origem, cada uma marcada como leitura ou escrita (toda
 * escrita passa por um Pedido de aprovação). Conceder ou retirar vale na hora, sem "Salvar".
 */
function AgentTools({ agent, onChanged }: { agent: AgentDto; onChanged(tools: AgentToolDto[]): void }) {
  const [tools, setTools] = useState<AgentToolDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agentTools(agent.id).then(setTools, () => setError("Não foi possível carregar as Ferramentas."));
  }, [agent.id]);

  async function toggle(tool: AgentToolDto) {
    setBusy(tool.id);
    setError(null);
    try {
      const next = await api.setAgentTool(agent.id, tool.id, !tool.granted);
      setTools(next);
      onChanged(next);
    } catch (err) {
      setError(
        messageOf(err, `A Ferramenta ${tool.title} não foi ${tool.granted ? "retirada" : "concedida"}. Tente de novo.`),
      );
    } finally {
      setBusy(null);
    }
  }

  const groups = [...new Map(tools?.map((t) => [groupOf(t), t])).entries()];
  return (
    <fieldset className="settings-row" aria-label={`Ferramentas de ${agent.name}`}>
      <legend>Ferramentas</legend>
      {tools === null && !error && <p className="hint">Carregando…</p>}
      {groups.map(([group, first]) => (
        <div key={group}>
          <p className="hint">{groupLabel(first)}</p>
          {tools
            ?.filter((t) => groupOf(t) === group)
            .map((t) => (
              <label key={t.id} className="hint">
                <input type="checkbox" checked={t.granted} disabled={busy !== null} onChange={() => toggle(t)} />{" "}
                {t.title} <span className="tag">{t.access === "read" ? "leitura" : "escrita"}</span>
                <br />
                <small>{t.description}</small>
              </label>
            ))}
        </div>
      ))}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

/**
 * Os repositórios do GitHub do Agente (#58): todos os que a instalação alcança (sem lista) ou só
 * os escolhidos entre eles. Vale a partir do "Salvar"; uma lista vazia não existe.
 */
function AgentGitHub({ agent, onChanged }: { agent: AgentDto; onChanged(repositories: string[] | null): void }) {
  const [state, setState] = useState<AgentGitHubDto | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.agentGitHub(agent.id).then(
      (got) => {
        setState(got);
        setDraft(got.repositories);
      },
      () => setError("Não foi possível carregar os repositórios do GitHub."),
    );
  }, [agent.id]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const got = await api.setAgentGitHub(agent.id, draft);
      setState(got);
      setDraft(got.repositories);
      setSaved(true);
      onChanged(got.repositories);
    } catch (err) {
      setError(messageOf(err, "A lista de repositórios não foi salva. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (repo: string) =>
    setDraft((d) => (d?.includes(repo) ? d.filter((r) => r !== repo) : [...(d ?? []), repo]));
  // Os da lista que a instalação não alcança mais continuam à vista, para o Admin tirá-los.
  const options = state ? [...new Set([...state.available, ...(state.repositories ?? [])])] : [];
  const choosable = state !== null && (state.available.length > 0 || state.repositories !== null);
  const unchanged = JSON.stringify(draft) === JSON.stringify(state?.repositories ?? null);

  return (
    <fieldset className="settings-row" aria-label={`Repositórios do GitHub de ${agent.name}`}>
      <legend>Repositórios do GitHub</legend>
      {state === null && !error && <p className="hint">Carregando…</p>}
      {state?.failure && (
        <p className="notice" role="status">
          Não deu para ver os repositórios que a instalação do GitHub alcança: {state.failure}.
        </p>
      )}
      {choosable && (
        <>
          <label className="hint">
            <input
              type="radio"
              name={`github-${agent.id}`}
              checked={draft === null}
              disabled={busy}
              onChange={() => setDraft(null)}
            />{" "}
            Todos os que a instalação do GitHub alcança
          </label>
          <label className="hint">
            <input
              type="radio"
              name={`github-${agent.id}`}
              checked={draft !== null}
              disabled={busy}
              onChange={() => setDraft(state?.repositories ?? [])}
            />{" "}
            Só estes:
          </label>
          {draft !== null &&
            options.map((repo) => (
              <label key={repo} className="hint">
                <input type="checkbox" checked={draft.includes(repo)} disabled={busy} onChange={() => toggle(repo)} />{" "}
                {repo}
                {!state?.available.includes(repo) && <span className="tag">fora da instalação</span>}
              </label>
            ))}
          {draft !== null && draft.length === 0 && (
            <p className="hint">Escolha ao menos um repositório, ou deixe o Agente alcançar todos.</p>
          )}
          <div className="row">
            <button type="button" disabled={busy || unchanged || (draft !== null && draft.length === 0)} onClick={save}>
              Salvar repositórios
            </button>
            {saved && unchanged && <span className="hint">Salvo.</span>}
          </div>
        </>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

/** O orçamento mensal do Agente na Chave, em dólares: vazio é sem teto. */
function BudgetField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label className="hint">
      Orçamento mensal na Chave (US$){" "}
      <input
        aria-label="Orçamento mensal na Chave"
        inputMode="decimal"
        placeholder="sem teto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
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
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const monthlyBudgetUsd = budgetInput(budget);
    if (monthlyBudgetUsd === undefined) return setError(BUDGET_INVALID);
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createAgent({ name, photo, description, instructions, model, monthlyBudgetUsd }));
      setName("");
      setBudget("");
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
      <BudgetField value={budget} onChange={setBudget} />
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
