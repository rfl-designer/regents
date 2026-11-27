import type { MyJoinRequestDto } from "@regents/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { dayMonthTime } from "./format";

/** De quanto em quanto tempo quem espera confere se um Admin já decidiu. */
const POLL_MS = 3_000;

const formatWhen = dayMonthTime;

/**
 * Tela de quem tem identidade da tailnet mas ainda não é Membro: pedir para entrar,
 * esperar um Admin, ver a recusa e pedir de novo. Quando o pedido é aprovado, chama
 * `onApproved` para o app carregar o Workspace.
 */
export function EntryView({ onApproved }: { onApproved: () => void }) {
  const [state, setState] = useState<MyJoinRequestDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    api.myJoinRequest().then(
      (mine) => {
        setFailed(false);
        if (mine.joinRequest?.status === "approved") onApproved();
        else setState(mine);
      },
      () => setFailed(true),
    );
  }, [onApproved]);

  useEffect(load, [load]);

  const status = state?.joinRequest?.status;
  useEffect(() => {
    if (status !== "pending") return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  async function ask() {
    setSending(true);
    setFailed(false);
    try {
      const joinRequest = await api.requestToJoin();
      setState((prev) => prev && { ...prev, joinRequest });
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  if (!state) {
    return (
      <main className="center" aria-busy={!failed}>
        {failed ? <p role="alert">Não foi possível falar com o Regents. Recarregue a página.</p> : "Carregando…"}
      </main>
    );
  }

  const request = state.joinRequest;
  const error = failed && (
    <p className="error" role="alert">
      Não foi possível falar com o Regents. Tente de novo.
    </p>
  );
  const whoami = (
    <p className="whoami">
      Você está como {state.you.displayName} ({state.you.login})
    </p>
  );

  if (request?.status === "pending") {
    return (
      <main className="center entry" aria-label="Pedido de entrada">
        <h1>Seu pedido de entrada está esperando um Admin</h1>
        <p role="status">
          Pedido feito em {formatWhen(request.createdAt)}. Esta tela muda sozinha quando um Admin decidir.
        </p>
        {whoami}
        {error}
      </main>
    );
  }

  if (request?.status === "refused") {
    return (
      <main className="center entry" aria-label="Pedido de entrada">
        <h1>Seu pedido de entrada foi recusado</h1>
        <p role="status">
          Um Admin recusou o pedido em {formatWhen(request.decidedAt ?? request.createdAt)}. Se acha que foi engano,
          fale com quem cuida do Workspace e peça de novo.
        </p>
        {whoami}
        <button type="button" className="primary" onClick={ask} disabled={sending}>
          Pedir de novo
        </button>
        {error}
      </main>
    );
  }

  if (state.removedAt) {
    return (
      <main className="center entry" aria-label="Pedido de entrada">
        <h1>Você saiu deste Workspace</h1>
        <p role="status">
          Um Admin removeu você em {formatWhen(state.removedAt)}. Para voltar, peça para entrar de novo: você volta com
          o seu histórico, mas fora dos Canais privados e das DMs em grupo.
        </p>
        {whoami}
        <button type="button" className="primary" onClick={ask} disabled={sending}>
          Pedir para entrar de novo
        </button>
        {error}
      </main>
    );
  }

  return (
    <main className="center entry" aria-label="Pedido de entrada">
      <h1>Você ainda não é Membro deste Workspace</h1>
      <p>Peça para entrar. Um Admin vê o seu pedido e aprova ou recusa.</p>
      {whoami}
      <button type="button" className="primary" onClick={ask} disabled={sending}>
        Pedir para entrar
      </button>
      {error}
    </main>
  );
}
