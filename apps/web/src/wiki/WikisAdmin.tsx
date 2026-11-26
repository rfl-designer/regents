import {
  formatBytes,
  type WikiDto,
  type WikiPageRefDto,
  type WikiSourceDto,
  type WikiSyncDto,
  type WikiVersionDto,
  wikiSyncPayerText,
  wikiSyncStepText,
} from "@shearim/contracts";
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
    // O estado da Sincronização e a Wiki nova chegam em tempo real, sem recarregar a tela.
    if (event.type === "wiki_sync.updated") {
      const { sync } = event;
      setWikis((list) => list?.map((w) => (w.id === sync.wikiId ? { ...w, lastSync: sync } : w)) ?? list);
    }
    if (event.type === "wiki.updated") {
      setWikis((list) => list?.map((w) => (w.id === event.wiki.id ? event.wiki : w)) ?? list);
    }
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
            <WikiSync wiki={w} />
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

const open = (s: WikiSyncDto | null) => s?.state === "queued" || s?.state === "running";

/**
 * O estado da Sincronização para gente ler: o passo em curso, o fim ou o motivo da falha, com
 * "pela Chave do Workspace" quando a Chave paga.
 */
function syncStateText(s: WikiSyncDto) {
  const paid = wikiSyncPayerText(s);
  const text = stateText(s);
  return paid && s.state !== "failed" ? `${text} · ${paid}` : text;
}

function stateText(s: WikiSyncDto) {
  if (s.state === "queued") return "Sincronização pedida";
  if (s.state === "running") return `Sincronização ${s.step ? wikiSyncStepText(s.step) : "em curso"}`;
  if (s.state === "done") return `Sincronização concluída: versão ${s.version}`;
  if (s.state === "canceled") return "Sincronização cancelada";
  return `A Sincronização falhou: ${s.reason ?? "sem motivo"}`;
}

/**
 * "Sincronizar" e o estado da Sincronização, em tempo real. O botão diz quando não há nada
 * pendente e quando uma Sincronização já está em curso. Ao fim, o relatório e as versões.
 */
function WikiSync({ wiki }: { wiki: WikiDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = wiki.lastSync;
  const running = open(sync);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await wikiApi.sync(wiki.id);
    } catch (err) {
      setError(messageOf(err, "A Sincronização não começou. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  const label = running ? "Sincronização em curso" : wiki.pending === 0 ? "Nada a sincronizar" : "Sincronizar";
  return (
    <section aria-label={`Sincronização de ${wiki.name}`}>
      <div className="row">
        <button type="button" disabled={busy || running || wiki.pending === 0} onClick={start}>
          {label}
        </button>
        {sync && (
          <span className={sync.state === "failed" ? "error" : "hint"} role="status">
            {syncStateText(sync)}
          </span>
        )}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
      {sync?.state === "done" && sync.report && <SyncReport report={sync.report} />}
      {wiki.currentVersion && <WikiVersions wiki={wiki} />}
    </section>
  );
}

function pageList(pages: WikiPageRefDto[]) {
  return pages.map((p) => p.title).join(", ");
}

/** O relatório da última Sincronização: as páginas criadas, alteradas e removidas. */
function SyncReport({ report }: { report: NonNullable<WikiSyncDto["report"]> }) {
  const nothing = report.created.length + report.updated.length + report.removed.length === 0;
  return (
    <ul className="hint" aria-label="Relatório da Sincronização">
      {nothing && <li>Nenhuma página mudou.</li>}
      {report.created.length > 0 && <li>Páginas criadas: {pageList(report.created)}</li>}
      {report.updated.length > 0 && <li>Páginas alteradas: {pageList(report.updated)}</li>}
      {report.removed.length > 0 && <li>Páginas removidas: {pageList(report.removed)}</li>}
    </ul>
  );
}

/** As versões da Wiki, da mais nova para a mais velha, com a atual marcada. */
function WikiVersions({ wiki }: { wiki: WikiDto }) {
  const [versions, setVersions] = useState<WikiVersionDto[] | null>(null);
  const current = wiki.currentVersion?.number;
  useEffect(() => {
    // Relê quando a versão atual muda (uma Sincronização concluída).
    void current;
    wikiApi.versions(wiki.id).then(setVersions, () => setVersions(null));
  }, [wiki.id, current]);
  if (!versions?.length) return null;
  return (
    <ul className="hint" aria-label={`Versões de ${wiki.name}`}>
      {versions.map((v) => (
        <li key={v.number}>
          Versão {v.number} · {dateTimeShort(v.publishedAt)} · {v.startedBy.name}
          {v.current && <span className="tag">atual</span>}
        </li>
      ))}
    </ul>
  );
}

/** As Fontes de uma Wiki, com a pendência de cada uma, e a subida de outras. */
function WikiSources({ wiki, onChanged }: { wiki: WikiDto; onChanged(): void }) {
  const [sources, setSources] = useState<WikiSourceDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Uma versão nova muda as pendências: a lista se relê.
  const version = wiki.currentVersion?.number;
  useEffect(() => {
    void version;
    wikiApi.sources(wiki.id).then(setSources, () => setLoadError(true));
  }, [wiki.id, version]);

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
