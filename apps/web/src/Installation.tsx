import {
  BACKUP_RETENTION_DAYS,
  BACKUP_STALE_HOURS,
  type InstallationAlertDto,
  type InstallationDto,
  type NodeKeyDto,
} from "@shearim/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { dayMonthHour, fullDay } from "./format";
import { useServerEvents } from "./live";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "há 5 h", "há 2 dias", "há menos de 1 h". */
export function ago(iso: string, now = Date.now()) {
  const hours = Math.floor((now - Date.parse(iso)) / HOUR_MS);
  if (hours < 1) return "há menos de 1 h";
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} dias`;
}

/**
 * O estado da Instalação, só para o Admin (`GET /api/installation`), sempre o último que o servidor
 * mandou: `installation.updated` chega quando um backup sai, falha ou passa das 36 h.
 */
export function useInstallation(enabled: boolean) {
  const [installation, setInstallation] = useState<InstallationDto | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    if (!enabled) return;
    api.installation().then(
      (dto) => {
        setInstallation(dto);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [enabled]);
  useEffect(load, [load]);
  // Só o Admin escuta: quem ainda não é Membro não abre o WebSocket de eventos.
  useServerEvents((event) => {
    if (event.type === "ready") load();
    if (event.type === "installation.updated") setInstallation(event.installation);
  }, enabled);
  return { installation, failed };
}

function alertText(alert: InstallationAlertDto) {
  if (alert.kind === "backup_failed") return `O backup de ${dayMonthHour(alert.at)} falhou: ${alert.error}`;
  return alert.lastGoodAt
    ? `Faz mais de ${BACKUP_STALE_HOURS} h sem um backup bom (o último foi ${ago(alert.lastGoodAt)}).`
    : `Faz mais de ${BACKUP_STALE_HOURS} h sem um backup bom: ainda não houve nenhum.`;
}

/** A faixa do Admin quando o backup falha ou fica 36 h sem um bom. Some quando volta a dar certo. */
export function InstallationBanner(props: { installation: InstallationDto | null; onOpen?: () => void }) {
  const alerts = props.installation?.alerts ?? [];
  if (alerts.length === 0) return null;
  return (
    <section className="banner warn-banner" role="alert" aria-label="Backup da Instalação">
      {alerts.map((a) => (
        <p key={a.kind}>{alertText(a)}</p>
      ))}
      {props.onOpen && (
        <button type="button" className="link" onClick={props.onOpen}>
          Ver a Instalação
        </button>
      )}
    </section>
  );
}

function nodeKeyText(key: NodeKeyDto) {
  if (key.kind === "never") return "Não vence (o vencimento da chave está desligado para este nó).";
  if (key.kind === "unknown") return `Não deu para saber: ${key.reason}.`;
  const at = new Date(key.expiresAt);
  const days = Math.ceil((at.getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return `Venceu em ${fullDay(at)}: a Instalação saiu da tailnet.`;
  return `Vence em ${fullDay(at)} (daqui a ${days === 1 ? "1 dia" : `${days} dias`}). Renove no painel do Tailscale, em Machines.`;
}

/** A seção Instalação: a versão, o último backup e o vencimento da chave do nó. */
export function InstallationSettings({ state }: { state: ReturnType<typeof useInstallation> }) {
  const { installation, failed } = state;
  if (!installation) {
    return (
      <main className="settings">
        <h1 className="channel-name">Instalação</h1>
        <p className="notice">{failed ? "Não foi possível carregar. Recarregue a página." : "Carregando…"}</p>
      </main>
    );
  }
  const { backup } = installation;
  return (
    <main className="settings">
      <h1 className="channel-name">Instalação</h1>
      <InstallationBanner installation={installation} />
      <dl className="installation">
        <dt>Versão</dt>
        <dd>
          {installation.version}
          <span className="muted"> · banco na migração {installation.migration || "?"}</span>
        </dd>
        <dt>Último backup</dt>
        <dd>
          {backup.last ? (
            <>
              {backup.last.ok ? "Bom" : "Falhou"}, {ago(backup.last.at)}{" "}
              <span className="muted">({dayMonthHour(backup.last.at)})</span>
              {backup.last.ok && backup.last.file && <div className="muted">{backup.last.file} em ./backups</div>}
              {!backup.last.ok && (
                <div className="muted">
                  {backup.last.error}
                  {backup.lastGoodAt ? ` · o último bom foi ${ago(backup.lastGoodAt)}` : " · ainda não houve um bom"}
                </div>
              )}
            </>
          ) : (
            "Nenhum backup ainda."
          )}
          <div className="muted">
            Um por noite, guardados por {BACKUP_RETENTION_DAYS} dias. O backup completo é a pasta ./backups mais a
            ./secrets: guarde as duas fora deste computador.
          </div>
        </dd>
        <dt>Chave do nó na tailnet</dt>
        <dd>{nodeKeyText(installation.nodeKey)}</dd>
      </dl>
    </main>
  );
}
