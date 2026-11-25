/**
 * O login de um Conector pelo próprio servidor MCP (#56, Spec #44): a autorização do MCP, que é
 * OAuth 2.1 com PKCE. O servidor diz onde fica o servidor de autorização dele (RFC 9728, ou o
 * próprio endereço como reserva); o Shearim se registra como cliente (RFC 7591), manda o navegador
 * de quem liga ao login, troca o código do retorno pelos tokens e renova o de acesso antes de vencer.
 *
 * Só fala com o servidor de fora; quem guarda (cifrado) e decide o que fazer é `connectors.ts`.
 */
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

/** O que a credencial ligada pelo login guarda (cifrado) para se renovar. */
export interface LoginGrant {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  /** O recurso (o servidor MCP) a que o token se destina (RFC 8707). */
  resource: string;
  refreshToken?: string;
}

/** Um login em andamento: o mesmo, mais o verificador PKCE. */
export interface PendingLogin extends Omit<LoginGrant, "refreshToken"> {
  codeVerifier: string;
}

/** Os tokens de um login ou de uma renovação. */
export interface LoginTokens {
  accessToken: string;
  /** Em quantos segundos o de acesso vence, se o servidor disse. */
  expiresIn?: number;
  grant: LoginGrant;
}

/** O servidor não oferece login (não tem servidor de autorização, ou não aceita cliente novo). */
export class NoLogin extends Error {}

/**
 * O servidor de autorização recusou (código ou renovação): `invalid_grant`, `invalid_client`… A
 * credencial está recusada. Uma falha passageira (sem resposta, `server_error`) não é recusa.
 */
export class LoginRefused extends Error {}

function refusalOf(err: unknown) {
  const passing =
    err instanceof ServerError || err instanceof TemporarilyUnavailableError || err instanceof TooManyRequestsError;
  return err instanceof OAuthError && !passing ? new LoginRefused(err.message) : err;
}

function tokensOf(tokens: OAuthTokens, grant: Omit<LoginGrant, "refreshToken">, previousRefresh?: string): LoginTokens {
  return {
    accessToken: tokens.access_token,
    expiresIn: typeof tokens.expires_in === "number" ? tokens.expires_in : undefined,
    grant: { ...grant, refreshToken: tokens.refresh_token ?? previousRefresh },
  };
}

/**
 * Começa o login: descobre o servidor de autorização, registra o Shearim como cliente com
 * `redirectUri` e monta o endereço do login. `NoLogin` se o servidor não oferece; o resto
 * (sem resposta) propaga.
 */
export async function beginLogin(
  serverUrl: string,
  redirectUri: string,
  state: string,
): Promise<{ authorizationUrl: string; pending: PendingLogin }> {
  const info = await discoverOAuthServerInfo(serverUrl);
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw new NoLogin("o servidor não oferece login");
  if (!metadata.registration_endpoint) {
    throw new NoLogin("o servidor tem login, mas não aceita o registro de um cliente novo");
  }
  const resource = info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(serverUrl).href;
  const scope = info.resourceMetadata?.scopes_supported?.join(" ") || undefined;
  let client: OAuthClientInformationMixed;
  try {
    client = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: "Shearim",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      scope,
    });
  } catch (err) {
    if (err instanceof OAuthError) throw new NoLogin(`o servidor não aceitou o registro do Shearim: ${err.message}`);
    throw err;
  }
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope,
    state,
    resource: new URL(resource),
  });
  return {
    authorizationUrl: authorizationUrl.href,
    pending: { authorizationServerUrl: info.authorizationServerUrl, metadata, client, resource, codeVerifier },
  };
}

/** Troca o código do retorno pelos tokens. `LoginRefused` se o servidor recusa o código. */
export async function finishLogin(pending: PendingLogin, code: string, redirectUri: string): Promise<LoginTokens> {
  const { codeVerifier, ...grant } = pending;
  try {
    const tokens = await exchangeAuthorization(grant.authorizationServerUrl, {
      metadata: grant.metadata,
      clientInformation: grant.client,
      authorizationCode: code,
      codeVerifier,
      redirectUri,
      resource: new URL(grant.resource),
    });
    return tokensOf(tokens, grant);
  } catch (err) {
    throw refusalOf(err);
  }
}

/** Renova o token de acesso. `LoginRefused` se o servidor recusa (sem renovação, revogado…). */
export async function renewLogin(grant: LoginGrant): Promise<LoginTokens> {
  if (!grant.refreshToken) throw new LoginRefused("o login não deixou como renovar");
  const { refreshToken, ...rest } = grant;
  try {
    const tokens = await refreshAuthorization(grant.authorizationServerUrl, {
      metadata: grant.metadata,
      clientInformation: grant.client,
      refreshToken,
      resource: new URL(grant.resource),
    });
    return tokensOf(tokens, rest, refreshToken);
  } catch (err) {
    throw refusalOf(err);
  }
}
