import {
  WIKI_INDEX_SLUG,
  type WikiDto,
  type WikiLinkDto,
  type WikiPageViewDto,
  wikiBodyParts,
  wikiPagePath,
} from "@shearim/contracts";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiFailure, messageOf } from "../api";
import { dateTimeShort } from "../format";
import { useServerEvents } from "../live";
import { wikiApi } from "./api";

/**
 * As Wikis que o Membro lê, para a seção "Wikis" da barra lateral (#82). O servidor decide quais
 * (o alcance, ADR 0014): a cada Wiki que muda, a lista se relê.
 */
export function useReadableWikis(enabled: boolean) {
  const [wikis, setWikis] = useState<WikiDto[]>([]);
  const load = useCallback(() => {
    wikiApi.list().then(setWikis, () => {});
  }, []);
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);
  useServerEvents((event) => {
    if (event.type === "ready" || event.type === "wiki.updated") load();
  }, enabled);
  return wikis;
}

const syncing = (w: WikiDto) => w.lastSync?.state === "queued" || w.lastSync?.state === "running";

type Loaded = { kind: "loading" } | { kind: "ready"; view: WikiPageViewDto } | { kind: "missing"; message: string };

/**
 * A leitura de uma página da Wiki, para o Membro (#82): o índice ao abrir, os links `[[slug]]` para
 * as outras páginas (o quebrado fica marcado), as Fontes da página, a data da última
 * Sincronização e, durante uma, "sincronizando…" em tempo real. Ninguém edita.
 */
export function WikiReader({
  wikiId,
  slug,
  onNavigate,
}: {
  wikiId: string;
  slug: string;
  onNavigate(slug: string): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  const load = useCallback(() => {
    wikiApi.page(wikiId, slug).then(
      (view) => setLoaded({ kind: "ready", view }),
      (err) =>
        setLoaded({
          kind: "missing",
          message:
            err instanceof ApiFailure && err.status === 404
              ? messageOf(err, "Essa página não existe.")
              : "Não foi possível carregar a página. Recarregue para tentar de novo.",
        }),
    );
  }, [wikiId, slug]);
  useEffect(load, [load]);

  const shown = loaded.kind === "ready" ? loaded.view : null;
  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "wiki_sync.updated" && event.sync.wikiId === wikiId) {
      const { sync } = event;
      setLoaded((l) =>
        l.kind === "ready" ? { ...l, view: { ...l.view, wiki: { ...l.view.wiki, lastSync: sync } } } : l,
      );
    }
    // Uma versão nova: a página se relê (pode ter mudado, ou deixado de existir).
    if (event.type === "wiki.updated" && event.wiki.id === wikiId) {
      if (event.wiki.currentVersion?.number !== shown?.version) load();
      else setLoaded((l) => (l.kind === "ready" ? { ...l, view: { ...l.view, wiki: event.wiki } } : l));
    }
  });

  if (loaded.kind === "loading") return <main className="settings wiki">Carregando…</main>;
  if (loaded.kind === "missing") {
    return (
      <main className="settings wiki">
        <p className="error" role="alert">
          {loaded.message}
        </p>
        {slug !== WIKI_INDEX_SLUG && (
          <WikiLink wikiId={wikiId} slug={WIKI_INDEX_SLUG} onNavigate={onNavigate}>
            Ir para o índice
          </WikiLink>
        )}
      </main>
    );
  }

  const { wiki, page, links } = loaded.view;
  return (
    <main className="settings wiki" aria-label={`Wiki ${wiki.name}`}>
      <header className="wiki-head">
        <h1 className="channel-name">{wiki.name}</h1>
        <p className="hint" role="status">
          {syncing(wiki)
            ? "sincronizando…"
            : wiki.currentVersion && `sincronizada em ${dateTimeShort(wiki.currentVersion.publishedAt)}`}
        </p>
        {page.slug !== WIKI_INDEX_SLUG && (
          <WikiLink wikiId={wikiId} slug={WIKI_INDEX_SLUG} onNavigate={onNavigate}>
            Índice
          </WikiLink>
        )}
      </header>
      <article className="wiki-page" aria-label={page.title}>
        <h2>{page.title}</h2>
        <WikiBody wikiId={wikiId} body={page.body} links={links} onNavigate={onNavigate} />
      </article>
      <section className="wiki-sources" aria-label="Fontes da página">
        <h3>Fontes</h3>
        {page.sources.length === 0 ? (
          <p className="hint">Esta página não vem de uma Fonte: é o registro das Sincronizações.</p>
        ) : (
          <ul>
            {page.sources.map((s) => (
              <li key={s.id}>{s.fileName}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function WikiLink(props: { wikiId: string; slug: string; onNavigate(slug: string): void; children: ReactNode }) {
  const go = (e: MouseEvent) => {
    e.preventDefault();
    props.onNavigate(props.slug);
  };
  return (
    <a className="wiki-link" href={wikiPagePath(props.wikiId, props.slug)} onClick={go}>
      {props.children}
    </a>
  );
}

/** O texto de uma linha, com os links `[[slug]]` (o quebrado marcado, e não um link). */
function inline(line: string, ctx: BodyProps) {
  return wikiBodyParts(line).map((part, i) => {
    if ("text" in part) return part.text;
    const title = ctx.links.find((l) => l.slug === part.slug)?.title ?? null;
    const text = part.label ?? title ?? part.slug;
    if (title === null) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: os pedaços da linha não mudam de ordem.
        <span key={i} className="wiki-link broken" title="Essa página não existe na Wiki">
          {text} <span className="micro">(página que não existe)</span>
        </span>
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: os pedaços da linha não mudam de ordem.
      <WikiLink key={i} wikiId={ctx.wikiId} slug={part.slug} onNavigate={ctx.onNavigate}>
        {text}
      </WikiLink>
    );
  });
}

interface BodyProps {
  wikiId: string;
  body: string;
  links: WikiLinkDto[];
  onNavigate(slug: string): void;
}

/**
 * O corpo da página: um markdown simples (títulos `#`, listas `-` e parágrafos), com os links
 * `[[slug]]`. O resto do markdown aparece como texto.
 */
function WikiBody(props: BodyProps) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (items.length) {
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a página não muda depois de lida.
            <li key={i}>{inline(item, props)}</li>
          ))}
        </ul>,
      );
      items = [];
    }
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"), props)}</p>);
      paragraph = [];
    }
  };
  for (const line of props.body.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2]!, props)}</Tag>);
    } else if (item) {
      if (paragraph.length) flush();
      items.push(item[1]!);
    } else if (!line.trim()) {
      flush();
    } else {
      if (items.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <div className="wiki-body">{blocks}</div>;
}
