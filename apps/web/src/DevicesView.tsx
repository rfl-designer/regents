import { useState } from "react";
import { dayMonth, dayMonthTime } from "./format";
import { deviceName, type EnableOutcome, type PushState } from "./notifications";

/**
 * Notificações (história 102): os aparelhos do Membro com o estado e o último push entregue, e
 * "Remover" para os que ele não usa mais. Também liga o push neste aparelho, se estiver sem.
 */
export function DevicesView({ push }: { push: PushState }) {
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EnableOutcome | null>(null);
  const { devices } = push;
  const mine = devices?.find((d) => d.id === push.thisDeviceId);

  return (
    <main className="account">
      <h1>Notificações</h1>
      <p className="hint">Os aparelhos em que você ligou o push. Remova os que não usa mais.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {push.supported && devices && !mine?.pushing && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={push.working}
            onClick={async () => setOutcome(await push.enable())}
          >
            Ligar neste aparelho
          </button>
        </div>
      )}
      {outcome?.kind === "blocked" && (
        <p role="alert">
          As notificações estão bloqueadas neste navegador. Libere as notificações do Shearim nas configurações do site.
        </p>
      )}
      {outcome?.kind === "failed" && <p role="alert">Não consegui ligar as notificações: {outcome.detail}</p>}
      {devices === null ? (
        <p>Carregando…</p>
      ) : devices.length === 0 ? (
        <p>Nenhum aparelho recebe push ainda.</p>
      ) : (
        <ul className="devices" aria-label="Meus aparelhos">
          {devices.map((d) => (
            <li key={d.id} className="account-status">
              <strong>
                {deviceName(d)}
                {d.id === push.thisDeviceId && " · este aparelho"}
              </strong>
              <span>
                {d.pushing ? "Recebendo" : d.pushStoppedAt ? `Parou em ${dayMonth(d.pushStoppedAt)}` : "Sem push"}
              </span>
              <span>
                {d.lastPushAt ? `Último push entregue em ${dayMonthTime(d.lastPushAt)}` : "Nenhum push entregue ainda"}
              </span>
              <div className="actions">
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await push.remove(d.id);
                    } catch {
                      setError(`Não consegui remover ${deviceName(d)}. Tente de novo.`);
                    }
                  }}
                >
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
