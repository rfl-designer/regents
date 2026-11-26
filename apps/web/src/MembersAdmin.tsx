import type { MeDto, MemberRole, MemberSummaryDto } from "@regents/contracts";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { ApiFailure, api } from "./api";
import { useServerEvents } from "./live";

/**
 * Só para o Admin: os Membros do Workspace, com o papel de cada um. Torna Admin, rebaixa e
 * remove (menos o último Admin, que o servidor recusa com o motivo). Ninguém remove a si mesmo.
 */
export function MembersSettings({ me }: { me: MeDto }) {
  const [members, setMembers] = useState<MemberSummaryDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(() => {
    api
      .members()
      .then(setMembers, () => setError({ id: "", message: "Não foi possível carregar. Recarregue a página." }));
  }, []);
  useEffect(load, [load]);

  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "member.updated") {
      setMembers((list) => list?.map((m) => (m.id === event.member.id ? event.member : m)) ?? null);
    }
    if (event.type === "member.removed") {
      setMembers((list) => list?.filter((m) => m.id !== event.memberId) ?? null);
    }
  });

  async function act(m: MemberSummaryDto, work: () => Promise<unknown>) {
    setBusy(m.id);
    setError(null);
    try {
      await work();
    } catch (err) {
      const body = err instanceof ApiFailure ? err.body : null;
      setError({ id: m.id, message: body && "message" in body ? body.message : "Não deu certo. Tente de novo." });
      load();
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const setRole = (m: MemberSummaryDto, role: MemberRole) =>
    act(m, async () => {
      const updated = await api.setMemberRole(m.id, role);
      setMembers((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null);
    });
  const remove = (m: MemberSummaryDto) =>
    act(m, async () => {
      await api.removeMember(m.id);
      setMembers((list) => list?.filter((x) => x.id !== m.id) ?? null);
    });

  return (
    <main className="settings">
      <h1 className="channel-name">Membros</h1>
      <p className="hint">
        Quem é removido perde o acesso na hora: a Conta dele é desligada e o que ele pediu aos Agentes é cancelado. As
        mensagens ficam, com a marca "saiu do Workspace". Para voltar, ele faz um Pedido de entrada; volta com o
        histórico, mas fora dos Canais privados e das DMs em grupo.
      </p>
      {error?.id === "" && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      <ul className="members" aria-label="Membros">
        {members?.map((m) => (
          <li key={m.id} className="member-row" aria-label={m.displayName}>
            <Avatar name={m.displayName} photo={m.profilePicUrl} />
            <div className="member-who">
              <strong>{m.displayName}</strong> <span className="handle">@{m.handle}</span>{" "}
              {m.role === "admin" && <span className="badge">Admin</span>}
              {m.id === me.id && <span className="muted"> (você)</span>}
              {error?.id === m.id && (
                <p className="error" role="alert">
                  {error.message}
                </p>
              )}
            </div>
            <div className="row">
              {m.role === "admin" ? (
                <button type="button" disabled={busy === m.id} onClick={() => setRole(m, "member")}>
                  Tirar de Admin
                </button>
              ) : (
                <button type="button" disabled={busy === m.id} onClick={() => setRole(m, "admin")}>
                  Tornar Admin
                </button>
              )}
              {m.id !== me.id &&
                (confirming === m.id ? (
                  <>
                    <button type="button" className="danger" disabled={busy === m.id} onClick={() => remove(m)}>
                      Remover {m.displayName}
                    </button>
                    <button type="button" className="link" onClick={() => setConfirming(null)}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy === m.id} onClick={() => setConfirming(m.id)}>
                    Remover
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
