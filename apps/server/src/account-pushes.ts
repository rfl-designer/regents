import { ACCOUNT_PATH } from "@shearim/contracts";
import type { AccountHooks } from "./accounts";
import type { Db } from "./db/client";
import { memberById } from "./members";
import type { Push } from "./push";
import { hasWorkspaceKey } from "./workspace-key";

/**
 * Os pushes da Conta (Spec, módulo 12, "Gatilhos"): a queda (história 41) e a assinatura repetida
 * (história 43). A Conta é só do Membro: cada push vai só ao dono dela, nunca a um Admin. O aviso
 * de vencimento 3 dias antes (história 38) é do #35: um `notify` igual, com `tag: "conta"`.
 */
export function accountPushes(deps: { db: Db; notify: Push["notify"] }): AccountHooks {
  const { db, notify } = deps;

  const later = (what: string, work: Promise<void>) =>
    void work.catch((err) => console.error(`shearim: o push ${what} falhou`, err));

  return {
    accountDropped(memberId, drop) {
      later(
        "da queda da Conta",
        (async () => {
          const key = await hasWorkspaceKey(db);
          const n =
            drop.state === "limited"
              ? {
                  title: "Sua Conta do Claude chegou ao limite",
                  body:
                    `Ela volta às ${hourOf(drop.until)}. ` +
                    (key
                      ? "Até lá, suas mensagens seguem pela Chave do Workspace."
                      : "Até lá, suas mensagens com Agentes esperam na fila."),
                }
              : {
                  title: "Sua Conta do Claude precisa ser ligada de novo",
                  body: key
                    ? "Suas mensagens seguem pela Chave do Workspace. Ligue de novo em Minha Conta quando puder."
                    : "Suas mensagens com Agentes esperam na fila até você ligar de novo em Minha Conta.",
                };
          // A mesma `tag` de toda notícia da Conta: a mais nova toma o lugar da anterior.
          notify(memberId, { ...n, path: ACCOUNT_PATH, tag: "conta", urgency: "normal" });
        })(),
      );
    },

    subscriptionShared(owners, memberId) {
      later(
        "da assinatura repetida",
        (async () => {
          const newcomer = await memberById(db, memberId);
          if (!newcomer) return;
          for (const owner of owners) {
            notify(owner, {
              title: `${newcomer.displayName} também ligou a sua Conta do Claude`,
              body: "A assinatura é pessoal: daqui em diante, vocês dividem o limite dela.",
              path: ACCOUNT_PATH,
              tag: "conta-assinatura",
              urgency: "normal",
            });
          }
        })(),
      );
    },
  };
}

/** `15:45`, na hora local do servidor (`TZ`), como "Minha Conta" mostra o "No limite até". */
function hourOf(at: Date) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(at);
}
