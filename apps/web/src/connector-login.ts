/**
 * O login de um Conector pelo próprio servidor (#56): o navegador vai ao login dele e volta à tela
 * de onde saiu, com `?conector=ligado` ou `?erro=<motivo>`.
 */

/** O desfecho do retorno do login, lido uma vez e tirado do endereço. */
export function loginReturn(): { ok: true } | { error: string } | null {
  const params = new URLSearchParams(location.search);
  const ok = params.get("conector");
  const error = params.get("erro");
  if (!ok && !error) return null;
  history.replaceState(history.state, "", location.pathname);
  return error ? { error } : { ok: true };
}

/** Leva o navegador ao login do servidor (o retorno é no endereço desta Instalação). */
export function goToLogin(authorizationUrl: string) {
  location.assign(authorizationUrl);
}
