import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { moveLegacyKeys } from "./notifications";
import "./styles.css";

// O service worker mostra os pushes nos navegadores sem Declarative Web Push (public/sw.js).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    console.error("regents: o service worker não registrou", err);
  });
}

// Antes de tudo ler as chaves deste navegador: as de antes do nome Regents passam para regents.*.
moveLegacyKeys();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
