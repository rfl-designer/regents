import type { JoinRequestAdminDto } from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import { useServerEvents } from "./live";

const day = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

function upsert(list: JoinRequestAdminDto[], r: JoinRequestAdminDto) {
  return list.some((x) => x.id === r.id) ? list : [...list, r];
}

/**
 * Os Pedidos de entrada que esperam, para o Admin decidir. Some quando não há nenhum.
 * Pedidos novos e decisões de outros Admins chegam pelo WebSocket.
 */
export function JoinRequestsPanel() {
  const [pending, setPending] = useState<JoinRequestAdminDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    api.joinRequests().then(setPending, () => {});
  }, []);
  useEffect(load, [load]);

  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "join_request.created") setPending((prev) => upsert(prev, event.joinRequest));
    if (event.type === "join_request.decided") {
      setPending((prev) => prev.filter((r) => r.id !== event.joinRequest.id));
    }
  });

  async function decide(r: JoinRequestAdminDto, how: "approve" | "refuse") {
    setBusy(r.id);
    setFailed(null);
    try {
      await (how === "approve" ? api.approve(r.id) : api.refuse(r.id));
      setPending((prev) => prev.filter((x) => x.id !== r.id));
    } catch {
      setFailed(r.id);
      load(); // outro Admin pode ter decidido antes
    } finally {
      setBusy(null);
    }
  }

  if (pending.length === 0) return null;

  return (
    <section className="join-requests" aria-label="Pedidos de entrada">
      <h2>Pedidos de entrada</h2>
      <ul>
        {pending.map((r) => (
          <li key={r.id} className="join-request" aria-label={`Pedido de ${r.displayName}`}>
            <Avatar name={r.displayName} photo={r.profilePicUrl} />
            <div className="join-request-who">
              <div>
                <strong>{r.displayName}</strong> {r.sharee && <span className="badge">outra tailnet</span>}
              </div>
              <div className="muted">{r.login}</div>
              <div className="muted">Aparelho: {r.device ?? "não informado"}</div>
              {r.previousRefusals > 0 && (
                <div className="warn">
                  {r.previousRefusals === 1
                    ? "Já teve 1 pedido recusado"
                    : `Já teve ${r.previousRefusals} pedidos recusados`}
                  {r.lastRefusedAt && ` (o último em ${day.format(new Date(r.lastRefusedAt))})`}
                </div>
              )}
              {failed === r.id && (
                <p className="error" role="alert">
                  Não deu para decidir este pedido. Tente de novo.
                </p>
              )}
            </div>
            <div className="join-request-actions">
              <button type="button" className="primary" disabled={busy === r.id} onClick={() => decide(r, "approve")}>
                Aprovar
              </button>
              <button type="button" disabled={busy === r.id} onClick={() => decide(r, "refuse")}>
                Recusar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
