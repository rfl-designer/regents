/**
 * A máquina de quem instala, de mentira, para os testes do instalador e da atualização: os dublês
 * de `uname`, `curl`, `docker`, `launchctl`, `pmset`, `defaults`, `sleep`, mais as releases que o
 * `curl` "baixa" das releases públicas (empacotadas pelo `deploy/release.sh` de verdade). Não há
 * `gh`: o instalador não precisa de conta no GitHub.
 *
 * O estado mora em arquivos de `s.state`, que o teste muda antes de rodar o script:
 * `os` (Darwin/Linux), `docker-up` (o Docker responde), `docker-os` (o que `docker info` diz),
 * `tailnet.json` (o `tailscale status --json` do sidecar), `health` (do app), `latest` (a última
 * release), `releases/<tag>/` (os assets).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, type Sandbox, sandbox } from "./sandbox";

export const RELEASE_SCRIPT = join(REPO_ROOT, "deploy/release.sh");
/** As releases públicas, de onde o instalador baixa. */
export const RELEASES = "https://github.com/rfl-designer/shearim/releases";
/** A chamada que baixa o compose da release `tag` (sem tag: a última). */
export const download = (tag?: string) =>
  `curl -fsSL ${RELEASES}/${tag ? `download/${tag}` : "latest/download"}/shearim-compose.tar.gz`;

export type Tailnet = { magicDNS?: boolean; https?: boolean; tagged?: boolean; running?: boolean };

export function tailnetStatus({ magicDNS = true, https = true, tagged = true, running = true }: Tailnet = {}) {
  return `${JSON.stringify(
    {
      Version: "1.104.7",
      BackendState: running ? "Running" : "NeedsLogin",
      Self: {
        ID: "n1",
        HostName: "shearim",
        DNSName: "shearim.tail1234.ts.net.",
        ...(tagged ? { Tags: ["tag:shearim"] } : {}),
      },
      CertDomains: https ? ["shearim.tail1234.ts.net"] : null,
      CurrentTailnet: { Name: "time.example", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: magicDNS },
    },
    null,
    2,
  )}\n`;
}

export type World = Sandbox & {
  set(file: string, content?: string): void;
  /** Tira o dublê do PATH (o comando "não está instalado"); o `brew install` o devolve. */
  hide(name: string): void;
  /** Empacota a versão com o deploy/release.sh e a deixa para o `curl` baixar. */
  release(version: string): Promise<string>;
  installDir: string;
};

export async function world({ os = "Darwin" }: { os?: "Darwin" | "Linux" } = {}): Promise<World> {
  const s = sandbox();
  const set = (file: string, content = "") => writeFileSync(join(s.state, file), content);
  set("os", os);
  set("docker-up");
  set("tailnet.json", tailnetStatus());

  s.fake("uname", `case "$1" in -m) echo arm64 ;; *) cat "$STATE/os" ;; esac`);
  s.fake("sleep");
  s.fake(
    "docker",
    `up() {
  [ -f "$STATE/docker-up" ] || { echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2; exit 1; }
  if [ -f "$STATE/docker-needs-sudo" ] && [ -z "\${AS_ROOT:-}" ]; then echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; fi
}
case "$*" in
  "info --format {{.OperatingSystem}}") up; if [ -f "$STATE/docker-os" ]; then cat "$STATE/docker-os"; else echo "Docker Desktop"; fi ;;
  info*) up ;;
  "compose version"*) [ -f "$STATE/no-compose" ] && { echo "docker: 'compose' is not a docker command." >&2; exit 1; }; echo "Docker Compose version v2.40.3" ;;
  "login ghcr.io"*) up; cat >"$STATE/docker-login-stdin" ;;
  "compose exec -T tailscale"*) cat "$STATE/tailnet.json" ;;
  "compose ps app --format {{.Health}}") if [ -f "$STATE/health" ]; then cat "$STATE/health"; else echo healthy; fi ;;
  "compose config"*) [ -f "$STATE/config-fails" ] && { echo "required variable SHEARIM_VAPID_CONTACT is missing a value" >&2; exit 1; }; up ;;
  compose*) up ;;
  *) echo "docker falso: não sei responder a $*" >&2; exit 1 ;;
esac`,
  );
  s.fake(
    "launchctl",
    `case "$1" in
  print) [ -f "$STATE/launchagent" ] ;;
  bootstrap) touch "$STATE/launchagent" ;;
  bootout) rm -f "$STATE/launchagent" ;;
esac`,
  );
  s.fake("pmset", `if [ -f "$STATE/pmset" ]; then cat "$STATE/pmset"; else printf ' sleep 1\\n autorestart 0\\n'; fi`);
  s.fake(
    "brew",
    `here=$(dirname "$0")
case "$*" in
  "install colima docker docker-compose")
    for c in docker colima; do [ -f "$STATE/hidden-$c" ] && cp "$STATE/hidden-$c" "$here/$c"; done
    echo "Ubuntu 24.04.1 LTS" >"$STATE/docker-os" ;;
  "services start colima") touch "$STATE/docker-up" "$STATE/colima-service" ;;
  "services list") echo "Name   Status  User File"; [ -f "$STATE/colima-service" ] && echo "colima started quem-instala ~/Library/LaunchAgents/homebrew.mxcl.colima.plist"; true ;;
  --prefix) echo /opt/homebrew-falso ;;
  *) echo "brew falso: não sei responder a $*" >&2; exit 1 ;;
esac`,
  );
  s.fake("colima", `case "$1" in status) [ -f "$STATE/docker-up" ] ;; esac`);
  s.fake("open", `case "$*" in "-a OrbStack"|"-a Docker") touch "$STATE/docker-up" ;; *) exit 1 ;; esac`);
  // Linux
  s.fake("sudo", `AS_ROOT=1 exec "$@"`);
  // O script oficial do Docker e as releases públicas; o resto é 404 (o `-f` sai com 22).
  s.fake(
    "curl",
    `out="" url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -*) ;; *) url=$1 ;; esac; shift; done
case "$url" in
  https://get.docker.com) cp "$STATE/get-docker.sh" "$out" ;;
  ${RELEASES}/latest/download/*)
    if [ -f "$STATE/latest" ]; then tag=$(cat "$STATE/latest"); else tag=v1.2.3; fi
    cp "$STATE/releases/$tag/\${url##*/}" "$out" 2>/dev/null || { echo "curl: (22) 404" >&2; exit 22; } ;;
  ${RELEASES}/download/*)
    rest=\${url#${RELEASES}/download/}
    cp "$STATE/releases/\${rest%%/*}/\${rest#*/}" "$out" 2>/dev/null || { echo "curl: (22) 404" >&2; exit 22; } ;;
  *) echo "curl: (22) 404" >&2; exit 22 ;;
esac`,
  );
  s.fake(
    "systemctl",
    `case "$*" in
  "enable --now docker") [ -n "\${AS_ROOT:-}" ] && touch "$STATE/docker-up" "$STATE/docker-enabled" ;;
  "is-enabled docker") if [ -f "$STATE/docker-enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  "is-enabled sleep.target") echo static ;;
  *) exit 1 ;;
esac`,
  );
  // O que o script oficial do Docker "faz": põe o docker no PATH, sobe e habilita o serviço; o
  // socket é do grupo docker, então sem sudo não responde.
  set(
    "get-docker.sh",
    [
      `[ -n "\${AS_ROOT:-}" ] || { echo "precisa de root" >&2; exit 1; }`,
      `cp "${join(s.state, "hidden-docker")}" "${join(s.root, "bin", "docker")}"`,
      `touch "${join(s.state, "docker-needs-sudo")}" "${join(s.state, "docker-up")}" "${join(s.state, "docker-enabled")}"`,
    ].join("\n"),
  );
  s.fake("usermod", `[ -n "\${AS_ROOT:-}" ]`);
  s.fake(
    "apt-get",
    `[ -n "\${AS_ROOT:-}" ] || exit 100; case "$*" in *docker-compose-plugin*) rm -f "$STATE/no-compose" ;; esac`,
  );
  s.fake("defaults", `[ -f "$STATE/autologin" ] && echo quem-instala || exit 1`);

  const w: World = {
    ...s,
    set,
    hide(name) {
      renameSync(join(s.root, "bin", name), join(s.state, `hidden-${name}`));
    },
    installDir: join(s.home, "shearim"),
    async release(version) {
      const dir = join(s.state, "releases", `v${version}`);
      mkdirSync(dir, { recursive: true });
      const r = await s.run(RELEASE_SCRIPT, [version, dir]);
      if (r.code !== 0) throw new Error(r.output);
      return join(dir, "install.sh");
    },
  };
  return w;
}

/** As variáveis com que o setup não pergunta nada (o caminho do instalador sem terminal). */
export const SETUP_ENV = { TS_AUTHKEY: "tskey-auth-falsa", SHEARIM_CONTACT_EMAIL: "rafa@example.com" };

/** O `${SHEARIM_VERSION:-<versão>}` do compose da release: a tag que sobe sem nada no .env. */
export const composeTag = (version: string) => `\${SHEARIM_VERSION:-${version}}`;

export { REPO_ROOT };
