import { useState } from "react";
import { dayMonth } from "./format";
import { type EnableOutcome, type PushState, useInstallStep } from "./notifications";

/**
 * As faixas de push parado (história 101): este aparelho sem push, com "Ligar" (ou, com a
 * permissão negada, como reativar), e cada outro aparelho que parou de receber. Somem sozinhas
 * quando o aparelho volta a receber ou é removido (`devices.updated`).
 */
export function PushBanners({ push, onOpenDevices }: { push: PushState; onOpenDevices: () => void }) {
  return (
    <>
      <ThisDeviceBanner push={push} />
      {push.othersStopped.length > 0 && (
        <section className="offer" aria-label="Push parado em outro aparelho">
          {push.othersStopped.map((d) => (
            <p key={d.id}>
              {d.label ? `O push parou no ${d.label}` : "O push parou num outro aparelho"} em{" "}
              {dayMonth(d.pushStoppedAt!)}. Abra o Shearim nele para religar, ou remova-o se não usa mais.
            </p>
          ))}
          <div className="actions">
            <button type="button" onClick={onOpenDevices}>
              Ver aparelhos
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function ThisDeviceBanner({ push }: { push: PushState }) {
  const [failure, setFailure] = useState<Extract<EnableOutcome, { kind: "failed" }> | null>(null);
  if (!push.thisDevice) return null;
  return (
    <section className="offer" aria-label="Notificações deste aparelho">
      {push.thisDevice === "blocked" ? (
        <p role="alert">
          As notificações estão bloqueadas neste aparelho. Para voltar a receber os avisos, libere as notificações do
          Shearim nas configurações do navegador (no iPhone: Ajustes › Notificações › Shearim).
        </p>
      ) : (
        <>
          <p role="alert">
            Notificações desligadas neste aparelho{" · "}
            <button
              type="button"
              className="banner-link"
              disabled={push.working}
              onClick={async () => {
                const outcome = await push.enable();
                setFailure(outcome.kind === "failed" ? outcome : null);
              }}
            >
              Ligar
            </button>
          </p>
          {failure && <p role="alert">Não consegui ligar as notificações: {failure.detail}</p>}
        </>
      )}
    </section>
  );
}

/**
 * O passo ilustrado do iPhone (história 99): no Safari, fora da tela de início, não há push. O
 * passo ensina "Compartilhar → Adicionar à Tela de Início" e pode ser pulado.
 */
export function InstallOnIphone() {
  const { show, skip } = useInstallStep();
  if (!show) return null;
  return (
    <section className="offer install" aria-label="Adicionar à Tela de Início">
      <p>
        <strong>Adicione o Shearim à Tela de Início</strong> para receber notificações no iPhone. Só o app da tela de
        início recebe push.
      </p>
      <ol className="install-steps">
        <li>
          <ShareIcon /> Toque em <strong>Compartilhar</strong>, na barra do Safari.
        </li>
        <li>
          <AddIcon /> Escolha <strong>Adicionar à Tela de Início</strong> e toque em Adicionar.
        </li>
        <li>
          <img src="/icon.svg" alt="" width={22} height={22} /> Abra o Shearim pelo ícone e ligue as notificações.
        </li>
      </ol>
      <div className="actions">
        <button type="button" onClick={skip}>
          Pular
        </button>
      </div>
    </section>
  );
}

/** O ícone de Compartilhar do Safari: a caixa com a seta para cima. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" className="install-icon">
      <path
        d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** O ícone de "Adicionar à Tela de Início": o quadrado com o mais. */
function AddIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" className="install-icon">
      <rect x={4} y={4} width={16} height={16} rx={4} fill="none" stroke="currentColor" strokeWidth={1.8} />
      <path d="M12 8.5v7M8.5 12h7" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}
