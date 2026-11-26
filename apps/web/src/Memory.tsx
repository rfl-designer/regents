import type { MemoryItemDto } from "@regents/contracts";
import { useState } from "react";
import { api } from "./api";
import { useAction } from "./use-action";

/**
 * As peças da Memória na web (spec #60), comuns à lista "Memória" da conversa (`ChannelView`), à
 * tela do Agente (`AgentView`) e à Memória do Workspace (`WorkspaceMemory`).
 */

/** Os itens de uma lista de Memória, do mais novo para o mais velho: todos, os ativos e os arquivados. */
export function sortMemory(items: Iterable<MemoryItemDto>) {
  const all = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    all,
    active: all.filter((i) => i.state === "active"),
    archived: all.filter((i) => i.state === "archived"),
  };
}

/** Os itens arquivados de uma lista de Memória, à parte, cada um com o `archivedNote` dele. */
export function MemoryArchived({ archived, all }: { archived: MemoryItemDto[]; all: MemoryItemDto[] }) {
  if (archived.length === 0) return null;
  const byId = new Map(all.map((i) => [i.id, i]));
  return (
    <section className="memory-archived" aria-label="Arquivados">
      <h2 className="memory-subhead">Arquivados</h2>
      <ul className="memory-items">
        {archived.map((i) => (
          <li key={i.id} className="memory-item archived">
            <p className="memory-text">{i.text}</p>
            <p className="micro muted">{archivedNote(i, i.replacedById ? byId.get(i.replacedById) : undefined)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** O que diz um item arquivado: desfeito, substituído pela versão nova ou promovido ao Workspace. */
export function archivedNote(item: MemoryItemDto, next: MemoryItemDto | undefined) {
  if (!item.replacedById) return "desfeito";
  if (item.scope !== "workspace" && next?.scope === "workspace") return "promovido ao Workspace";
  return `substituído por: ${next?.text ?? "uma versão nova"}`;
}

/**
 * Um item ativo de uma lista de Memória: o texto, de qual Agente é (na Memória do Agente), a
 * origem, e Desfazer ou Corrigir (com "Voltar") quando quem olha pode (`editable`); "Promover ao
 * Workspace" quando há `onPromote`. Sem `onOpen`, a origem é só texto.
 */
export function MemoryItem({
  item: i,
  editable,
  onPromote,
  onOpen,
  onChanged,
}: {
  item: MemoryItemDto;
  editable: boolean;
  onPromote?(): Promise<MemoryItemDto>;
  onOpen?(item: MemoryItemDto): void;
  onChanged(item: MemoryItemDto): void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState(i.text);
  const undo = useAction(() => api.undoMemory(i.id).then(onChanged));
  const promote = useAction(async () => onChanged(await onPromote!()));
  const correct = useAction(() =>
    api.correctMemory(i.id, text).then((next) => {
      onChanged(next);
      setCorrecting(false);
    }),
  );
  return (
    <li className="memory-item">
      {correcting ? (
        <form
          className="memory-correct"
          onSubmit={(ev) => {
            ev.preventDefault();
            void correct.act();
          }}
        >
          <textarea
            aria-label="Versão corrigida"
            value={text}
            maxLength={500}
            rows={2}
            onChange={(ev) => setText(ev.target.value)}
          />
          <div className="failcard-actions">
            <button type="submit" className="primary" disabled={correct.busy || !text.trim()}>
              Salvar
            </button>
            <button type="button" className="link" disabled={correct.busy} onClick={() => setCorrecting(false)}>
              Voltar
            </button>
            {correct.failed && <span className="error">Não deu para corrigir. Tente de novo.</span>}
          </div>
        </form>
      ) : (
        <p className="memory-text">
          {i.text}
          {i.agent && (
            <>
              {" "}
              <span className="tag">Memória de {i.agent.name}</span>
            </>
          )}
          {i.scope === "workspace" && i.conversationId && (
            <>
              {" "}
              <span className="tag">no Workspace</span>
            </>
          )}
        </p>
      )}
      {i.origin &&
        (onOpen ? (
          <button type="button" className="link-quiet micro memory-origin" onClick={() => onOpen(i)}>
            {originText(i.origin)}
          </button>
        ) : (
          <p className="micro muted memory-origin">{originText(i.origin)}</p>
        ))}
      {!correcting && editable && (
        <div className="memory-actions">
          <button type="button" className="link micro" disabled={undo.busy} onClick={undo.act}>
            Desfazer
          </button>
          <button
            type="button"
            className="link micro"
            onClick={() => {
              setText(i.text);
              setCorrecting(true);
            }}
          >
            Corrigir
          </button>
          {onPromote && (
            <button type="button" className="link micro" disabled={promote.busy} onClick={promote.act}>
              Promover ao Workspace
            </button>
          )}
          {undo.failed && <span className="error">Não deu para desfazer. Tente de novo.</span>}
          {promote.failed && <span className="error">Não deu para promover. Tente de novo.</span>}
        </div>
      )}
    </li>
  );
}

function originText(origin: NonNullable<MemoryItemDto["origin"]>) {
  return `de ${origin.author}: “${origin.excerpt}”${origin.threadRootId ? " · na Thread" : ""}`;
}
