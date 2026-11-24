import { useState } from "react";
import type { EnableOutcome, PushState } from "./notifications";

/**
 * "Ligar notificações" na primeira abertura deste aparelho, acima da conversa, com "Pular".
 * O resultado fica à vista: ligadas, bloqueadas pelo navegador, ou o erro.
 */
export function NotificationsOnboarding({ push }: { push: PushState }) {
  const [outcome, setOutcome] = useState<EnableOutcome | null>(null);
  const [closed, setClosed] = useState(false);
  if (closed || (!push.offerOnboarding && !outcome)) return null;
  const close = () => {
    if (outcome?.kind !== "on") push.skip();
    setClosed(true);
  };
  return (
    <section className="offer" aria-label="Ligar notificações">
      {outcome?.kind === "on" ? (
        <>
          <p role="status">Notificações ligadas neste aparelho.</p>
          <div className="actions">
            <button type="button" onClick={close}>
              Fechar
            </button>
          </div>
        </>
      ) : outcome?.kind === "blocked" ? (
        <>
          <p role="alert">
            As notificações estão bloqueadas neste navegador. Para receber os avisos de Menção e de DM, libere as
            notificações do Shearim nas configurações do site.
          </p>
          <div className="actions">
            <button type="button" onClick={close}>
              Fechar
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Receba um aviso quando alguém mencionar você ou escrever numa DM sua, mesmo com o Shearim fechado.</p>
          {outcome?.kind === "failed" && <p role="alert">Não consegui ligar as notificações: {outcome.detail}</p>}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={push.working}
              onClick={async () => setOutcome(await push.enable())}
            >
              {push.working ? "Ligando…" : "Ligar notificações"}
            </button>
            <button type="button" onClick={close}>
              Pular
            </button>
          </div>
        </>
      )}
    </section>
  );
}
