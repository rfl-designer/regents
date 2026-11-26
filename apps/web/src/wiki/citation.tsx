import { type WikiCitationDto, wikiCitationParts, wikiPagePath } from "@shearim/contracts";
import { createContext, Fragment, type MouseEvent, type ReactNode, useContext } from "react";

/** A página da Wiki que o App abre: a versão atual, ou a versão `version` (a da citação). */
export interface WikiAt {
  wikiId: string;
  slug: string;
  version?: number;
}

/** Abre a página da Wiki no App, sem recarregar (a citação na mensagem usa). */
export const OpenWikiContext = createContext<((at: WikiAt) => void) | null>(null);

/**
 * O corpo de uma mensagem com as citações da Wiki (#85): cada marcador `[[wiki:<nome>/<slug>]]`
 * vira o link para a página na versão lida, a citação sem link (quem vê não lê a Wiki) ou "não
 * consultada" (sem o nome da Wiki). Sem citações, o corpo como veio. `decorate` trata o texto em
 * volta (o destaque da Menção).
 */
export function MessageText({
  body,
  citations,
  decorate,
}: {
  body: string;
  citations: WikiCitationDto[] | undefined;
  decorate(text: string): ReactNode;
}) {
  if (!citations) return decorate(body);
  return wikiCitationParts(body).map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: os pedaços do corpo não mudam de ordem.
    <Fragment key={i}>
      {"text" in part ? (
        decorate(part.text)
      ) : (
        <Citation citation={citations.find((c) => c.marker === part.marker) ?? notConsulted(part.marker)} />
      )}
    </Fragment>
  ));
}

const notConsulted = (marker: string): WikiCitationDto => ({ marker, state: "not_consulted" });

function Citation({ citation: c }: { citation: WikiCitationDto }) {
  const open = useContext(OpenWikiContext);
  if (c.state === "not_consulted") {
    return (
      <span className="wiki-citation not-consulted" title="O Agente não leu esta página nesta resposta">
        não consultada
      </span>
    );
  }
  if (c.state === "unlinked") {
    return (
      <span className="wiki-citation" title="Você não lê esta Wiki">
        Wiki {c.wikiName}: {c.slug}
      </span>
    );
  }
  const go = (e: MouseEvent) => {
    if (!open) return;
    e.preventDefault();
    open({ wikiId: c.wikiId, slug: c.slug, version: c.version });
  };
  return (
    <a
      className="wiki-citation wiki-link"
      href={wikiPagePath(c.wikiId, c.slug, c.version)}
      title={`versão ${c.version}`}
      onClick={go}
    >
      Wiki {c.wikiName}: {c.title}
    </a>
  );
}
