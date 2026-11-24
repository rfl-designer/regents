import { NO_IDENTITY_TEXT, type NoIdentityReason } from "@shearim/contracts";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * A página estática de quem chega sem identidade da tailnet (nó com tag, Funnel), ADR 0007.
 * Não depende do PWA nem de JavaScript: diz o motivo e o que fazer, e não cria Pedido de entrada.
 */
export function noIdentityPage(reason: NoIdentityReason): string {
  const text = NO_IDENTITY_TEXT[reason] ?? NO_IDENTITY_TEXT.unknown;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shearim: não sabemos quem é você</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; padding: 16px; background: Canvas; color: CanvasText; }
  main { max-width: 32rem; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  p { line-height: 1.5; }
  .muted { opacity: 0.7; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <h1>Não sabemos quem é você</h1>
  <p>${escapeHtml(text.why)}</p>
  <p><strong>O que fazer:</strong> ${escapeHtml(text.whatToDo)}</p>
  <p class="muted">O Shearim reconhece cada pessoa pela conta dela na tailnet. Sem essa conta, não dá para entrar nem pedir para entrar.</p>
</main>
</body>
</html>
`;
}
