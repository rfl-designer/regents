import type { AccountDto, AccountValidityDto } from "@shearim/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { dayMonth, hourMinute } from "./format";
import { useServerEvents } from "./live";

/** A validade do login da Conta, quando ela pede atenção (faltam 3 dias ou menos, ou já passou). */
export function expiringValidity(account: AccountDto | null): AccountValidityDto | null {
  const status = account?.status;
  if (status?.state !== "linked" && status?.state !== "limited") return null;
  return status.validity && status.validity.state !== "ok" ? status.validity : null;
}

/** "vale até 21/12" ou, passada a data, "pode vencer a qualquer momento". */
function validityLabel(validity: AccountValidityDto) {
  return validity.state === "any_time" ? "pode vencer a qualquer momento" : `vale até ${dayMonth(validity.until)}`;
}

/** O que acontece depois do vencimento (história 39). */
function afterwardsText(validity: AccountValidityDto) {
  return validity.afterwards === "key"
    ? "as suas mensagens passam a seguir pela Chave do Workspace"
    : "as suas mensagens aos Agentes esperam na fila até você ligar de novo";
}

/**
 * A Conta do Claude do próprio Membro, viva (só com `enabled`, isto é, já Membro): carrega pelo HTTP e acompanha
 * `account.updated` (que só chega a ele). Recarrega a cada `ready`.
 */
export function useAccount(enabled: boolean) {
  const [account, setAccount] = useState<AccountDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // O fluxo anda no servidor enquanto uma resposta HTTP viaja: um evento que chegou
  // depois de o pedido sair é mais novo que a resposta, e a resposta não o desfaz.
  const events = useRef(0);
  const settle = useCallback(async (request: Promise<AccountDto>) => {
    const before = events.current;
    const fresh = await request;
    if (events.current === before) setAccount(fresh);
  }, []);
  const load = useCallback(() => {
    if (!enabled) return;
    settle(api.account.get()).catch(() => setError("Não foi possível carregar a sua Conta. Recarregue a página."));
  }, [settle, enabled]);
  useEffect(load, [load]);
  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "account.updated") {
      events.current += 1;
      setAccount(event.account);
    }
  }, enabled);

  /** Roda um comando da Conta; a resposta traz a Conta nova, e a falha vira texto na tela. */
  const run = useCallback(
    async (command: () => Promise<AccountDto>) => {
      setError(null);
      try {
        await settle(command());
        return true;
      } catch (err) {
        const message = err instanceof ApiFailure && err.body && "message" in err.body ? err.body.message : null;
        setError(message ?? "Não deu certo. Tente de novo.");
        return false;
      }
    },
    [settle],
  );

  return { account, error, run };
}

export type AccountState = ReturnType<typeof useAccount>;

/** A oferta do primeiro acesso, acima da conversa, com "Agora não". */
export function AccountOffer({ state, onOpen }: { state: AccountState; onOpen: () => void }) {
  const { account, run } = state;
  if (!account?.offer || account.linking) return null;
  return (
    <section className="offer" aria-label="Ligar a sua Conta do Claude">
      <p>
        Ligue a sua Conta do Claude para que as suas mensagens aos Agentes usem a sua própria assinatura. Você entra na
        página da Anthropic e cola o código aqui, sem terminal.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            onOpen();
            await run(api.account.startLinking);
          }}
        >
          Ligar minha Conta do Claude
        </button>
        <button type="button" onClick={() => run(api.account.notNow)}>
          Agora não
        </button>
      </div>
    </section>
  );
}

const SETTINGS_URL = "https://claude.ai/settings/claude-code";

/** "Minha Conta": o estado da Conta e o fluxo de ligar e desligar. Só o próprio Membro chega aqui. */
export function MyAccount({ state }: { state: AccountState }) {
  const { account, error, run } = state;
  const [code, setCode] = useState("");
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinked, setUnlinked] = useState(false);

  if (!account) return <main className="account">{error ? <p className="error">{error}</p> : "Carregando…"}</main>;

  const start = async () => {
    setUnlinked(false);
    setCode("");
    await run(api.account.startLinking);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) await run(() => api.account.submitCode({ code }));
  };
  const linking = account.linking;
  const status = account.status;
  const validity = status.state === "linked" || status.state === "limited" ? status.validity : null;
  const expiring = expiringValidity(account);

  return (
    <main className="account">
      <h1>Minha Conta</h1>
      <section
        className={expiring ? "account-status expiring" : "account-status"}
        aria-label="Estado da Conta"
        data-expiring={expiring ? "true" : undefined}
      >
        {account.status.state === "not_linked" ? (
          <strong>Não ligada</strong>
        ) : (
          <>
            <strong>
              {account.status.state === "limited"
                ? `No limite até ${hourMinute(account.status.until)}`
                : account.status.state === "needs_relink"
                  ? "Precisa ligar de novo"
                  : "Ligada"}
            </strong>
            <span>
              {account.status.plan} · {account.status.email}
            </span>
            {validity && <span className="validity">{validityLabel(validity)}</span>}
            {status.state === "linked" && status.extraUsage && <span className="extra-usage">usando uso extra</span>}
          </>
        )}
      </section>
      {expiring && !linking && (
        <p className="hint expiring-hint" role="status">
          {expiring.state === "any_time"
            ? "O login da sua Conta do Claude pode vencer a qualquer momento."
            : `O login da sua Conta do Claude pode vencer a partir de ${dayMonth(expiring.until)}.`}{" "}
          Ligue de novo para não interromper. Quando ele vencer, {afterwardsText(expiring)}.
        </p>
      )}
      {account.status.state === "limited" && (
        <p className="hint">Até lá, as suas mensagens aos Agentes usam a Chave do Workspace ou esperam na fila.</p>
      )}
      {!linking && account.status.state === "needs_relink" && (
        <>
          <p className="hint">
            O login da sua Conta do Claude caiu. Até você ligar de novo, as suas mensagens aos Agentes usam a Chave do
            Workspace ou, sem ela, esperam na fila.
          </p>
          <button type="button" className="primary" onClick={start}>
            Ligar minha Conta do Claude
          </button>
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!linking && account.status.state === "not_linked" && (
        <>
          {unlinked && (
            <p className="hint">
              Conta desligada. Para tirar a ligação também do lado da Anthropic, abra{" "}
              <a href={SETTINGS_URL} target="_blank" rel="noreferrer">
                claude.ai/settings/claude-code
              </a>
              .
            </p>
          )}
          <p className="hint">Sem Conta ligada, as suas mensagens aos Agentes usam a Chave do Workspace, se houver.</p>
          <button type="button" className="primary" onClick={start}>
            Ligar minha Conta do Claude
          </button>
        </>
      )}

      {linking?.state === "starting" && <p aria-live="polite">Abrindo o login da Anthropic…</p>}

      {linking?.state === "waiting_code" && (
        <section className="steps" aria-label="Ligar a Conta">
          <p>
            1.{" "}
            <a href={linking.url} target="_blank" rel="noreferrer">
              Abrir a página de login da Anthropic
            </a>{" "}
            e entrar com a sua conta do Claude.
          </p>
          <form onSubmit={submit}>
            <label htmlFor="account-code">2. Cole aqui o código que a página mostrar:</label>
            <input
              id="account-code"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className="actions">
              <button type="submit" className="primary" disabled={!code.trim()}>
                Ligar
              </button>
              <button type="button" onClick={() => run(api.account.cancelLinking)}>
                Cancelar
              </button>
            </div>
          </form>
          <p className="hint">O código vale até {hourMinute(linking.expiresAt)}.</p>
        </section>
      )}

      {linking?.state === "checking" && <p aria-live="polite">Conferindo a sua Conta…</p>}

      {linking?.state === "duplicate" && (
        <section className="warning" role="alert">
          <p>
            Essa Conta do Claude já está ligada a outra pessoa deste Workspace. Pelos termos da Anthropic, a assinatura
            é pessoal.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => run(api.account.confirm)}>
              Ligar mesmo assim
            </button>
            <button type="button" onClick={() => run(api.account.cancelLinking)}>
              Cancelar
            </button>
          </div>
        </section>
      )}

      {(linking?.state === "failed" || linking?.state === "expired") && (
        <section className="warning" role="alert">
          <p>
            {linking.state === "failed"
              ? linking.message
              : "A espera pelo código passou de 10 minutos. Comece de novo para abrir um login novo."}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={start}>
              Começar de novo
            </button>
            <button type="button" onClick={() => run(api.account.cancelLinking)}>
              Fechar
            </button>
          </div>
        </section>
      )}

      {!linking && (status.state === "linked" || status.state === "limited") && (
        <button type="button" className={expiring ? "primary" : undefined} onClick={start}>
          Ligar de novo
        </button>
      )}

      {account.status.state !== "not_linked" &&
        (confirmingUnlink ? (
          <section className="warning">
            <p>
              Desligar a sua Conta do Claude? As suas mensagens deixam de usar a sua assinatura. A ligação também sai em{" "}
              <a href={SETTINGS_URL} target="_blank" rel="noreferrer">
                claude.ai/settings/claude-code
              </a>
              .
            </p>
            <div className="actions">
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  if (await run(api.account.unlink)) setUnlinked(true);
                  setConfirmingUnlink(false);
                }}
              >
                Desligar
              </button>
              <button type="button" onClick={() => setConfirmingUnlink(false)}>
                Cancelar
              </button>
            </div>
          </section>
        ) : (
          <button type="button" onClick={() => setConfirmingUnlink(true)}>
            Desligar a Conta
          </button>
        ))}
    </main>
  );
}
