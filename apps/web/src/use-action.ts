import { useState } from "react";

/** Um botão que espera a chamada e mostra o erro dela, sem travar a tela. */
export function useAction(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function act() {
    setBusy(true);
    setFailed(false);
    try {
      await run();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return { busy, failed, act };
}
