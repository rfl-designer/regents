import { useNotificationsOnboarding } from "./notifications";

/**
 * "Ligar notificações" na primeira abertura deste aparelho, acima da conversa, com "Pular".
 * O resultado fica à vista: ligadas, bloqueadas pelo navegador, ou o erro.
 */
export function NotificationsOnboarding() {
  const { state, enable, skip } = useNotificationsOnboarding();
  if (state.kind === "hidden") return null;
  return (
    <section className="offer" aria-label="Ligar notificações">
      {state.kind === "on" ? (
        <>
          <p role="status">Notificações ligadas neste aparelho.</p>
          <div className="actions">
            <button type="button" onClick={skip}>
              Fechar
            </button>
          </div>
        </>
      ) : state.kind === "blocked" ? (
        <>
          <p role="alert">
            As notificações estão bloqueadas neste navegador. Para receber os avisos de Menção e de DM, libere as
            notificações do Shearim nas configurações do site.
          </p>
          <div className="actions">
            <button type="button" onClick={skip}>
              Fechar
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Receba um aviso quando alguém mencionar você ou escrever numa DM sua, mesmo com o Shearim fechado.</p>
          {state.kind === "failed" && <p role="alert">Não consegui ligar as notificações: {state.detail}</p>}
          <div className="actions">
            <button type="button" className="primary" disabled={state.kind === "working"} onClick={enable}>
              {state.kind === "working" ? "Ligando…" : "Ligar notificações"}
            </button>
            <button type="button" onClick={skip}>
              Pular
            </button>
          </div>
        </>
      )}
    </section>
  );
}
