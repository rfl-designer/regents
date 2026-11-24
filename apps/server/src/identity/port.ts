import type { NoIdentityReason } from "@shearim/contracts";

export type { NoIdentityReason };

/**
 * Porta de identidade da tailnet (Spec, módulo 1; ADR 0007).
 *
 * Diz quem fez a requisição. O Membro é amarrado a `userId` (o `UserProfile.ID`
 * do `whois`, como texto); `login` e `displayName` servem só para exibição.
 */
export type Identity =
  | {
      kind: "user";
      /** `UserProfile.ID` do whois, como texto (é int64). */
      userId: string;
      login: string;
      displayName: string;
      profilePicUrl?: string;
      /**
       * Nome do aparelho, para o Admin ver no Pedido de entrada (no whois,
       * `Node.Hostinfo.Hostname` ou `Node.ComputedName`; o adaptador do #37 preenche).
       */
      device?: string;
      /** `Node.Hostinfo.ShareeNode`: pessoa de outra tailnet. */
      sharee: boolean;
    }
  | { kind: "none"; reason: NoIdentityReason };

export interface IdentityPort {
  /** `peer`: o endereço de quem abriu a conexão TCP (o `requestIP` do Bun), quando há servidor. */
  whoAmI(req: Request, peer?: string): Promise<Identity>;
}
