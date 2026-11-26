import { formatBytes, type WikiDto, type WikiSourceDto } from "@shearim/contracts";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from "react";
import { messageOf } from "../api";
import { dateTimeShort } from "../format";
import { useServerEvents } from "../live";
import { wikiApi } from "./api";

const PENDING_TEXT = { new: "nova", removal: "a remover" } as const;

/** "nunca sincronizada" ou a versão atual, com a data. */
function syncText(w: WikiDto) {
  if (!w.currentVersion) return "nunca sincronizada";
  return `versão ${w.currentVersion.number}, sincronizada em ${dateTimeShort(w.currentVersion.publishedAt)}`;
}

function pendingText(n: number) {
  if (n === 0) return "nada pendente";
  return n === 1 ? "1 Fonte pendente" : `${n} Fontes pendentes`;
}

/**
 * Só para o Admin: as Wikis do Workspace (spec #74, #78). O Admin vê todas, mesmo as restritas,
 * cria uma Wiki e sobe as Fontes dela (`.txt` e `.md`). As pendências dizem o que a próxima
 * Sincronização vai levar.
 */
export function WikisSettings() {
  const [wikis, setWikis] = useState<WikiDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    wikiApi.adminList().then(
      (list) => {
        setLoadError(false);
        setWikis(list);
      },
      () => setLoadError(true),
    );
  }, []);
  useEffect(load, [load]);
  useServerEvents((event) => {
    if (event.type === "ready") load();
  });

  return (
    <main className="settings">
      <h1 className="channel-name">Wikis</h1>
      <p className="hint">
        Uma Wiki é um conjunto de páginas que a Sincronização mantém a partir das Fontes que você sobe (texto ou
        markdown, como um curso transcrito). Uma Fonte não muda depois de subir.
      </p>
      {loadError && (
        <p className="error" role="alert">
          Não foi possível carregar as Wikis. Recarregue a página.
        </p>
      )}
      {wikis === null && !loadError && <p className="hint">Carregando…</p>}
      {wikis && wikis.length === 0 && <p className="hint">Nenhuma Wiki ainda.</p>}
      <ul className="agent-list" aria-label="Wikis">
        {wikis?.map((w) => (
          <li key={w.id} className="settings-row" aria-label={`Wiki ${w.name}`}>
            <div className="meta">
              <strong>{w.name}</strong>
              <span className="tag">{w.scope === "public" ? "pública" : "restrita"}</span>
              <span className="hint">{syncText(w)}</span>
              <span className="hint">{pendingText(w.pending)}</span>
              <button
                type="button"
                className="link"
                aria-expanded={w.id === openId}
                onClick={() => setOpenId(w.id === openId ? null : w.id)}
              >
                {w.id === openId ? "Fechar" : "Fontes"}
              </button>
            </div>
            <p className="hint">{w.description}</p>
            {w.id === openId && <WikiSources wiki={w} onChanged={load} />}
          </li>
        ))}
      </ul>
      <NewWiki
        onCreated={(w) => {
          setWikis((list) => [...(list ?? []), w].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
          setOpenId(w.id);
        }}
      />
    </main>
  );
}

/** As Fontes de uma Wiki, com a pendência de cada uma, e a subida de outras. */
function WikiSources({ wiki, onChanged }: { wiki: WikiDto; onChanged(): void }) {
  const [sources, setSources] = useState<WikiSourceDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    wikiApi.sources(wiki.id).then(setSources, () => setLoadError(true));
  }, [wiki.id]);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = [...(input.files ?? [])];
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const added = await wikiApi.upload(wiki.id, files);
      setSources((list) => [...(list ?? []), ...added]);
      setDone(added.length === 1 ? "1 Fonte subiu." : `${added.length} Fontes subiram.`);
      onChanged();
    } catch (err) {
      setError(messageOf(err, "As Fontes não subiram. Tente de novo."));
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  return (
    <section aria-label={`Fontes de ${wiki.name}`}>
      {loadError && (
        <p className="error" role="alert">
          Não foi possível carregar as Fontes.
        </p>
      )}
      {sources && sources.length === 0 && <p className="hint">Nenhuma Fonte ainda.</p>}
      <ul aria-label={`Fontes da Wiki ${wiki.name}`}>
        {sources?.map((s) => (
          <li key={s.id} className="hint">
            <strong>{s.fileName}</strong> · {formatBytes(s.sizeBytes)} · {s.uploadedBy.name},{" "}
            {dateTimeShort(s.uploadedAt)}
            {s.state === "removed" && <span className="tag">removida</span>}
            {s.pending && <span className="tag">{PENDING_TEXT[s.pending]}</span>}
          </li>
        ))}
      </ul>
      <label className="row">
        Subir Fontes (.txt ou .md)
        <input type="file" multiple accept=".txt,.md" disabled={busy} onChange={upload} />
      </label>
      {done && (
        <span className="hint" role="status">
          {done}
        </span>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}

function NewWiki({ onCreated }: { onCreated(w: WikiDto): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await wikiApi.create({ name, description }));
      setName("");
      setDescription("");
    } catch (err) {
      setError(messageOf(err, "A Wiki não foi criada. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-row" onSubmit={submit} aria-label="Criar Wiki">
      <h2>Criar Wiki</h2>
      <input
        aria-label="Nome da Wiki"
        placeholder="Ex.: Curso de Redes Sociais"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        aria-label="Descrição da Wiki"
        placeholder="O que a Wiki cobre: os Agentes leem isto para saber quando consultá-la."
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="row">
        <button type="submit" disabled={busy || !name.trim() || !description.trim()}>
          Criar
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
