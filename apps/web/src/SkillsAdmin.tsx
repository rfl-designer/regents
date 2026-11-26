import {
  type ImportSkillResultDto,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  type SkillDto,
} from "@regents/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { dateTimeShort } from "./format";

/**
 * Só para o Admin: as Habilidades do Workspace (spec #74). Escrever uma (nome, descrição que diz
 * quando usar e corpo em markdown), editar, apagar e ver em quais Agentes cada uma está ativa. A
 * ativação é na tela de cada Agente.
 */
export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.skills().then(setSkills, () => setError("Não foi possível carregar as Habilidades. Recarregue a página."));
  }, []);

  const sorted = (list: SkillDto[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <main className="settings">
      <h1 className="channel-name">Habilidades</h1>
      <p className="hint">
        Procedimentos escritos pelo time: como fazer cada tarefa. O Agente vê só o nome e a descrição das Habilidades
        ativas nele e carrega o texto inteiro quando a tarefa pede. Ative cada uma na tela do Agente, em Agentes.
      </p>
      <SkillForm
        label="Escrever Habilidade"
        submit="Criar Habilidade"
        onSave={async (input) => {
          const created = await api.createSkill(input);
          setSkills((list) => sorted([...(list ?? []), created]));
        }}
      />
      <ImportSkill onImported={(created) => setSkills((list) => sorted([...(list ?? []), created]))} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {skills === null && !error && <p className="hint">Carregando…</p>}
      {skills?.length === 0 && <p className="hint">Nenhuma Habilidade ainda.</p>}
      <ul className="messages" aria-label="Habilidades">
        {skills?.map((s) => (
          <SkillItem
            key={s.id}
            skill={s}
            onChanged={(changed) => setSkills((list) => sorted((list ?? []).map((x) => (x.id === s.id ? changed : x))))}
            onDeleted={() => setSkills((list) => (list ?? []).filter((x) => x.id !== s.id))}
          />
        ))}
      </ul>
    </main>
  );
}

function SkillItem(props: { skill: SkillDto; onChanged(skill: SkillDto): void; onDeleted(): void }) {
  const { skill: s } = props;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const where = s.agents.length ? ` Ela sai na hora de ${s.agents.map((a) => a.name).join(", ")}.` : "";
    if (!confirm(`Apagar a Habilidade ${s.name}?${where}`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSkill(s.id);
      props.onDeleted();
    } catch (err) {
      setError(messageOf(err, "A Habilidade não foi apagada. Tente de novo."));
      setBusy(false);
    }
  }

  return (
    <li className="message">
      <div>
        <div className="meta">
          <strong>{s.name}</strong>
          {s.origin === "imported" && <span className="tag">importada</span>}
          <span className="hint">editada em {dateTimeShort(s.updatedAt)}</span>
          <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
            {editing ? "Fechar" : "Editar"}
          </button>
          <button type="button" className="link" disabled={busy} onClick={remove}>
            Apagar
          </button>
        </div>
        <p className="body">{s.description}</p>
        <p className="hint">
          {s.agents.length ? `Ativa em: ${s.agents.map((a) => a.name).join(", ")}` : "Não está ativa em nenhum Agente."}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <SkillForm
            label={`Editar ${s.name}`}
            submit="Salvar"
            initial={s}
            onSave={async (input) => {
              props.onChanged(await api.updateSkill(s.id, input));
              setEditing(false);
            }}
          />
        )}
      </div>
    </li>
  );
}

/** O que o Admin escolheu para importar: um arquivo (`SKILL.md` ou `.zip`) ou a pasta da skill. */
type Picked = { kind: "file"; file: File } | { kind: "folder"; files: File[] };

/**
 * Importar um `SKILL.md`, o `.zip` da skill ou a pasta dela: o nome e a descrição saem do
 * frontmatter. Do `.zip` e da pasta, a tela lista o que ficou de fora, porque os Agentes do Shearim
 * não executam código.
 */
function ImportSkill(props: { onImported(skill: SkillDto): void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSkillResultDto | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked || busy) return;
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const imported =
        picked.kind === "file" ? await api.importSkill(picked.file) : await api.importSkillFolder(picked.files);
      props.onImported(imported.skill);
      setResult(imported);
      setPicked(null);
      form.reset();
    } catch (err) {
      setError(messageOf(err, "A Habilidade não foi importada. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label="Importar SKILL.md">
      <p className="hint">
        Ou importe a Habilidade de um SKILL.md, de um .zip ou de uma pasta com ele: o nome e a descrição saem do
        frontmatter. Scripts e outros arquivos ficam de fora, porque os Agentes do Shearim não executam código.
      </p>
      <div className="row">
        <input
          type="file"
          aria-label="Arquivo SKILL.md ou .zip"
          accept=".md,.zip,text/markdown,application/zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setPicked(file ? { kind: "file", file } : null);
          }}
        />
        <input
          type="file"
          aria-label="Pasta com o SKILL.md"
          {...{ webkitdirectory: "" }}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            setPicked(files.length ? { kind: "folder", files } : null);
          }}
        />
        <button type="submit" disabled={busy || !picked}>
          Importar
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
      {result && (
        <div role="status">
          <p className="hint">Habilidade {result.skill.name} importada.</p>
          {result.ignored.length > 0 && (
            <>
              <p className="hint">Ficaram de fora (os Agentes do Shearim não executam código):</p>
              <ul className="micro" aria-label="Arquivos ignorados">
                {result.ignored.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </form>
  );
}

/** O formulário de escrever ou editar: o nome, a descrição (quando usar) e o corpo em markdown. */
function SkillForm(props: {
  label: string;
  submit: string;
  initial?: Pick<SkillDto, "name" | "description" | "body">;
  onSave(input: { name: string; description: string; body: string }): Promise<void>;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [description, setDescription] = useState(props.initial?.description ?? "");
  const [body, setBody] = useState(props.initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() && description.trim() && body.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ name, description, body });
      if (!props.initial) {
        setName("");
        setDescription("");
        setBody("");
      }
    } catch (err) {
      setError(messageOf(err, "A Habilidade não foi salva. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label={props.label}>
      <input
        aria-label="Nome da Habilidade"
        placeholder="Nome (ex.: Criar carrossel)"
        maxLength={SKILL_NAME_MAX}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="Descrição da Habilidade"
        placeholder="Quando usar (ex.: quando pedirem um carrossel para o Instagram)"
        maxLength={SKILL_DESCRIPTION_MAX}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        aria-label="Corpo da Habilidade"
        placeholder="O procedimento, em markdown."
        rows={8}
        maxLength={SKILL_BODY_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row">
        <button type="submit" disabled={busy || !ready}>
          {props.submit}
        </button>
        {!description.trim() && name.trim() && (
          <span className="hint">A descrição diz quando usar: é obrigatória.</span>
        )}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
